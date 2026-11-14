"""What an Outreach worker does about holds: ask for one, see their own, move a date (FR-HLD-05, 07, 21).

Outreach has no device on the event log (FR-VIS-03), so nothing here arrives by sync. Each call is
checked against what the worker may see, and the server writes the event itself, with the worker as
its actor. From there a request is a hold like any other: it reaches Staff devices by pull, the
sweep expires it, and its handle is forgotten when it ends.
"""

from __future__ import annotations

import sqlite3
from typing import Annotated, Any

from pydantic import Field, StringConstraints

from gear_tracker import derived, events, holds, views
from gear_tracker.errors import BadRequest, Conflict, Forbidden, NotFound
from gear_tracker.events import IsoDate, NonEmpty, Strict, now_ms
from gear_tracker.sync import Principal, _require_active
from gear_tracker.ulid import new_ulid

MAX_WAITING = 50
"""Requests one account may have unanswered at once. A request sets nothing aside, so this only keeps
one account from burying the Administrators' list."""

MAX_COUNT = 1000

KEPT_MS = 14 * 24 * 3_600_000
"""How long an ended request stays on the worker's list, to match the Holds screen Staff see."""


class Request(Strict):
    item_id: NonEmpty
    count: Annotated[int, Field(ge=1, le=MAX_COUNT)] = 1
    expires_on: IsoDate
    handle: Annotated[str, StringConstraints(max_length=200)]
    """A nickname or initials for the client, and nothing more (FR-HLD-18)."""


class Move(Strict):
    expires_on: IsoDate


def _require_outreach(who: Principal) -> None:
    _require_active(who)
    if who.role != "outreach":
        # Staff place a hold outright, in the app (FR-HLD-04).
        raise Forbidden("only an Outreach account asks for a hold this way")


def _after_today(day: str, today: str) -> None:
    if day <= today:
        raise BadRequest("a hold runs until a day after today (FR-HLD-03)")


def _brief(state: dict[str, Any], hold: dict[str, Any], handles: dict[str, str], today: str) -> dict[str, Any]:
    """One of the worker's own holds as they see it (FR-HLD-07). The item's name and no more of it."""
    status = views.hold_state(hold, today)
    return {
        "id": hold["id"],
        "item": views.name_of(state, views.resolve_item(state, str(hold.get("item_id")))),
        "count": hold.get("count") or 1,
        "expires_on": hold.get("expires_on"),
        # "approved" is the word the worker is given for a hold in force.
        "state": "approved" if status == "live" else status,
        "for": handles.get(hold["id"]),
        "requested_at": hold.get("added_at"),
    }


def my_holds(conn: sqlite3.Connection, who: Principal, now: int | None = None) -> list[dict[str, Any]]:
    """The worker's own requests and holds, and no one else's (FR-VIS-10): everything unanswered or in
    force, and what ended in the last two weeks. Newest first."""
    _require_outreach(who)
    now = now_ms() if now is None else now
    state = derived.snapshot(conn)
    today = views.today(now)
    handles = holds.handles(conn)
    mine = [
        h
        for h in views.holds(state)
        if h.get("created_by") == who.user_id
        and (views.hold_state(h, today) in ("live", "waiting") or (h.get("ended_at") or now) >= now - KEPT_MS)
    ]
    mine.sort(key=lambda h: h["id"], reverse=True)
    return [_brief(state, h, handles, today) for h in mine]


def request_hold(conn: sqlite3.Connection, who: Principal, body: Request, now: int | None = None) -> list[str]:
    """Ask for goods to be held for a client (FR-HLD-05). Nothing is set aside until an Administrator
    approves. Only an item the worker is shown, and no more than are free (FR-VIS-02, FR-VIS-11).

    A stack is asked for by count, as one request. Things tracked one by one are asked for one request
    each, because each is held, approved and handed out on its own; the server picks which.
    """
    _require_outreach(who)
    now = now_ms() if now is None else now
    today = views.today(now)
    handle = holds.tidy_handle(body.handle)
    if handle is None:
        raise BadRequest("say who the hold is for")
    _after_today(body.expires_on, today)
    conn.execute("BEGIN IMMEDIATE")
    try:
        state = derived.snapshot(conn)
        shown = {row["id"]: row for row in views.outreach_items(state, today)}
        row = shown.get(body.item_id)
        if row is None:
            # Unknown, not marked for Outreach, or none free: all one answer, so nothing is learned.
            raise NotFound("that item is not available")
        if body.count > row["available"]:
            raise Conflict(f"only {row['available']} available")
        waiting = sum(
            1 for h in views.holds(state) if h.get("created_by") == who.user_id and views.is_waiting(h, today)
        )
        it = views.item(state, body.item_id) or {}
        pool = views.is_pool(it)
        if it.get("generic") and not pool:
            free = [u for u in views.units_of(state, it["id"]) if views.available(state, u, today)]
            targets: list[tuple[str, int | None]] = [(u["id"], None) for u in free[: body.count]]
        elif pool:
            targets = [(it["id"], body.count)]
        else:
            targets = [(it["id"], None)]
        if waiting + len(targets) > MAX_WAITING:
            raise Conflict("too many requests are waiting for an answer; wait for some to be answered")
        made = []
        for item_id, count in targets:
            hold_id = new_ulid(now)
            payload: dict[str, Any] = {"item_id": item_id, "expires_on": body.expires_on, "requested": True}
            if count is not None:
                payload["count"] = count
            event = events.append_server(conn, who.user_id, "hold", hold_id, "created", payload, now)
            holds.set_handle(conn, hold_id, handle, who.user_id, now)
            made.append((hold_id, event))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    for _hold_id, event in made:
        holds.after(conn, event)
    return [hold_id for hold_id, _event in made]


def move_expiry(conn: sqlite3.Connection, who: Principal, hold_id: str, body: Move, now: int | None = None) -> None:
    """Move the end date of a request or hold the worker made, with no new approval (FR-HLD-21). The
    people named on it and every Administrator are told (FR-HLD-22, FR-HLD-27)."""
    _require_outreach(who)
    now = now_ms() if now is None else now
    today = views.today(now)
    hold = derived.get_entity(conn, "hold", hold_id)
    if hold is None or hold.get("created_by") != who.user_id:
        # Someone else's hold does not exist, as far as this worker is told (FR-VIS-10).
        raise NotFound("no such hold")
    if not (views.is_live(hold, today) or views.is_waiting(hold, today)):
        raise Conflict("this hold has ended")
    _after_today(body.expires_on, today)
    if body.expires_on == hold.get("expires_on"):
        return
    change = {"field": "expires_on", "value": body.expires_on, "old": hold.get("expires_on")}
    event = events.append_server(conn, who.user_id, "hold", hold_id, "field_changed", change, now)
    holds.after(conn, event)
