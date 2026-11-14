import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import { DAY_MS } from "../lib/clock";
import * as h from "../lib/holds";
import * as inv from "../lib/inventory";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { localDate } from "../lib/time";
import { unsaved } from "../lib/unsaved";
import { openStore } from "./codeTestKit";
import { Holds } from "./Holds";
import { ItemPage } from "./ItemPage";
import { alice, renderInShell, seedUsers } from "./moveTestKit";

// Holds on screen: placed, moved, put back and handed out where the goods are moved (FR-HLD).
let store: Store;
let ahead = 0;
let coat: string;
let socks: string;

const day = (offset: number) => localDate(store.now() + offset * DAY_MS);
const user = userEvent.setup();
const panel = () => within(screen.getByRole("region", { name: "Holds" }));

beforeEach(async () => {
  ahead = 0;
  store = await openStore(() => ahead);
  await seedUsers(store, [alice]);
  coat = await act.createItem(store, { name: "Winter coat" });
  socks = await act.createPool(store, { name: "Socks" }, 20);
});

afterEach(() => unsaved.cancel());

test("a hold is placed from the item's page: who for, how many, and a day a week off unless changed (FR-HLD-01, FR-HLD-03)", async () => {
  navigate(`/items/${socks}`);
  renderInShell(<ItemPage store={store} id={socks} />);
  await user.click(screen.getByRole("button", { name: "Hold for someone…" }));
  expect(panel().getByText("20 free to hold")).toBeInTheDocument();
  expect(panel().getByLabelText("Hold until")).toHaveValue(day(7));
  // Nothing to place until it says who for.
  expect(panel().getByRole("button", { name: "Place hold" })).toBeDisabled();

  await user.type(panel().getByLabelText("Hold for"), "JD");
  const count = panel().getByLabelText("How many to hold");
  await user.clear(count);
  await user.type(count, "5");
  fireEvent.change(panel().getByLabelText("Hold until"), {
    target: { value: day(3) },
  });
  await user.click(panel().getByRole("button", { name: "Place hold" }));

  expect(await screen.findByText(`On hold · 5 until ${day(3)} · Socks`)).toBeInTheDocument();
  expect(panel().getByRole("note")).toHaveTextContent(`On hold · 5 for JD · until ${day(3)}`);
  expect(h.liveHolds(store.state, h.today(store), socks)).toHaveLength(1);
});

test("a hold cannot be placed for today or earlier, or for more than are free (FR-HLD-03, FR-HLD-08)", async () => {
  await h.placeHold(store, {
    item_id: socks,
    handle: "Mouse",
    expires_on: day(3),
    count: 18,
  });
  navigate(`/items/${socks}`);
  renderInShell(<ItemPage store={store} id={socks} />);
  await user.click(screen.getByRole("button", { name: "Hold for someone…" }));
  await user.type(panel().getByLabelText("Hold for"), "JD");
  expect(panel().getByText("2 free to hold")).toBeInTheDocument();
  const place = panel().getByRole("button", { name: "Place hold" });
  expect(place).toBeEnabled();

  const count = panel().getByLabelText("How many to hold");
  await user.clear(count);
  await user.type(count, "3");
  expect(place).toBeDisabled();
  await user.clear(count);
  await user.type(count, "2");
  expect(place).toBeEnabled();
  fireEvent.change(panel().getByLabelText("Hold until"), {
    target: { value: day(0) },
  });
  expect(place).toBeDisabled();
});

test("a held item is handed out to the person it is for, not by the plain button (FR-HLD-08, FR-HLD-16)", async () => {
  const id = await h.placeHold(store, {
    item_id: coat,
    handle: "JD",
    expires_on: day(3),
  });
  navigate(`/items/${coat}`);
  renderInShell(<ItemPage store={store} id={coat} />);
  expect(panel().getByRole("note")).toHaveTextContent(`On hold · For JD · until ${day(3)}`);
  expect(screen.queryByRole("button", { name: "Hand out" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Hold for someone…" })).not.toBeInTheDocument();

  await user.click(panel().getByRole("button", { name: "Hand out to JD" }));
  await waitFor(() => expect(inv.wasHandedOut(inv.item(store.state, coat)!)).toBe(true));
  await waitFor(() => expect(h.hold(store.state, id)!.state).toBe("handed_out"));
  await waitFor(() => expect(h.handleFor(store, id)).toBeUndefined());
});

test("a hold's day is changed, and a hold is put back, from the item's page (FR-HLD-09, FR-HLD-10)", async () => {
  const id = await h.placeHold(store, {
    item_id: coat,
    handle: "JD",
    expires_on: day(3),
  });
  navigate(`/items/${coat}`);
  renderInShell(<ItemPage store={store} id={coat} />);

  await user.click(panel().getByRole("button", { name: "Change date" }));
  expect(panel().getByLabelText("Hold until")).toHaveValue(day(3));
  fireEvent.change(panel().getByLabelText("Hold until"), {
    target: { value: day(9) },
  });
  await user.click(panel().getByRole("button", { name: "Save date" }));
  await waitFor(() => expect(h.hold(store.state, id)!.expires_on).toBe(day(9)));
  expect(panel().getByRole("note")).toHaveTextContent(`until ${day(9)}`);

  await user.click(panel().getByRole("button", { name: "Put back" }));
  await waitFor(() => expect(h.hold(store.state, id)!.state).toBe("put_back"));
  // Free again: the plain button is back, and so is the offer to hold it.
  expect(await screen.findByRole("button", { name: "Hand out" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Hold for someone…" })).toBeInTheDocument();
});

test("the Holds screen lists what is on hold, soonest first, and what became of holds that ended (FR-HLD-13)", async () => {
  await h.placeHold(store, {
    item_id: socks,
    handle: "Mouse",
    expires_on: day(9),
    count: 4,
  });
  await h.placeHold(store, { item_id: coat, handle: "JD", expires_on: day(2) });
  const gone = await h.placeHold(store, {
    item_id: socks,
    handle: "Rae",
    expires_on: day(5),
    count: 1,
  });
  await h.putBackHold(store, gone);
  navigate("/holds");
  renderInShell(<Holds store={store} />);

  expect(screen.getByText("2 holds")).toBeInTheDocument();
  const rows = screen.getAllByRole("button").filter((b) => b.classList.contains("item"));
  expect(rows.map((b) => b.textContent)).toEqual([
    `Winter coatFor JD · until ${day(2)} · placed by Alice`,
    `Socks4 for Mouse · until ${day(9)} · placed by Alice`,
    `SocksPut back · 1 · was until ${day(5)} · placed by Alice`,
  ]);
  // Who an ended hold was for is not kept (FR-HLD-17).
  expect(screen.queryByText(/Rae/)).not.toBeInTheDocument();

  await user.click(rows[0]!);
  expect(location.pathname).toBe(`/items/${coat}`);
});

test("a hold past its day reads as expired and its goods are free, before any sync (FR-HLD-11)", async () => {
  await h.placeHold(store, { item_id: coat, handle: "JD", expires_on: day(1) });
  ahead = 2 * DAY_MS;
  navigate("/holds");
  renderInShell(<Holds store={store} />);
  expect(screen.getByText("Nothing is on hold.")).toBeInTheDocument();
  expect(screen.getByText(/^Expired · was until/)).toBeInTheDocument();
});

// --- requests from Outreach (FR-HLD-05, FR-HLD-06) -------------------------------------------

/** A request as it reaches a Staff device: written by the server for an Outreach worker, and pulled. */
async function request(itemId: string, count: number | undefined, seq: number, id = "0300000000000000000000REQ1") {
  const at = store.now();
  await store.receive(
    [
      {
        id: `03000000000000000000${String(seq).padStart(6, "0")}`,
        entity_type: "hold",
        entity_id: id,
        type: "created",
        actor_id: "omar",
        device_id: "server",
        device_seq: seq,
        occurred_at: at,
        clock_offset: 0,
        effective_at: at,
        received_at: at,
        seq,
        payload: {
          item_id: itemId,
          expires_on: day(5),
          requested: true,
          ...(count ? { count } : {}),
        },
      },
    ],
    seq,
  );
  await store.setMeta({
    hold_handles: { ...store.meta.hold_handles, [id]: "Mouse" },
  });
  return id;
}

const requests = () => within(screen.getByRole("region", { name: "Requests waiting for approval" }));

test("a request sets nothing aside until an Administrator approves it (FR-HLD-05, FR-HLD-06)", async () => {
  await seedUsers(store, [alice, { id: "omar", name: "Omar", role: "outreach", active: true }]);
  const id = await request(socks, 8, 2000);
  expect(h.available(store.state, inv.item(store.state, socks)!, h.today(store))).toBe(20);

  renderInShell(<Holds store={store} />);
  expect(requests().getByText(`8 for Mouse · until ${day(5)} · requested by Omar`)).toBeInTheDocument();
  expect(screen.getByText("Nothing is on hold.")).toBeInTheDocument();

  await user.click(requests().getByRole("button", { name: "Approve the request for Socks" }));
  await waitFor(() => expect(h.hold(store.state, id)?.state).toBe("live"));
  expect(h.hold(store.state, id)?.approved_by).toBe("alice");
  expect(h.available(store.state, inv.item(store.state, socks)!, h.today(store))).toBe(12);
  expect(screen.queryByRole("region", { name: "Requests waiting for approval" })).toBeNull();
  expect(screen.getByText(/8 for Mouse/)).toBeInTheDocument();
});

test("a declined request ends, forgets who it was for, and is listed as declined (FR-HLD-06, FR-HLD-17)", async () => {
  const id = await request(coat, undefined, 2000);
  renderInShell(<Holds store={store} />);
  await user.click(
    requests().getByRole("button", {
      name: "Decline the request for Winter coat",
    }),
  );
  await waitFor(() => expect(h.hold(store.state, id)?.state).toBe("declined"));
  await waitFor(() => expect(h.handleFor(store, id)).toBeUndefined());
  expect(within(screen.getByRole("region", { name: "Ended lately" })).getByText(/^Declined/)).toBeInTheDocument();
  expect(h.available(store.state, inv.item(store.state, coat)!, h.today(store))).toBe(1);
});

test("a request for more than is free cannot be approved, and says why (FR-HLD-08)", async () => {
  await request(socks, 15, 2000);
  await h.placeHold(store, {
    item_id: socks,
    handle: "Bird",
    expires_on: day(3),
    count: 10,
  });
  renderInShell(<Holds store={store} />);
  expect(requests().getByRole("note")).toHaveTextContent("Only 10 free to hold now.");
  expect(requests().getByRole("button", { name: "Approve the request for Socks" })).toBeDisabled();
  expect(requests().getByRole("button", { name: "Decline the request for Socks" })).toBeEnabled();
});

test("Staff see a request and cannot answer it (FR-HLD-06)", async () => {
  await seedUsers(store, [{ ...alice, role: "user" }]);
  const id = await request(coat, undefined, 2000);
  renderInShell(<Holds store={store} />);
  expect(requests().getByText("An Administrator approves or declines these.")).toBeInTheDocument();
  expect(requests().queryByRole("button", { name: /Approve|Decline/ })).toBeNull();
  await expect(h.approveHold(store, id)).rejects.toThrow("only an Administrator answers a request");
  await expect(h.declineHold(store, id)).rejects.toThrow("only an Administrator answers a request");
});

test("an unanswered request past its day reads as expired", async () => {
  const id = await request(coat, undefined, 2000);
  ahead = 6 * DAY_MS;
  expect(h.holdState(h.hold(store.state, id)!, h.today(store))).toBe("expired");
  expect(h.waitingHolds(store.state, h.today(store))).toEqual([]);
});
