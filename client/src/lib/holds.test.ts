import { beforeEach, expect, test } from "vitest";
import { openStore } from "../ui/codeTestKit";
import * as act from "./actions";
import { DAY_MS } from "./clock";
import * as h from "./holds";
import * as inv from "./inventory";
import * as mv from "./movement";
import type { Store } from "./store";
import { localDate } from "./time";

// Holds: goods set aside for a client until a day (FR-HLD).
let store: Store;
let ahead = 0;
let coat: string;
let socks: string;

// Days from the store's own today, which tests move on with `ahead`.
const day = (offset: number) => localDate(store.now() + offset * DAY_MS);
const item = (id: string) => inv.item(store.state, id)!;
const free = (id: string) => h.available(store.state, item(id), h.today(store));

beforeEach(async () => {
  ahead = 0;
  store = await openStore(() => ahead);
  coat = await act.createItem(store, { name: "Winter coat" });
  socks = await act.createPool(store, { name: "Socks" }, 20);
});

test("a hold sets a count aside until a day, and who it is for stays off the log (FR-HLD-01, FR-HLD-17)", async () => {
  const id = await h.placeHold(store, { item_id: socks, handle: "  J   D ", expires_on: day(7), count: 5 });
  expect(h.hold(store.state, id)).toMatchObject({
    item_id: socks,
    count: 5,
    expires_on: day(7),
    state: "live",
    created_by: "alice",
  });
  expect(h.handleFor(store, id)).toBe("J D");
  expect(store.meta.pending_handles).toEqual({ [id]: "J D" });
  expect(JSON.stringify(store.pending)).not.toContain("J D");
  expect(h.held(store.state, item(socks), h.today(store))).toBe(5);
  expect(free(socks)).toBe(15);
});

test("a hold needs someone, a day after today, and a count for a pool only (FR-HLD-02, FR-HLD-03)", async () => {
  await expect(h.placeHold(store, { item_id: coat, handle: "  ", expires_on: day(3) })).rejects.toThrow(
    "who it is for",
  );
  await expect(h.placeHold(store, { item_id: coat, handle: "JD", expires_on: day(0) })).rejects.toThrow(
    "a day after today",
  );
  await expect(h.placeHold(store, { item_id: socks, handle: "JD", expires_on: day(3) })).rejects.toThrow(
    "a count of at least 1",
  );
  const id = await h.placeHold(store, { item_id: coat, handle: "JD", expires_on: day(3), count: 4 });
  expect(h.hold(store.state, id)!.count).toBeUndefined();
});

test("goods on hold cannot be held or handed out to anyone else (FR-HLD-08)", async () => {
  await h.placeHold(store, { item_id: socks, handle: "JD", expires_on: day(3), count: 15 });
  await expect(h.placeHold(store, { item_id: socks, handle: "Mouse", expires_on: day(3), count: 6 })).rejects.toThrow(
    "only 5 free to hold",
  );
  await expect(mv.handOutPool(store, socks, 6)).rejects.toThrow("only 5 not on hold");
  await mv.handOutPool(store, socks, 5);

  await h.placeHold(store, { item_id: coat, handle: "JD", expires_on: day(3) });
  await expect(h.placeHold(store, { item_id: coat, handle: "Mouse", expires_on: day(3) })).rejects.toThrow(
    "not free to hold",
  );
  await expect(mv.handOut(store, coat)).rejects.toThrow("on hold");
});

test("handing out a hold removes the goods, ends the hold and forgets the handle (FR-HLD-16, FR-HLD-17)", async () => {
  const id = await h.placeHold(store, { item_id: socks, handle: "JD", expires_on: day(3), count: 5 });
  await h.handOutHold(store, id);
  expect(inv.poolCounts(item(socks))).toMatchObject({ in: 15, given: 5 });
  expect(h.hold(store.state, id)).toMatchObject({ state: "handed_out", ended_by: "alice" });
  expect(h.handleFor(store, id)).toBeUndefined();
  expect(store.pending.at(-2)).toMatchObject({ type: "handed_out", payload: { count: 5, hold_id: id } });
  await expect(h.handOutHold(store, id)).rejects.toThrow("this hold has ended");

  const single = await h.placeHold(store, { item_id: coat, handle: "Mouse", expires_on: day(3) });
  await h.handOutHold(store, single);
  expect(inv.wasHandedOut(item(coat))).toBe(true);
});

test("putting a hold back frees the goods and forgets the handle (FR-HLD-10, FR-HLD-17)", async () => {
  const id = await h.placeHold(store, { item_id: coat, handle: "JD", expires_on: day(3) });
  expect(free(coat)).toBe(0);
  await h.putBackHold(store, id);
  expect(h.hold(store.state, id)!.state).toBe("put_back");
  expect(h.handleFor(store, id)).toBeUndefined();
  expect(free(coat)).toBe(1);
});

test("a hold moves to a new day after today (FR-HLD-09)", async () => {
  const id = await h.placeHold(store, { item_id: coat, handle: "JD", expires_on: day(3) });
  await h.extendHold(store, id, day(10));
  expect(h.hold(store.state, id)!.expires_on).toBe(day(10));
  expect(store.pending.at(-1)!.payload).toEqual({ field: "expires_on", value: day(10), old: day(3) });
  await expect(h.extendHold(store, id, day(0))).rejects.toThrow("a day after today");
});

test("a hold past its day frees its goods with no signal and nothing recorded (FR-HLD-11)", async () => {
  const id = await h.placeHold(store, { item_id: socks, handle: "JD", expires_on: day(1), count: 20 });
  expect(free(socks)).toBe(0);
  const sent = store.pending.length;
  ahead = 2 * DAY_MS;
  expect(free(socks)).toBe(20);
  expect(h.holdState(h.hold(store.state, id)!, h.today(store))).toBe("expired");
  expect(h.liveHolds(store.state, h.today(store))).toEqual([]);
  expect(store.pending.length).toBe(sent);
  await expect(h.extendHold(store, id, day(9))).rejects.toThrow("this hold has ended");
});
