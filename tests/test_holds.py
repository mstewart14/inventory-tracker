"""Holds: goods set aside for a client until a day (FR-HLD), through the assistant's tools and the push
a device uses. The handle is kept off the log and deleted when the hold ends (FR-HLD-17)."""

from __future__ import annotations

import json

import pytest

from gear_tracker import assistant, derived, events, holds, sync, views
from gear_tracker.db import open_db
from gear_tracker.errors import BadRequest, Conflict
from gear_tracker.events import now_ms
from gear_tracker.sync import Principal
from gear_tracker.ulid import new_ulid

ALICE = "01ARZ3NDEKTSV4RRFFQ69G5FAA"
DEVICE = "assistant-1"
DAY_MS = 24 * 3_600_000


def day(offset: int) -> str:
    return views.today(now_ms() + offset * DAY_MS)


@pytest.fixture
def who() -> Principal:
    return Principal(user_id=ALICE, device_id=DEVICE)


@pytest.fixture
def stock(db_path, who):
    """A coat and a stack of twenty pairs of socks."""
    with open_db(db_path) as conn:
        events.append_server(conn, ALICE, "user", ALICE, "created", {"name": "Alice", "role": "user", "active": True})
        coat, socks = new_ulid(), new_ulid()
        events.append_server(conn, ALICE, "item", coat, "created", {"name": "Winter coat"})
        pool = {"name": "Socks", "generic": True, "pool": True, "quantity": 20}
        events.append_server(conn, ALICE, "item", socks, "created", pool)
    with assistant.acting_as(who, db_path):
        yield {"coat": coat, "socks": socks}


def handles(db_path) -> dict[str, str]:
    with open_db(db_path) as conn:
        return holds.handles(conn)


def logged(db_path) -> str:
    with open_db(db_path) as conn:
        return json.dumps([dict(row) for row in conn.execute("SELECT * FROM events")])


def test_a_hold_sets_a_count_aside_for_a_handle_until_a_day(db_path, stock):
    made = assistant.place_hold(stock["socks"], "  J  D ", day(7), count=5)
    assert made["for"] == "J D" and made["count"] == 5 and made["state"] == "live"
    assert made["expires_on"] == day(7) and made["placed_by"] == "Alice"
    assert assistant.list_holds()["holds"] == [made]
    assert assistant.list_holds(item_id=stock["coat"])["holds"] == []


def test_who_a_hold_is_for_is_never_on_the_log(db_path, stock):
    assistant.place_hold(stock["coat"], "Mouse", day(3))
    assert "Mouse" not in logged(db_path)
    assert list(handles(db_path).values()) == ["Mouse"]


def test_a_hold_needs_a_handle_and_a_day_after_today(stock):
    with pytest.raises(BadRequest, match="who the hold is for"):
        assistant.place_hold(stock["coat"], "   ", day(3))
    with pytest.raises(BadRequest, match="a day after today"):
        assistant.place_hold(stock["coat"], "JD", day(0))
    with pytest.raises(BadRequest, match="say how many"):
        assistant.place_hold(stock["socks"], "JD", day(3))
    with pytest.raises(BadRequest, match="count is only for a pool"):
        assistant.place_hold(stock["coat"], "JD", day(3), count=1)


def test_goods_on_hold_cannot_be_held_or_handed_out_to_anyone_else(stock):
    assistant.place_hold(stock["socks"], "JD", day(3), count=15)
    with pytest.raises(Conflict, match="only 5 free to hold"):
        assistant.place_hold(stock["socks"], "Mouse", day(3), count=6)
    with pytest.raises(Conflict, match="only 5 not on hold"):
        assistant.hand_out(stock["socks"], count=6)
    assistant.hand_out(stock["socks"], count=5)

    assistant.place_hold(stock["coat"], "JD", day(3))
    with pytest.raises(Conflict, match="not free to hold"):
        assistant.place_hold(stock["coat"], "Mouse", day(3))
    with pytest.raises(Conflict, match="this is on hold"):
        assistant.hand_out(stock["coat"])


def test_handing_out_a_hold_ends_it_removes_the_goods_and_forgets_the_handle(db_path, stock):
    hold = assistant.place_hold(stock["socks"], "JD", day(3), count=5)
    assert assistant.hand_out_hold(hold["hold_id"])["state"] == "handed_out"
    got = assistant.get_item(stock["socks"])
    assert got["in"] == 15 and got["handed_out"] == 5
    assert handles(db_path) == {}
    ended = assistant.list_holds(include_ended=True)["holds"][0]
    assert ended["state"] == "handed_out" and "for" not in ended
    with pytest.raises(Conflict, match="this hold has ended"):
        assistant.hand_out_hold(hold["hold_id"])

    coat = assistant.place_hold(stock["coat"], "Mouse", day(3))
    assistant.hand_out_hold(coat["hold_id"])
    assert assistant.get_item(stock["coat"])["handed_out"] is True


def test_putting_a_hold_back_frees_the_goods_and_forgets_the_handle(db_path, stock):
    hold = assistant.place_hold(stock["socks"], "JD", day(3), count=20)
    assert assistant.put_back_hold(hold["hold_id"]) == {"hold_id": hold["hold_id"], "state": "put_back"}
    assert handles(db_path) == {}
    assert assistant.get_item(stock["socks"])["in"] == 20
    assistant.hand_out(stock["socks"], count=20)


def test_a_hold_can_be_moved_to_a_new_day_after_today(stock):
    hold = assistant.place_hold(stock["coat"], "JD", day(3))
    assert assistant.extend_hold(hold["hold_id"], day(10))["expires_on"] == day(10)
    with pytest.raises(BadRequest, match="a day after today"):
        assistant.extend_hold(hold["hold_id"], day(-1))


def test_a_hold_past_its_day_frees_its_goods_then_the_sweep_ends_it(db_path, stock):
    hold = assistant.place_hold(stock["socks"], "JD", day(1), count=20)
    later = now_ms() + 2 * DAY_MS
    with open_db(db_path) as conn:
        state = derived.snapshot(conn)
        it = views.item(state, stock["socks"])
        assert it is not None
        # Free the day after, before anything records it (FR-HLD-11).
        assert views.available(state, it, views.today(later)) == 20
        assert holds.expire_due(conn, now=now_ms()) == []
        assert holds.expire_due(conn, now=later) == [hold["hold_id"]]
        ended = derived.get_entity(conn, "hold", hold["hold_id"])
        assert ended is not None
        assert ended["state"] == "expired" and ended["ended_by"] == holds.SYSTEM_ACTOR
        assert holds.handles(conn) == {}
        assert holds.expire_due(conn, now=later) == []


def _event(who: Principal, seq: int, **fields):
    return {
        "id": new_ulid(),
        "actor_id": who.user_id,
        "device_id": who.device_id,
        "device_seq": seq,
        "occurred_at": now_ms(),
        "clock_offset": 0,
        **fields,
    }


def _push(db_path, who, batch, hold_handles=()):
    with open_db(db_path) as conn:
        body = {
            "device_id": who.device_id,
            "client_time": now_ms(),
            "events": batch,
            "hold_handles": list(hold_handles),
        }
        return sync.push(conn, who, body)


def test_a_device_sends_the_handle_beside_its_events_and_every_sync_returns_it(db_path, stock):
    phone = Principal(user_id=ALICE, device_id="phone-a")
    hold_id = new_ulid()
    made = _event(
        phone,
        1,
        entity_type="hold",
        entity_id=hold_id,
        type="created",
        payload={"item_id": stock["coat"], "expires_on": day(3)},
    )
    result = _push(db_path, phone, [made], [{"hold_id": hold_id, "handle": "JD"}, {"hold_id": "nope", "handle": "X"}])
    assert result["rejected"] == []
    # Both are answered, so the device stops sending them; only the real hold's is kept.
    assert result["hold_handles_taken"] == [hold_id, "nope"]
    assert handles(db_path) == {hold_id: "JD"}
    with open_db(db_path) as conn:
        assert sync.bootstrap(conn, phone)["hold_handles"] == {hold_id: "JD"}
        assert sync.pull(conn, phone, 0)["hold_handles"] == {hold_id: "JD"}

    ended = _event(phone, 2, entity_type="hold", entity_id=hold_id, type="hold_ended", payload={"reason": "put_back"})
    assert _push(db_path, phone, [ended])["rejected"] == []
    assert handles(db_path) == {}


def test_the_log_refuses_a_handle_an_expiry_from_a_device_and_any_other_change(db_path, stock):
    phone = Principal(user_id=ALICE, device_id="phone-a")
    hold_id = new_ulid()

    def hold(seq, type, payload):
        return _event(phone, seq, entity_type="hold", entity_id=hold_id, type=type, payload=payload)

    def reasons(*batch):
        return [r["reason"] for r in _push(db_path, phone, list(batch))["rejected"]]

    named = hold(1, "created", {"item_id": stock["coat"], "expires_on": day(3), "handle": "JD"})
    assert reasons(named) == ["who a hold is for is not recorded on the log (FR-HLD-17)"]
    counted = hold(2, "created", {"item_id": stock["coat"], "expires_on": day(3), "count": 2})
    assert reasons(counted) == ["count is only for a pool (FR-HLD-01)"]
    assert reasons(hold(3, "created", {"item_id": stock["coat"], "expires_on": day(3)})) == []
    assert reasons(hold(4, "hold_ended", {"reason": "expired"})) == [
        "a hold expires by its date, not by a device (FR-HLD-11)"
    ]
    change = {"field": "state", "value": "live", "old": None}
    assert reasons(hold(5, "field_changed", change)) == ["only a hold's expiry can be changed (FR-HLD-09)"]
    bad_date = {"field": "expires_on", "value": "soon", "old": day(3)}
    assert reasons(hold(6, "field_changed", bad_date)) == ["expires_on must be a date, YYYY-MM-DD"]
