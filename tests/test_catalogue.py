"""The public catalogue (FR-VIS-04 to 07): what anyone may read with no account, and what they may not."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from gear_tracker import assistant, events, views
from gear_tracker.app import CATALOGUE_PER_ADDRESS, create_app
from gear_tracker.db import open_db
from gear_tracker.events import now_ms
from gear_tracker.sync import Principal
from gear_tracker.ulid import new_ulid
from tests.test_app import authenticate

ALICE = "01ARZ3NDEKTSV4RRFFQ69G5FAA"
JPEG = b"\xff\xd8\xff\xe0 not really a jpeg"
DAY_MS = 24 * 3_600_000


def make(conn, payload: dict) -> str:
    item_id = new_ulid()
    events.append_server(conn, ALICE, "item", item_id, "created", payload)
    return item_id


@pytest.fixture
def stock(db_path):
    """Two public things, a coat and a stack of socks, beside things the public must not see."""
    with open_db(db_path) as conn:
        events.append_server(conn, ALICE, "user", ALICE, "created", {"name": "Alice", "role": "user", "active": True})
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
                conn, {"name": "Socks", "generic": True, "pool": True, "quantity": 20, "visibility": "public"}
            ),
            "tent": make(conn, {"name": "Tent", "visibility": "outreach"}),
            "radio": make(conn, {"name": "Staff radio"}),
        }
    with assistant.acting_as(Principal(user_id=ALICE, device_id="assistant-1"), db_path):
        yield made


@pytest.fixture
def public(db_path, stock):
    return TestClient(create_app(db_path, authenticate))


def names(client) -> list[str]:
    return [row["name"] for row in client.get("/public/catalogue").json()["items"]]


def day(offset: int) -> str:
    return views.today(now_ms() + offset * DAY_MS)


def test_anyone_reads_the_public_items_and_how_to_reach_the_society(public):
    got = public.get("/public/catalogue")
    assert got.status_code == 200
    body = got.json()
    assert body["group"] == {"name": "The Society", "contact": "Drop in at the front desk"}
    assert [row["name"] for row in body["items"]] == ["Socks", "Winter coat"]


def test_the_catalogue_says_only_a_name_a_description_categories_and_photos(public):
    got = public.get("/public/catalogue")
    coat = got.json()["items"][1]
    assert coat == {"name": "Winter coat", "description": "Warm, size L", "categories": [], "photos": []}
    # A stack says nothing of how many there are (FR-VIS-05).
    assert got.json()["items"][0] == {"name": "Socks", "description": "", "categories": [], "photos": []}
    # No locations, sources, ids or people, anywhere in the reply.
    for hidden in ("Church drive", "Back room", "shelf 2", "Alice", ALICE, "Tent", "Staff radio"):
        assert hidden not in got.text


def test_an_item_joins_and_leaves_the_catalogue_with_its_mark(public, stock):
    assistant.update_item(stock["radio"], assistant.ItemFields(visibility="public"))
    assistant.update_item(stock["coat"], assistant.ItemFields(visibility="staff"))
    assert names(public) == ["Socks", "Staff radio"]


def test_only_what_is_free_to_give_is_listed(public, stock):
    hold = assistant.place_hold(stock["coat"], "JD", day(3))
    assert names(public) == ["Socks"]
    assistant.put_back_hold(hold["hold_id"])
    assistant.place_hold(stock["socks"], "JD", day(3), count=20)
    assert names(public) == ["Winter coat"]
    assistant.hand_out(stock["coat"])
    assert names(public) == []


def test_a_generic_is_one_line_while_any_unit_is_free(public, stock):
    tents = assistant.create_item("Dome tent", generic=True, units=2, visibility="public")
    assert names(public).count("Dome tent") == 1
    for unit in tents["unit_ids"]:
        assistant.hand_out(unit)
    assert "Dome tent" not in names(public)


def test_a_public_items_photo_is_served_and_no_other(public, stock):
    as_alice = {"X-Test-User": ALICE, "Content-Type": "image/jpeg"}
    shown, hidden = new_ulid(), new_ulid()
    assert public.put(f"/photos/{shown}?entity_type=item&entity_id={stock['coat']}", content=JPEG, headers=as_alice)
    assert public.put(f"/photos/{hidden}?entity_type=item&entity_id={stock['radio']}", content=JPEG, headers=as_alice)

    assert public.get("/public/catalogue").json()["items"][1]["photos"] == [shown]
    got = public.get(f"/public/photos/{shown}")
    assert got.status_code == 200 and got.content == JPEG
    assert public.get(f"/public/photos/{hidden}").status_code == 404
    assert public.get("/public/photos/not-an-id").status_code == 400

    # Off the catalogue, its photo stops being served.
    assistant.update_item(stock["coat"], assistant.ItemFields(visibility="staff"))
    assert public.get(f"/public/photos/{shown}").status_code == 404


def test_nothing_is_changed_through_the_catalogue(public):
    assert public.post("/public/catalogue", json={}).status_code == 405


def test_the_catalogue_is_rate_limited_per_address(public):
    limit = CATALOGUE_PER_ADDRESS[0]
    assert {public.get("/public/catalogue").status_code for _ in range(limit)} == {200}
    assert public.get("/public/catalogue").status_code == 429


def test_the_assistant_reads_what_the_public_page_lists(stock):
    got = assistant.public_catalogue()
    assert got["count"] == 2 and [row["name"] for row in got["items"]] == ["Socks", "Winter coat"]
