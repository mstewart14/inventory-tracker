"""Holds: goods set aside for a client until a date (FR-HLD-01, FR-HLD-03).

A hold is an entity on the event log: the item, a count for a pool, the day it
runs out, who placed it, and how it ended. Who it is for is not on the log.
The handle lives in `hold_handles`, so it can be deleted when the hold ends
(FR-HLD-17), which nothing on an append-only log can be.

A hold stops counting the day after `expires_on`, with no event needed, so a
device that is offline puts the goods back in stock by itself (FR-HLD-11). The
server then records the ending, tells the people named on the hold, and deletes
the handle (`expire_due`).
"""

from __future__ import annotations

import logging
import sqlite3
import threading
from collections.abc import Callable
from typing import Any

from gear_tracker import derived, events, notify, views
from gear_tracker.db import connect
from gear_tracker.events import now_ms

logger = logging.getLogger(__name__)

SYSTEM_ACTOR = "system"
"""actor_id on an expiry. Not a user: nobody ended the hold, the date did (FR-HLD-11)."""

SWEEP_INTERVAL_S = 600.0

MAX_HANDLE = 80
"""A handle is a nickname or initials, not a description of a person (FR-HLD-18)."""


def tidy_handle(handle: Any) -> str | None:
    """A handle as stored: one line, single spaces, at most MAX_HANDLE long. None when there is nothing in it."""
    if not isinstance(handle, str):
        return None
    tidy = " ".join(handle.split())[:MAX_HANDLE].strip()
    return tidy or None


def handles(conn: sqlite3.Connection) -> dict[str, str]:
    """Every handle held right now, by hold. Sent whole with each sync, so a deletion reaches every device."""
    return {r["hold_id"]: r["handle"] for r in conn.execute("SELECT hold_id, handle FROM hold_handles")}


def set_handle(conn: sqlite3.Connection, hold_id: str, handle: Any, user_id: str, now: int) -> bool:
    """Record who a live hold is for. Nothing is kept for a hold that is unknown or has ended (FR-HLD-17)."""
    tidy = tidy_handle(handle)
    hold = derived.get_entity(conn, "hold", hold_id)
    today = views.today(now)
    if tidy is None or hold is None or not (views.is_live(hold, today) or views.is_waiting(hold, today)):
        return False
    conn.execute(
        "INSERT INTO hold_handles (hold_id, handle, set_by, set_at) VALUES (?, ?, ?, ?)"
        " ON CONFLICT (hold_id) DO UPDATE SET handle = excluded.handle, set_by = excluded.set_by,"
        " set_at = excluded.set_at",
        (hold_id, tidy, user_id, now),
    )
    return True


def drop_handle(conn: sqlite3.Connection, hold_id: str) -> None:
    conn.execute("DELETE FROM hold_handles WHERE hold_id = ?", (hold_id,))


def after(conn: sqlite3.Connection, event: events.Event) -> None:
    """What follows a hold's event once it is stored. A request tells every Administrator (FR-HLD-39),
    and its approval tells whoever asked (FR-HLD-40). An ending, by a device or by its date, tells the
    people named on the hold and then forgets who it was for (FR-HLD-12, FR-HLD-28, FR-HLD-17). A moved
    expiry tells them too (FR-HLD-27)."""
    if event.entity_type != "hold":
        return
    if event.type == "created" and event.payload.get("requested"):
        notify.hold_requested(conn, event.entity_id)
    elif event.type == "hold_approved":
        hold = derived.get_entity(conn, "hold", event.entity_id) or {}
        # Only the approval that stood is news.
        if hold.get("approved_at") == event.effective_at and hold.get("approved_by") == event.actor_id:
            notify.hold_approved(conn, event.entity_id, event.actor_id)
    elif event.type == "hold_ended":
        hold = derived.get_entity(conn, "hold", event.entity_id) or {}
        # Only the ending that stood is news; a second one changed nothing.
        if hold.get("ended_at") == event.effective_at and hold.get("ended_by") == event.actor_id:
            notify.hold_ended(conn, event.entity_id, str(event.payload.get("reason")), event.actor_id)
        drop_handle(conn, event.entity_id)
    elif event.type == "field_changed" and event.payload.get("field") == "expires_on":
        notify.hold_moved(conn, event.entity_id, event.payload.get("old"), event.payload.get("value"), event.actor_id)


def expire_due(conn: sqlite3.Connection, now: int | None = None) -> list[str]:
    """End every hold whose day has passed (FR-HLD-11). Returns the holds it ended."""
    now = now_ms() if now is None else now
    today = views.today(now)
    due = [
        row["entity_id"]
        for row in conn.execute(
            "SELECT entity_id FROM entities WHERE entity_type = 'hold'"
            " AND coalesce(json_extract(state, '$.state'), 'live') IN ('live', 'waiting')"
            " AND json_extract(state, '$.expires_on') < ?",
            (today,),
        )
    ]
    for hold_id in due:
        event = events.append_server(conn, SYSTEM_ACTOR, "hold", hold_id, "hold_ended", {"reason": "expired"}, now)
        after(conn, event)
    # A handle whose hold never arrived, or ended some other way, is not kept either.
    conn.execute(
        "DELETE FROM hold_handles WHERE hold_id NOT IN (SELECT entity_id FROM entities WHERE entity_type = 'hold'"
        " AND coalesce(json_extract(state, '$.state'), 'live') IN ('live', 'waiting')) AND set_at < ?",
        (now - 24 * 3_600_000,),
    )
    return due


def start_background_sweep(db_path: Any, interval_s: float = SWEEP_INTERVAL_S) -> Callable[[], None]:
    """Expire holds for as long as the server runs, on its own thread and connection, as calendars refresh."""
    stop = threading.Event()

    def loop() -> None:
        conn = connect(db_path)
        try:
            while True:
                try:
                    expire_due(conn)
                except Exception:
                    logger.exception("hold expiry failed")
                if stop.wait(interval_s):
                    return
        finally:
            conn.close()

    thread = threading.Thread(target=loop, name="hold-expiry", daemon=True)
    thread.start()

    def stop_and_join() -> None:
        stop.set()
        thread.join(timeout=5)

    return stop_and_join
