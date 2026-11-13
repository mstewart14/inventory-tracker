/**
 * Holds: goods set aside for a client until a day (FR-HLD-01, FR-HLD-03).
 *
 * A hold is an entity on the log: the item, a count for a pool, the day it runs out, who placed
 * it, and how it ended. Who it is for is not on the log, because the log cannot forget and a
 * handle must be forgotten when the hold ends (FR-HLD-17). The handle is kept in `meta`: typed
 * here it waits in `pending_handles` until the server takes it, and the server's whole list comes
 * back with every sync as `hold_handles`.
 *
 * A hold stops counting the day after `expires_on`, with no event, so its goods are back in stock
 * on a phone with no signal (FR-HLD-11). The server records the ending when it sees the day pass.
 */
import { isPool, item, type Item, poolCounts, resolveItem } from "./inventory";
import type { Fields, State } from "./replay";
import type { Store } from "./store";
import { localDate } from "./time";
import { newUlid } from "./ulid";

export type HoldState = "live" | "put_back" | "handed_out" | "expired";

export interface Hold {
  id: string;
  item_id: string;
  /** Set only for a pool. */
  count?: number;
  /** The last day the hold stands, YYYY-MM-DD. */
  expires_on: string;
  state?: HoldState;
  created_by?: string;
  ended_at?: number;
  ended_by?: string;
  added_at?: number;
}

export const MAX_HANDLE = 80;

/** A handle as stored: one line, single spaces, at most MAX_HANDLE long. Twin of tidy_handle in holds.py. */
export const tidyHandle = (handle: string): string =>
  handle.split(/\s+/).filter(Boolean).join(" ").slice(0, MAX_HANDLE).trim();

const withId = (table: Record<string, Fields> | undefined): Hold[] =>
  Object.entries(table ?? {}).map(([id, fields]) => ({ id, ...fields }) as Hold);

/** Every hold, soonest to run out first. */
export const holds = (state: State): Hold[] =>
  withId(state.hold).sort((a, b) => a.expires_on.localeCompare(b.expires_on) || a.id.localeCompare(b.id));

export const hold = (state: State, id: string): Hold | undefined => holds(state).find((h) => h.id === id);

/** Whether a hold still sets goods aside: not ended, and its day has not passed (FR-HLD-11). Twin of is_live in views.py. */
export const isLive = (h: Hold, today: string): boolean => (h.state ?? "live") === "live" && h.expires_on >= today;

/** How a hold reads now: an unended one past its day has expired, whether or not the server has said so. */
export const holdState = (h: Hold, today: string): HoldState =>
  isLive(h, today) ? "live" : (h.state ?? "live") === "live" ? "expired" : h.state!;

/** Holds in force, on one item or on all. A hold on a merged duplicate belongs to its survivor. */
export function liveHolds(state: State, today: string, itemId?: string): Hold[] {
  const live = holds(state).filter((h) => isLive(h, today));
  return itemId === undefined ? live : live.filter((h) => resolveItem(state, h.item_id) === itemId);
}

/** How many of an item are set aside (FR-HLD-08): a count of a pool, or one for a single item. */
export function held(state: State, it: Item, today: string): number {
  const mine = liveHolds(state, today, it.id);
  if (isPool(it)) return mine.reduce((sum, h) => sum + (h.count ?? 0), 0);
  return mine.length > 0 ? 1 : 0;
}

/** What can be held or handed out to someone new: what is in, less what is held (FR-HLD-08). */
export function available(state: State, it: Item, today: string): number {
  if (isPool(it)) return Math.max(0, poolCounts(it).in - held(state, it, today));
  const inStock = it.status === "in" && !it.retired && !it.generic;
  return inStock && held(state, it, today) === 0 ? 1 : 0;
}

/** The calendar day where the goods are (NFR-DATA-12). */
export const today = (store: Store): string => localDate(store.now());

/** Who a live hold is for, if this device knows: typed here and not yet sent, or as the server last said. */
export const handleFor = (store: Store, holdId: string): string | undefined =>
  store.meta.pending_handles?.[holdId] ?? store.meta.hold_handles?.[holdId];

const actor = (store: Store): string => {
  const id = store.meta.user?.id;
  if (!id) throw new Error("not signed in");
  return id;
};

function liveHold(store: Store, id: string): Hold {
  const h = hold(store.state, id);
  if (!h) throw new Error("no such hold");
  if (!isLive(h, today(store))) throw new Error("this hold has ended");
  return h;
}

function afterToday(store: Store, day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("pick a day");
  if (day <= today(store)) throw new Error("pick a day after today");
}

export interface HoldInput {
  item_id: string;
  handle: string;
  expires_on: string;
  /** A pool only. */
  count?: number;
}

/**
 * Set goods aside for a client until a day after today (FR-HLD-01, FR-HLD-03). No more than are
 * free of other holds (FR-HLD-08). The handle is saved before the hold is recorded, so a sync that
 * runs the moment the hold is made takes both.
 */
export async function placeHold(store: Store, input: HoldInput): Promise<string> {
  const it = item(store.state, input.item_id);
  if (!it) throw new Error("no such item");
  const handle = tidyHandle(input.handle);
  if (!handle) throw new Error("say who it is for");
  afterToday(store, input.expires_on);
  const pool = isPool(it);
  if (it.generic && !pool) throw new Error("hold one of its units");
  const count = pool ? input.count : undefined;
  if (pool && (!Number.isInteger(count) || count! < 1)) throw new Error("pick a count of at least 1");
  const free = available(store.state, it, today(store));
  if ((count ?? 1) > free) throw new Error(pool ? `only ${free} free to hold` : "not free to hold");
  const id = newUlid(store.now());
  await store.setMeta({
    pending_handles: { ...store.meta.pending_handles, [id]: handle },
  });
  await store.record({
    entity_type: "hold",
    entity_id: id,
    type: "created",
    actor_id: actor(store),
    payload: {
      item_id: it.id,
      expires_on: input.expires_on,
      ...(pool ? { count } : {}),
    },
  });
  return id;
}

/** Move a live hold's end to a new day after today (FR-HLD-09). */
export async function extendHold(store: Store, id: string, expiresOn: string): Promise<void> {
  const h = liveHold(store, id);
  afterToday(store, expiresOn);
  if (expiresOn === h.expires_on) return;
  await store.record({
    entity_type: "hold",
    entity_id: id,
    type: "field_changed",
    actor_id: actor(store),
    payload: { field: "expires_on", value: expiresOn, old: h.expires_on },
  });
}

/** The handle is not kept past the hold (FR-HLD-17): gone from this device now, from the server at sync. */
async function forget(store: Store, id: string): Promise<void> {
  const drop = (map: Record<string, string> | undefined) => {
    if (!map || !(id in map)) return map;
    const { [id]: _gone, ...rest } = map;
    return Object.keys(rest).length > 0 ? rest : undefined;
  };
  await store.setMeta({
    pending_handles: drop(store.meta.pending_handles),
    hold_handles: drop(store.meta.hold_handles),
  });
}

async function end(store: Store, id: string, reason: "put_back" | "handed_out") {
  await store.record({
    entity_type: "hold",
    entity_id: id,
    type: "hold_ended",
    actor_id: actor(store),
    payload: { reason },
  });
  await forget(store, id);
}

/** End a live hold and return its goods to general stock (FR-HLD-10). */
export async function putBackHold(store: Store, id: string): Promise<void> {
  liveHold(store, id);
  await end(store, id, "put_back");
}

/** Hand a live hold's goods to the client it is for (FR-HLD-16): they leave the inventory, and the hold ends. */
export async function handOutHold(store: Store, id: string): Promise<void> {
  const h = liveHold(store, id);
  const it = item(store.state, resolveItem(store.state, h.item_id));
  if (!it) throw new Error("no such item");
  const pool = isPool(it);
  if (!pool && it.retired) throw new Error("no longer in the inventory; put the hold back");
  await store.record({
    entity_type: "item",
    entity_id: it.id,
    type: "handed_out",
    actor_id: actor(store),
    payload: { hold_id: id, ...(pool ? { count: h.count ?? 1 } : {}) },
  });
  await end(store, id, "handed_out");
}
