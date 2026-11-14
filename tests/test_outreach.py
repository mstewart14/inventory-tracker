"""The Outreach role (FR-USR-36 to 42, FR-VIS-02, 03, 09 to 12): what a worker from another organization is
shown, and everything they are refused."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from gear_tracker import accounts, assistant, derived, events, holds, notify, sync, views
from gear_tracker.app import create_app
from gear_tracker.db import open_db
from gear_tracker.errors import Forbidden
from gear_tracker.events import now_ms
from gear_tracker.sync import Principal
from gear_tracker.ulid import new_ulid
from tests.test_app import authenticate

ALICE = "01ARZ3NDEKTSV4RRFFQ69G5FAA"
OMAR = "01ARZ3NDEKTSV4RRFFQ69G5FAB"
JPEG = b"\xff\xd8\xff\xe0 not really a jpeg"
DAY_MS = 24 * 3_600_000

AS_OMAR = {"X-Test-User": OMAR, "X-Test-Role": "outreach", "X-Test-Device": "omar-phone"}
AS_ALICE = {"X-Test-User": ALICE}


def make(conn, payload: dict) -> str:
    item_id = new_ulid()
    events.append_server(conn, ALICE, "item", item_id, "created", payload)
    return item_id


def day(offset: int) -> str:
    return views.today(now_ms() + offset * DAY_MS)


@pytest.fixture
def stock(db_path):
    """A coat for the public, a tent for Outreach, socks for Outreach, and a radio for Staff alone."""
    with open_db(db_path) as conn:
        events.append_server(conn, ALICE, "user", ALICE, "created", {"name": "Alice", "role": "user", "active": True})
        events.append_server(conn, ALICE, "user", OMAR, "created", {"name": "Omar", "role": "outreach", "active": True})
        group = {"name": "The Society", "contact": "Drop in at the front desk"}
        events.append_server(conn, ALICE, "setting", "group", "created", group)
        shelf = new_ulid()
        events.append_server(conn, ALICE, "location", shelf, "created", {"name": "Back room"})
        made = {
            "coat": make(
                conn,
                {
                    "name": "Winter coat",
                    "description": "Warm, size L",
                    "visibility": "public",
                    "source": "Church drive",
                    "home_location_id": shelf,
                    "sub_location": "shelf 2",
                },
            ),
            "socks": make(
                conn,
                {
                    "name": "Socks",
                    "generic": True,
                    "pool": True,
                    "quantity": 20,
                    "visibility": "outreach",
                    "home_location_id": shelf,
                },
            ),
            "tent": make(conn, {"name": "Tent", "visibility": "outreach"}),
            "radio": make(conn, {"name": "Staff radio", "home_location_id": shelf}),
        }
    with assistant.acting_as(Principal(user_id=ALICE, device_id="assistant-1"), db_path):
        yield made


@pytest.fixture
def client(db_path, stock):
    return TestClient(create_app(db_path, authenticate))


def shown(client) -> dict[str, dict]:
    got = client.get("/outreach/items", headers=AS_OMAR)
    assert got.status_code == 200
    return {row["name"]: row for row in got.json()["items"]}


def test_outreach_sees_what_is_marked_for_them_or_for_the_public(client, stock):
    rows = shown(client)
    assert sorted(rows) == ["Socks", "Tent", "Winter coat"]
    assert rows["Winter coat"] == {
        "id": stock["coat"],
        "name": "Winter coat",
        "description": "Warm, size L",
        "categories": [],
        "photos": [],
        "locations": ["Back room"],
        "available": 1,
    }
    assert rows["Socks"]["available"] == 20 and rows["Socks"]["locations"] == ["Back room"]
    assert rows["Tent"]["locations"] == []


def test_outreach_is_told_nothing_of_sources_people_or_staff_only_items(client):
    got = client.get("/outreach/items", headers=AS_OMAR)
    for hidden in ("Church drive", "Alice", ALICE, "Staff radio", "shelf 2"):
        assert hidden not in got.text


def test_goods_on_a_hold_are_left_out_of_the_count_and_nothing_says_why(client, stock):
    assistant.place_hold(stock["socks"], "Mouse", day(3), count=8)
    got = client.get("/outreach/items", headers=AS_OMAR)
    assert shown(client)["Socks"]["available"] == 12
    assert "Mouse" not in got.text and "hold" not in got.text


def test_an_item_with_none_free_is_not_shown(client, stock):
    assistant.place_hold(stock["coat"], "Mouse", day(3))
    assistant.hand_out(stock["tent"])
    assert sorted(shown(client)) == ["Socks"]


def test_a_generic_is_one_line_counting_its_free_units(client, stock):
    tents = assistant.create_item("Dome tent", generic=True, units=3, visibility="outreach")
    assistant.hand_out(tents["unit_ids"][0])
    assert shown(client)["Dome tent"]["available"] == 2


def test_staff_can_read_what_outreach_sees(client):
    got = client.get("/outreach/items", headers=AS_ALICE)
    assert [row["name"] for row in got.json()["items"]] == ["Socks", "Tent", "Winter coat"]
    assert assistant.outreach_view()["count"] == 3


def test_a_signed_out_caller_and_a_deactivated_one_see_nothing(client):
    assert client.get("/outreach/items").status_code == 401
    assert client.get("/outreach/items", headers={**AS_OMAR, "X-Test-Active": "no"}).status_code == 403


def test_outreach_gets_the_photo_of_what_they_are_shown_and_no_other(client, stock):
    jpeg = {**AS_ALICE, "Content-Type": "image/jpeg"}
    seen, hidden = new_ulid(), new_ulid()
    assert client.put(f"/photos/{seen}?entity_type=item&entity_id={stock['tent']}", content=JPEG, headers=jpeg)
    assert client.put(f"/photos/{hidden}?entity_type=item&entity_id={stock['radio']}", content=JPEG, headers=jpeg)

    assert shown(client)["Tent"]["photos"] == [seen]
    got = client.get(f"/outreach/photos/{seen}", headers=AS_OMAR)
    assert got.status_code == 200 and got.content == JPEG
    assert client.get(f"/outreach/photos/{hidden}", headers=AS_OMAR).status_code == 404
    assert client.get(f"/outreach/photos/{seen}").status_code == 401
    # The Staff route for the same photo is closed to them.
    assert client.get(f"/photos/{seen}", headers=AS_OMAR).status_code == 403


OPEN_TO_OUTREACH = {
    ("POST", "/auth/sign-out"),
    ("GET", "/users/{user_id}/devices"),
    ("POST", "/users/{user_id}/devices/{device_id}/revoke"),
    ("POST", "/me/deactivate"),
    ("GET", "/outreach/items"),
    ("GET", "/outreach/photos/{photo_id}"),
    ("GET", "/outreach/holds"),
    ("POST", "/outreach/holds"),
    ("POST", "/outreach/holds/{hold_id}/expiry"),
    ("POST", "/outreach/holds/{hold_id}/collection"),
}
"""Every route an Outreach account may call. Adding to this list is a decision, not a fix for a failing test."""

NO_SIGN_IN = ("/public/", "/auth/sign-in", "/auth/redeem", "/join", "/privacy", "/health", "/mcp")


def test_every_other_signed_in_route_refuses_outreach(client):
    """FR-USR-39, FR-VIS-03. The list of what is open is short and written down; all else is 403."""
    checked = 0
    for route in client.app.routes:
        methods = getattr(route, "methods", None) or set()
        path = getattr(route, "path", "")
        if path.startswith(NO_SIGN_IN) or path.startswith(("/docs", "/redoc", "/openapi")):
            continue
        for method in methods - {"HEAD", "OPTIONS"}:
            if (method, path) in OPEN_TO_OUTREACH:
                continue
            url = path.replace("{path:path}", "x").replace("{", "").replace("}", "")
            got = client.request(method, url, headers=AS_OMAR, json={})
            assert got.status_code == 403, f"{method} {path} answered {got.status_code}"
            assert got.json()["message"] == "Outreach accounts cannot do this"
            checked += 1
    assert checked >= 30


def test_sync_refuses_outreach_whoever_calls_it(db, stock):
    omar = Principal(user_id=OMAR, device_id="omar-phone", role="outreach")
    with pytest.raises(Forbidden):
        sync.bootstrap(db, omar)
    with pytest.raises(Forbidden):
        sync.pull(db, omar, 0)
    with pytest.raises(Forbidden):
        sync.push(db, omar, {"device_id": "omar-phone", "client_time": now_ms(), "events": []})


def test_outreach_cannot_connect_an_assistant(db, stock):
    with pytest.raises(Forbidden, match="assistant"):
        accounts.connect_assistant(db, Principal(user_id=OMAR, device_id="omar-phone", role="outreach"))


def test_outreach_is_not_mailed_news_they_subscribed_to_as_staff(db, stock):
    db.execute("INSERT INTO accounts (user_id, email, created_at) VALUES (?, 'omar@example.org', 0)", (OMAR,))
    db.execute("INSERT INTO accounts (user_id, email, created_at) VALUES (?, 'alice@example.org', 0)", (ALICE,))
    for user in (OMAR, ALICE):
        db.execute("INSERT INTO notification_prefs (user_id, category) VALUES (?, 'found')", (user,))
    assert notify._subscribers(db, "found") == ["alice@example.org"]


# --- accounts ------------------------------------------------------------------------------


@pytest.fixture
def admin(db):
    user_id = accounts.create_admin(db, "Alex", "alex@example.org", "correct horse")
    return Principal(user_id=user_id, device_id="desk", role="admin")


def test_an_invite_names_the_role_its_account_gets(db, admin):
    user_id, _token = accounts.invite(
        db, admin, accounts.Invite(name="Omar", email="omar@example.org", role="outreach")
    )
    assert accounts.get_user(db, user_id)["role"] == "outreach"


def test_a_join_link_makes_the_role_it_was_made_for(db, admin):
    made = accounts.create_join_link(db, admin, accounts.CreateJoinLink(role="outreach", label="Partner agency"))
    assert accounts.list_join_links(db, admin)[0]["role"] == "outreach"
    body = accounts.Join(
        link=made["token"], name="Omar", email="omar@example.org", password="correct horse 2", device_id="p1"
    )
    session = accounts.join(db, body)
    assert session.user["role"] == "outreach"


def test_a_join_link_makes_staff_unless_told_and_never_an_administrator(db, admin):
    assert accounts.create_join_link(db, admin, accounts.CreateJoinLink())["role"] == "user"
    with pytest.raises(ValueError):
        accounts.CreateJoinLink.model_validate({"role": "admin"})


def sessions(db, user_id: str) -> int:
    return db.execute("SELECT count(*) FROM sessions WHERE user_id = ? AND revoked_at IS NULL", (user_id,)).fetchone()[
        0
    ]


def test_a_move_into_or_out_of_outreach_signs_the_person_out(db, admin):
    user_id, token = accounts.invite(db, admin, accounts.Invite(name="Sam", email="sam@example.org"))
    accounts.redeem(db, accounts.Redeem(token=token, password="correct horse 2", device_id="p1"))
    assert sessions(db, user_id) == 1

    accounts.set_role(db, admin, user_id, "admin")
    assert sessions(db, user_id) == 1  # Staff to Administrator: the device already holds everything.

    accounts.set_role(db, admin, user_id, "outreach")
    assert sessions(db, user_id) == 0
    assert accounts.get_user(db, user_id)["role"] == "outreach"


# --- requests (FR-HLD-05 to 07, 21, 22) ------------------------------------------------------

ADMIN = "01ARZ3NDEKTSV4RRFFQ69G5FAC"
AS_ADMIN = Principal(user_id=ADMIN, device_id="assistant-9", role="admin")


def ask(client, item_id: str, count: int = 1, handle: str = "Mouse", until: int = 5, headers=AS_OMAR):
    body = {"item_id": item_id, "count": count, "expires_on": day(until), "handle": handle}
    return client.post("/outreach/holds", json=body, headers=headers)


def mine(client) -> list[dict]:
    return client.get("/outreach/holds", headers=AS_OMAR).json()["holds"]


def as_admin(db_path):
    return assistant.acting_as(AS_ADMIN, db_path)


def test_a_request_sets_nothing_aside_until_it_is_approved(client, stock, db_path):
    got = ask(client, stock["socks"], count=8)
    assert got.status_code == 200
    (hold_id,) = got.json()["hold_ids"]
    assert mine(client) == [
        {
            "id": hold_id,
            "item": "Socks",
            "count": 8,
            "expires_on": day(5),
            "state": "waiting",
            "for": "Mouse",
            "requested_at": mine(client)[0]["requested_at"],
            "collection": None,
            "delivery_at": None,
            "drop_off": None,
            "delivery_by": None,
        }
    ]
    # Still all twenty to ask for, by anyone (FR-HLD-05).
    assert shown(client)["Socks"]["available"] == 20
    assert assistant.list_holds()["holds"][0]["state"] == "waiting"

    with as_admin(db_path):
        assert assistant.approve_hold(hold_id)["state"] == "live"
    assert mine(client)[0]["state"] == "approved"
    assert shown(client)["Socks"]["available"] == 12


def test_a_declined_request_says_so_and_forgets_who_it_was_for(client, stock, db_path, db):
    (hold_id,) = ask(client, stock["coat"]).json()["hold_ids"]
    assert holds.handles(db) == {hold_id: "Mouse"}
    with as_admin(db_path):
        assert assistant.decline_hold(hold_id) == {"hold_id": hold_id, "state": "declined"}
    assert mine(client)[0]["state"] == "declined" and mine(client)[0]["for"] is None
    assert holds.handles(db) == {}
    assert shown(client)["Winter coat"]["available"] == 1
    with as_admin(db_path), pytest.raises(Exception, match="not a request waiting"):
        assistant.approve_hold(hold_id)


def test_only_an_administrator_answers_a_request(client, stock):
    (hold_id,) = ask(client, stock["coat"]).json()["hold_ids"]
    # Alice is Staff: the tool refuses her, and so does a push from her device.
    with pytest.raises(Exception, match="Administrators only"):
        assistant.approve_hold(hold_id)
    with pytest.raises(Exception, match="Administrators only"):
        assistant.decline_hold(hold_id)
    for kind, payload in (("hold_approved", {}), ("hold_ended", {"reason": "declined"})):
        event = {
            "id": new_ulid(),
            "entity_type": "hold",
            "entity_id": hold_id,
            "type": kind,
            "actor_id": ALICE,
            "device_id": "phone",
            "device_seq": 1,
            "occurred_at": now_ms(),
            "clock_offset": 0,
            "payload": payload,
        }
        body = {"device_id": "phone", "client_time": now_ms(), "events": [event]}
        got = client.post("/sync/push", json=body, headers=AS_ALICE).json()
        assert got["rejected"][0]["reason"] == "only an Administrator approves or declines a request (FR-HLD-06)"
    assert mine(client)[0]["state"] == "waiting"


def test_a_device_cannot_write_a_request(client, stock):
    event = {
        "id": new_ulid(),
        "entity_type": "hold",
        "entity_id": new_ulid(),
        "type": "created",
        "actor_id": ALICE,
        "device_id": "phone",
        "device_seq": 1,
        "occurred_at": now_ms(),
        "clock_offset": 0,
        "payload": {"item_id": stock["coat"], "expires_on": day(3), "requested": True},
    }
    body = {"device_id": "phone", "client_time": now_ms(), "events": [event]}
    got = client.post("/sync/push", json=body, headers=AS_ALICE).json()
    assert "Outreach account" in got["rejected"][0]["reason"]


def test_approval_is_refused_when_the_goods_have_gone(client, stock, db_path):
    (hold_id,) = ask(client, stock["socks"], count=15).json()["hold_ids"]
    assistant.place_hold(stock["socks"], "Bird", day(3), count=10)
    with as_admin(db_path), pytest.raises(Exception, match="only 10 free"):
        assistant.approve_hold(hold_id)


def test_only_what_outreach_is_shown_can_be_asked_for_and_no_more_than_is_free(client, stock):
    assert ask(client, stock["radio"]).status_code == 404
    assert ask(client, new_ulid()).status_code == 404
    assert ask(client, stock["socks"], count=21).json()["message"] == "only 20 available"
    assert ask(client, stock["coat"], count=2).status_code == 409
    assert ask(client, stock["coat"], until=0).status_code == 400
    assert ask(client, stock["coat"], handle="   ").status_code == 400
    assert mine(client) == []


def test_things_tracked_one_by_one_are_asked_for_one_request_each(client, stock):
    tents = assistant.create_item("Dome tent", generic=True, units=3, visibility="outreach")
    got = ask(client, tents["item_id"], count=2).json()
    assert len(got["hold_ids"]) == 2
    assert sorted(h["item"] for h in mine(client)) == ["Dome tent #1", "Dome tent #2"]
    held = {h["item_id"] for h in assistant.list_holds()["holds"]}
    assert held <= set(tents["unit_ids"]) and len(held) == 2


def test_staff_and_administrators_do_not_ask_this_way(client, stock):
    assert ask(client, stock["coat"], headers=AS_ALICE).status_code == 403
    assert client.get("/outreach/holds", headers=AS_ALICE).status_code == 403


def test_outreach_sees_no_hold_but_their_own(client, stock):
    assistant.place_hold(stock["socks"], "Bird", day(3), count=2)
    other = {**AS_OMAR, "X-Test-User": "01ARZ3NDEKTSV4RRFFQ69G5FAD"}
    (theirs,) = ask(client, stock["coat"], handle="Wren", headers=other).json()["hold_ids"]
    assert mine(client) == []
    got = client.post(f"/outreach/holds/{theirs}/expiry", json={"expires_on": day(9)}, headers=AS_OMAR)
    assert got.status_code == 404
    assert "Bird" not in client.get("/outreach/holds", headers=AS_OMAR).text


def test_outreach_moves_their_own_date_with_no_new_approval(client, stock, db_path, db):
    (hold_id,) = ask(client, stock["coat"]).json()["hold_ids"]
    with as_admin(db_path):
        assistant.approve_hold(hold_id)
    got = client.post(f"/outreach/holds/{hold_id}/expiry", json={"expires_on": day(9)}, headers=AS_OMAR)
    assert got.status_code == 200
    assert got.json()["holds"][0]["expires_on"] == day(9) and got.json()["holds"][0]["state"] == "approved"
    assert (
        client.post(f"/outreach/holds/{hold_id}/expiry", json={"expires_on": day(0)}, headers=AS_OMAR).status_code
        == 400
    )


def test_an_unanswered_request_expires_with_its_day(client, stock, db):
    (hold_id,) = ask(client, stock["coat"], until=1).json()["hold_ids"]
    later = now_ms() + 3 * DAY_MS
    assert holds.expire_due(db, later) == [hold_id]
    assert (derived.get_entity(db, "hold", hold_id) or {})["state"] == "expired"
    assert holds.handles(db) == {}


def test_requests_are_capped_per_account(client, stock, monkeypatch):
    from gear_tracker import outreach

    monkeypatch.setattr(outreach, "MAX_WAITING", 2)
    assert ask(client, stock["socks"]).status_code == 200
    assert ask(client, stock["socks"]).status_code == 200
    assert ask(client, stock["socks"]).status_code == 409


def test_administrators_hear_of_a_request_and_the_worker_hears_the_answer(client, stock, db_path, db, monkeypatch):
    sent: list[tuple[list[str], str]] = []
    monkeypatch.setattr(notify, "_send_to", lambda _settings, to, _about, subject, _body: sent.append((to, subject)))
    monkeypatch.setattr(notify.mail, "get", lambda _conn: {"host": "smtp.example.org"})
    events.append_server(db, ADMIN, "user", ADMIN, "created", {"name": "Ada", "role": "admin", "active": True})
    for user, email in ((ADMIN, "ada@example.org"), (OMAR, "omar@example.org"), (ALICE, "alice@example.org")):
        db.execute("INSERT INTO accounts (user_id, email, created_at) VALUES (?, ?, 0)", (user, email))

    (hold_id,) = ask(client, stock["coat"]).json()["hold_ids"]
    assert sent[-1][0] == ["ada@example.org"] and sent[-1][1].endswith("hold requested")

    with as_admin(db_path):
        assistant.approve_hold(hold_id)
    assert sent[-1][0] == ["omar@example.org"] and sent[-1][1].endswith("hold request approved")

    # Outreach moves the date: the approver is named on it, and every Administrator hears (FR-HLD-22).
    client.post(f"/outreach/holds/{hold_id}/expiry", json={"expires_on": day(9)}, headers=AS_OMAR)
    assert sent[-1][0] == ["ada@example.org"] and sent[-1][1].endswith("hold date moved")
    assert all("Mouse" not in subject for _to, subject in sent)


# --- collection and delivery (FR-HLD-14, 15, 24, 25) ------------------------------------------


def approved(client, db_path, item_id: str, until: int = 5) -> str:
    (hold_id,) = ask(client, item_id, until=until).json()["hold_ids"]
    with as_admin(db_path):
        assistant.approve_hold(hold_id)
    return hold_id


def book(client, hold_id: str, headers=AS_OMAR, **body):
    return client.post(f"/outreach/holds/{hold_id}/collection", json=body, headers=headers)


def at(offset: int, clock: str = "14:30") -> str:
    return f"{day(offset)}T{clock}"


def test_outreach_books_a_delivery_with_a_time_and_a_drop_off_point(client, stock, db_path, db):
    hold_id = approved(client, db_path, stock["coat"])
    got = book(client, hold_id, method="delivery", at=at(2), drop_off="  Front desk,   Main and Hastings ")
    assert got.status_code == 200
    (mine_now,) = got.json()["holds"]
    assert mine_now["collection"] == "delivery" and mine_now["delivery_at"] == at(2)
    assert mine_now["drop_off"] == "Front desk, Main and Hastings" and mine_now["delivery_by"] is None

    # The time is on the log. Where it goes is beside it, and nowhere in it (FR-HLD-53).
    hold = derived.get_entity(db, "hold", hold_id) or {}
    assert hold["collection"] == "delivery" and hold["delivery_at"] == at(2)
    assert holds.drop_offs(db) == {hold_id: "Front desk, Main and Hastings"}
    logged = " ".join(row["payload"] for row in db.execute("SELECT payload FROM events"))
    assert "Front desk" not in logged
    # Staff devices are sent it with a sync.
    assert sync.bootstrap(db, Principal(user_id=ALICE, device_id="phone", role="user"))["hold_drop_offs"] == {
        hold_id: "Front desk, Main and Hastings"
    }


def test_collecting_in_person_has_no_time_or_place_and_replaces_a_delivery(client, stock, db_path, db):
    hold_id = approved(client, db_path, stock["coat"])
    assert book(client, hold_id, method="delivery", at=at(1), drop_off="Side door").status_code == 200
    assistant.take_delivery(hold_id)
    assert book(client, hold_id, method="in_person", at=at(1)).status_code == 400
    got = book(client, hold_id, method="in_person")
    assert got.status_code == 200
    (mine_now,) = got.json()["holds"]
    assert mine_now["collection"] == "in_person" and mine_now["delivery_at"] is None
    assert mine_now["drop_off"] is None and mine_now["delivery_by"] is None
    assert holds.drop_offs(db) == {}
    assert "delivery_by" not in (derived.get_entity(db, "hold", hold_id) or {})


def test_a_delivery_needs_a_time_within_the_hold_and_a_place(client, stock, db_path):
    hold_id = approved(client, db_path, stock["coat"], until=5)
    assert book(client, hold_id, method="delivery", at=at(2)).status_code == 400
    assert book(client, hold_id, method="delivery", drop_off="Side door").status_code == 400
    assert book(client, hold_id, method="delivery", at=at(-1), drop_off="Side door").status_code == 400
    assert book(client, hold_id, method="delivery", at=at(6), drop_off="Side door").status_code == 409
    assert book(client, hold_id, method="delivery", at=f"{day(2)}T25:00", drop_off="Side door").status_code == 400
    assert book(client, hold_id, method="delivery", at=at(5), drop_off="Side door").status_code == 200
    # The hold cannot then be cut short of its delivery.
    got = client.post(f"/outreach/holds/{hold_id}/expiry", json={"expires_on": day(3)}, headers=AS_OMAR)
    assert got.status_code == 409


def test_only_an_approved_hold_of_ones_own_is_booked(client, stock, db_path):
    (waiting,) = ask(client, stock["coat"]).json()["hold_ids"]
    assert book(client, waiting, method="in_person").status_code == 409
    theirs = assistant.place_hold(stock["socks"], "Bird", day(3), count=2)["hold_id"]
    assert book(client, theirs, method="in_person").status_code == 404
    assert book(client, waiting, method="in_person", headers=AS_ALICE).status_code == 403
    with as_admin(db_path):
        assistant.decline_hold(waiting)
    assert book(client, waiting, method="in_person").status_code == 409


def push_booking(client, hold_id: str, payload: dict, places: list[dict], seq: int = 1) -> dict:
    event = {
        "id": new_ulid(),
        "entity_type": "hold",
        "entity_id": hold_id,
        "type": "collection_booked",
        "actor_id": ALICE,
        "device_id": "phone",
        "device_seq": seq,
        "occurred_at": now_ms(),
        "clock_offset": 0,
        "payload": payload,
    }
    body = {"device_id": "phone", "client_time": now_ms(), "events": [event], "hold_drop_offs": places}
    return client.post("/sync/push", json=body, headers=AS_ALICE).json()


def test_staff_book_for_the_worker_from_a_device_with_the_place_beside_the_log(client, stock, db_path, db):
    hold_id = approved(client, db_path, stock["coat"])
    place = {"hold_id": hold_id, "place": " Side   door "}
    got = push_booking(client, hold_id, {"method": "delivery", "at": at(2)}, [place])
    assert got["rejected"] == [] and got["hold_drop_offs_taken"] == [hold_id]
    assert holds.drop_offs(db) == {hold_id: "Side door"}
    (seen,) = mine(client)
    assert seen["collection"] == "delivery" and seen["delivery_at"] == at(2) and seen["drop_off"] == "Side door"
    assert "Side door" not in " ".join(row["payload"] for row in db.execute("SELECT payload FROM events"))

    # Booked in person from the device: the place goes, and one sent with it is not kept.
    got = push_booking(client, hold_id, {"method": "in_person"}, [place], seq=2)
    assert got["rejected"] == [] and got["hold_drop_offs_taken"] == [hold_id]
    assert holds.drop_offs(db) == {}


def test_a_hold_staff_placed_is_not_booked_for_collection(client, stock, db):
    theirs = assistant.place_hold(stock["socks"], "Bird", day(3), count=2)["hold_id"]
    got = push_booking(client, theirs, {"method": "delivery", "at": at(1)}, [{"hold_id": theirs, "place": "Side door"}])
    assert "only on a hold an Outreach worker asked for" in got["rejected"][0]["reason"]
    assert holds.drop_offs(db) == {}
    with pytest.raises(Exception, match="only on a hold an Outreach worker asked for"):
        assistant.book_collection(theirs, "in_person")


def test_the_assistant_books_for_the_worker(client, stock, db_path, db):
    (waiting,) = ask(client, stock["socks"]).json()["hold_ids"]
    with pytest.raises(Exception, match="not approved yet"):
        assistant.book_collection(waiting, "in_person")
    hold_id = approved(client, db_path, stock["coat"], until=5)
    with pytest.raises(Exception, match="needs a time and a drop-off point"):
        assistant.book_collection(hold_id, "delivery", at=at(2))
    with pytest.raises(Exception, match="extend the hold first"):
        assistant.book_collection(hold_id, "delivery", at=at(6), drop_off="Side door")
    with pytest.raises(Exception, match="from today on"):
        assistant.book_collection(hold_id, "delivery", at=at(-1), drop_off="Side door")
    booked = assistant.book_collection(hold_id, "delivery", at=at(2), drop_off="Side door")
    assert booked["collection"] == "delivery" and booked["drop_off"] == "Side door" and booked["delivery_by"] is None
    assert [h for h in mine(client) if h["id"] == hold_id][0]["drop_off"] == "Side door"
    assert assistant.book_collection(hold_id, "in_person")["collection"] == "in_person"
    assert holds.drop_offs(db) == {}


def test_the_log_refuses_a_drop_off_point(db, stock):
    hold_id = new_ulid()
    events.append_server(db, ALICE, "hold", hold_id, "created", {"item_id": stock["coat"], "expires_on": day(3)})
    with pytest.raises(events.Rejected, match="not recorded on the log"):
        events.append_server(
            db, ALICE, "hold", hold_id, "collection_booked", {"method": "delivery", "at": at(1), "drop_off": "x"}
        )


def test_staff_take_a_delivery_and_are_named_on_it(client, stock, db_path, db):
    hold_id = approved(client, db_path, stock["coat"])
    with pytest.raises(Exception, match="no delivery is booked"):
        assistant.take_delivery(hold_id)
    book(client, hold_id, method="delivery", at=at(2), drop_off="Side door")
    taken = assistant.take_delivery(hold_id)
    assert taken["delivery_by"] == "Alice" and taken["drop_off"] == "Side door" and taken["delivery_at"] == at(2)
    assert mine(client)[0]["delivery_by"] == "Alice"
    assert ALICE in notify.named_on(derived.get_entity(db, "hold", hold_id) or {})
    # An Administrator takes it over; a new time keeps whoever has it.
    events.append_server(db, ADMIN, "user", ADMIN, "created", {"name": "Ada", "role": "admin", "active": True})
    with as_admin(db_path):
        assert assistant.take_delivery(hold_id)["delivery_by"] == "Ada"
    book(client, hold_id, method="delivery", at=at(3), drop_off="Side door")
    assert assistant.list_holds()["holds"][0]["delivery_by"] == "Ada"


def test_the_drop_off_point_goes_when_the_hold_ends(client, stock, db_path, db):
    hold_id = approved(client, db_path, stock["coat"])
    book(client, hold_id, method="delivery", at=at(2), drop_off="Side door")
    assistant.hand_out_hold(hold_id)
    assert holds.drop_offs(db) == {} and holds.handles(db) == {}
    (ended,) = mine(client)
    assert ended["state"] == "handed_out" and ended["drop_off"] is None and ended["delivery_at"] is None

    other = approved(client, db_path, stock["socks"], until=1)
    book(client, other, method="delivery", at=at(1), drop_off="Back lane")
    holds.expire_due(db, now_ms() + 3 * DAY_MS)
    assert holds.drop_offs(db) == {}


def test_a_booking_and_a_taken_delivery_are_mailed_without_the_place(client, stock, db_path, db, monkeypatch):
    sent: list[tuple[list[str], str, str]] = []
    monkeypatch.setattr(notify, "_send_to", lambda _s, to, _about, subject, body: sent.append((to, subject, body)))
    monkeypatch.setattr(notify.mail, "get", lambda _conn: {"host": "smtp.example.org"})
    for user, email in ((ADMIN, "ada@example.org"), (OMAR, "omar@example.org"), (ALICE, "alice@example.org")):
        db.execute("INSERT INTO accounts (user_id, email, created_at) VALUES (?, ?, 0)", (user, email))
    hold_id = approved(client, db_path, stock["coat"])

    book(client, hold_id, method="delivery", at=at(2), drop_off="Side door")
    assert sent[-1][0] == ["ada@example.org"] and sent[-1][1].endswith("delivery booked")
    assert at(2).replace("T", " at ") in sent[-1][2]

    assistant.take_delivery(hold_id)
    assert sorted(sent[-1][0]) == ["ada@example.org", "omar@example.org"] and sent[-1][1].endswith("delivery taken")
    assert "Alice will make the delivery" in sent[-1][2]

    book(client, hold_id, method="in_person")
    assert sent[-1][1].endswith("collection booked")

    # Staff book for the worker: the worker hears, and so do the Administrators (FR-HLD-54).
    assistant.book_collection(hold_id, "delivery", at=at(3), drop_off="Side door")
    assert sorted(sent[-1][0]) == ["ada@example.org", "omar@example.org"] and sent[-1][1].endswith("delivery booked")
    assert all("Side door" not in body and "Mouse" not in body for _to, _subject, body in sent)
