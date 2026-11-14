"""The Outreach role (FR-USR-36 to 42, FR-VIS-02, 03, 09 to 12): what a worker from another organization is
shown, and everything they are refused."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from gear_tracker import accounts, assistant, events, notify, sync, views
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
