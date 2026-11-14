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
import type { CollectionBooking } from "./api";
import type { Fields, State } from "./replay";
import type { Store } from "./store";
import { localDate } from "./time";
import { newUlid } from "./ulid";

export type HoldState = "live" | "waiting" | "put_back" | "handed_out" | "expired" | "declined";

export interface Hold {
  id: string;
  item_id: string;
  /** Set only for a pool. */
  count?: number;
  /** The last day the hold stands, YYYY-MM-DD. */
  expires_on: string;
  state?: HoldState;
  created_by?: string;
  /** An Outreach worker asked for it (FR-HLD-05). `created_by` is who asked. */
  requested?: boolean;
  /** The Administrator who approved a request, and when (FR-HLD-06). */
  approved_by?: string;
  approved_at?: number;
  /** How an Outreach worker booked it to be collected (FR-HLD-14). Unset until they do. */
  collection?: "in_person" | "delivery";
  /** When a delivery is wanted, on the local clock: 2026-11-20T14:30 (FR-HLD-15). */
  delivery_at?: string;
  /** The Staff member making the delivery, once one has taken it (FR-HLD-25). */
  delivery_by?: string;
  ended_at?: number;
  ended_by?: string;
  added_at?: number;
}

export const MAX_HANDLE = 80;

/** A drop-off point is a few words. Twin of MAX_DROP_OFF in holds.py. */
export const MAX_DROP_OFF = 120;

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

/** Whether a request still awaits an Administrator (FR-HLD-05). Twin of is_waiting in views.py. */
export const isWaiting = (h: Hold, today: string): boolean => h.state === "waiting" && h.expires_on >= today;

/** How a hold reads now: an unended one past its day has expired, whether or not the server has said so. */
export function holdState(h: Hold, today: string): HoldState {
  const state = h.state ?? "live";
  return (state === "live" || state === "waiting") && h.expires_on < today ? "expired" : state;
}

/** Requests waiting for an answer, soonest to run out first (FR-HLD-06). */
export const waitingHolds = (state: State, today: string): Hold[] => holds(state).filter((h) => isWaiting(h, today));

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

/** Where a booked delivery is dropped off, if the server has sent it (FR-HLD-15). Kept beside the log (FR-HLD-53). */
export const dropOffFor = (store: Store, holdId: string): string | undefined =>
  store.meta.pending_drop_offs?.[holdId] ?? store.meta.hold_drop_offs?.[holdId];

/** A drop-off point as stored: one line, single spaces, at most MAX_DROP_OFF long. Twin of tidy_drop_off in holds.py. */
export const tidyDropOff = (place: string): string =>
  place.split(/\s+/).filter(Boolean).join(" ").slice(0, MAX_DROP_OFF).trim();

/** "2026-11-20T14:30" as people read it: "2026-11-20 at 14:30". */
export const deliveryTime = (at: string | undefined): string => (at ?? "").replace("T", " at ");

/** Live holds booked for delivery, soonest first (FR-HLD-24). */
export const deliveries = (state: State, today: string): Hold[] =>
  holds(state)
    .filter((h) => isLive(h, today) && h.collection === "delivery")
    .sort((a, b) => (a.delivery_at ?? "").localeCompare(b.delivery_at ?? "") || a.id.localeCompare(b.id));

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

/** The handle and the drop-off point are not kept past the hold (FR-HLD-17, FR-HLD-53): gone from this device now, from the server at sync. */
const without = (map: Record<string, string> | undefined, id: string) => {
  if (!map || !(id in map)) return map;
  const { [id]: _gone, ...rest } = map;
  return Object.keys(rest).length > 0 ? rest : undefined;
};

async function forget(store: Store, id: string): Promise<void> {
  const drop = (map: Record<string, string> | undefined) => without(map, id);
  await store.setMeta({
    pending_handles: drop(store.meta.pending_handles),
    hold_handles: drop(store.meta.hold_handles),
    hold_drop_offs: drop(store.meta.hold_drop_offs),
    pending_drop_offs: drop(store.meta.pending_drop_offs),
  });
}

async function end(store: Store, id: string, reason: "put_back" | "handed_out" | "declined") {
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

function waitingHold(store: Store, id: string): Hold {
  const h = hold(store.state, id);
  if (!h) throw new Error("no such hold");
  if (!isWaiting(h, today(store))) throw new Error("this request has been answered");
  if (!store.admin) throw new Error("only an Administrator answers a request");
  return h;
}

/** How many of a request's goods are free to set aside right now (FR-HLD-08). */
export function freeFor(store: Store, h: Hold): number {
  const it = item(store.state, resolveItem(store.state, h.item_id));
  return it ? available(store.state, it, today(store)) : 0;
}

/**
 * Approve an Outreach worker's request (FR-HLD-06): the goods are set aside from now until its day.
 * Refused when fewer are free than were asked for (FR-HLD-08).
 */
export async function approveHold(store: Store, id: string): Promise<void> {
  const h = waitingHold(store, id);
  const free = freeFor(store, h);
  if ((h.count ?? 1) > free) throw new Error(h.count != null ? `only ${free} free to hold` : "not free to hold");
  await store.record({
    entity_type: "hold",
    entity_id: id,
    type: "hold_approved",
    actor_id: actor(store),
    payload: {},
  });
}

/** Decline a request (FR-HLD-06). Nothing was set aside, and who it was for is forgotten (FR-HLD-17). */
export async function declineHold(store: Store, id: string): Promise<void> {
  waitingHold(store, id);
  await end(store, id, "declined");
}

/**
 * Take on a delivery an Outreach worker booked (FR-HLD-24, FR-HLD-25): this person is now making it,
 * and is named on the hold. Taking one someone else has takes it over.
 */
export async function takeDelivery(store: Store, id: string): Promise<void> {
  const h = liveHold(store, id);
  if (h.collection !== "delivery") throw new Error("no delivery is booked for this hold");
  if (h.delivery_by === actor(store)) return;
  await store.record({
    entity_type: "hold",
    entity_id: id,
    type: "delivery_taken",
    actor_id: actor(store),
    payload: {},
  });
}

/**
 * Book or change how a hold an Outreach worker asked for is collected, for them (FR-HLD-61): in
 * person, or delivered at a time to a drop-off point (FR-HLD-15). The time goes on the log. The
 * drop-off point is saved beside it before the booking is recorded, as a handle is, so a sync that
 * runs at once takes both (FR-HLD-53).
 */
export async function bookCollection(store: Store, id: string, booking: CollectionBooking): Promise<void> {
  const h = liveHold(store, id);
  if (!h.requested) throw new Error("collection is booked only on a hold an Outreach worker asked for");
  if (booking.method === "delivery") {
    const place = tidyDropOff(booking.drop_off);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(booking.at)) throw new Error("pick a day and a time");
    const day = booking.at.slice(0, 10);
    if (day < today(store)) throw new Error("pick a day from today on");
    if (day > h.expires_on) throw new Error("the delivery is after the hold runs out; change the hold's date first");
    if (!place) throw new Error("say where it is dropped off");
    await store.setMeta({ pending_drop_offs: { ...store.meta.pending_drop_offs, [id]: place } });
  } else {
    await store.setMeta({
      pending_drop_offs: without(store.meta.pending_drop_offs, id),
      hold_drop_offs: without(store.meta.hold_drop_offs, id),
    });
  }
  await store.record({
    entity_type: "hold",
    entity_id: id,
    type: "collection_booked",
    actor_id: actor(store),
    payload: booking.method === "delivery" ? { method: "delivery", at: booking.at } : { method: "in_person" },
  });
}
