import { useState } from "react";
import { DAY_MS } from "../lib/clock";
import {
  approveHold,
  available,
  bookCollection,
  declineHold,
  deliveries,
  deliveryTime,
  dropOffFor,
  extendHold,
  freeFor,
  handleFor,
  handOutHold,
  type Hold,
  holds,
  holdState,
  isLive,
  isWaiting,
  liveHolds,
  MAX_HANDLE,
  placeHold,
  putBackHold,
  takeDelivery,
  today,
  waitingHolds,
} from "../lib/holds";
import { isPool, type Item, nameOf, resolveItem } from "../lib/inventory";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { localDate } from "../lib/time";
import { useStore } from "../useStore";
import { CollectionForm } from "./CollectionForm";
import { plural, userName } from "./labels";
import { Page } from "./Page";

/** How long a hold runs when nobody picks a day: a week. Every hold still has a day (FR-HLD-03). */
const DEFAULT_DAYS = 7;

/** How long an ended hold stays on the Holds screen, so the people named on it see what became of it (FR-HLD-13). */
const SHOWN_ENDED_MS = 14 * DAY_MS;

/** "3 for JD · until 2026-11-20". A hold whose handle this device does not hold reads "for someone". */
export function holdLabel(store: Store, h: Hold): string {
  const who = handleFor(store, h.id) ?? "someone";
  return `${h.count != null ? `${h.count} for` : "For"} ${who} · until ${h.expires_on}`;
}

/** How a hold is to be collected, once an Outreach worker has booked it (FR-HLD-14). Empty until then. */
export function collectionLabel(store: Store, h: Hold): string {
  if (h.collection === "in_person") return "Collected in person";
  if (h.collection !== "delivery") return "";
  const where = dropOffFor(store, h.id);
  const who = h.delivery_by ? `${userName(store.state, h.delivery_by)} is delivering` : "nobody has taken it";
  return `Delivery ${deliveryTime(h.delivery_at)}${where ? ` · to ${where}` : ""} · ${who}`;
}

const ENDED: Record<string, string> = {
  put_back: "Put back",
  handed_out: "Handed out",
  expired: "Expired",
  declined: "Declined",
};

/**
 * The holds on one item, and the form that places one (FR-HLD-01). It sits with the buttons that
 * move the item, on its page and on a scan card, so held goods are handed to the person they are
 * for in one tap (FR-HLD-16).
 */
export function ItemHolds({ store, it, onDone }: { store: Store; it: Item; onDone: (message: string) => void }) {
  useStore(store);
  const day = today(store);
  const mine = liveHolds(store.state, day, it.id);
  const free = available(store.state, it, day);
  const pool = isPool(it);
  const tomorrow = localDate(store.now() + DAY_MS);
  const [placing, setPlacing] = useState(false);
  const [handle, setHandle] = useState("");
  const [count, setCount] = useState("1");
  const [until, setUntil] = useState("");
  const [moving, setMoving] = useState<string | null>(null);
  const [booking, setBooking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = nameOf(store.state, it.id);

  async function run(act: () => Promise<unknown>, message: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await act();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record it");
      setBusy(false);
      return;
    }
    setBusy(false);
    setPlacing(false);
    setMoving(null);
    setBooking(null);
    onDone(message);
  }

  function open() {
    setHandle("");
    setCount("1");
    setUntil(localDate(store.now() + DEFAULT_DAYS * DAY_MS));
    setError(null);
    setPlacing(true);
  }

  const n = Number(count.trim());
  const validCount = !pool || (count.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= free);
  const canPlace = handle.trim() !== "" && until > day && validCount;

  if (mine.length === 0 && (free === 0 || it.merged_into)) return null;

  return (
    <section className="holds" aria-label="Holds">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {mine.map((h) => (
        <div className="hold" key={h.id}>
          <p className="notice" role="note">
            On hold · {holdLabel(store, h)}
            {h.collection && (
              <>
                <br />
                {collectionLabel(store, h)}
              </>
            )}
          </p>
          {booking === h.id ? (
            <CollectionForm
              id={h.id}
              today={day}
              expiresOn={h.expires_on}
              booked={{ collection: h.collection, delivery_at: h.delivery_at, drop_off: dropOffFor(store, h.id) }}
              deliveredBy="Delivered by Staff"
              onCancel={() => setBooking(null)}
              onSave={(body) =>
                run(
                  () => bookCollection(store, h.id, body),
                  body.method === "delivery"
                    ? `Delivery booked for ${deliveryTime(body.at)} · ${name}`
                    : `To be collected in person · ${name}`,
                )
              }
            />
          ) : moving === h.id ? (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => extendHold(store, h.id, until), `Hold now runs until ${until} · ${name}`);
              }}
            >
              <label className="tight">
                <span>Hold until</span>
                <input type="date" min={tomorrow} value={until} onChange={(e) => setUntil(e.target.value)} />
              </label>
              <button type="submit" className="primary" disabled={busy || until <= day}>
                Save date
              </button>
              <button type="button" onClick={() => setMoving(null)}>
                Cancel
              </button>
            </form>
          ) : (
            <div className="row">
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => handOutHold(store, h.id),
                    `Handed out${h.count != null ? ` ${h.count}` : ""} from a hold · ${name}`,
                  )
                }
              >
                Hand out to {handleFor(store, h.id) ?? "them"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setUntil(h.expires_on);
                  setError(null);
                  setMoving(h.id);
                }}
              >
                Change date
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => putBackHold(store, h.id), `Hold put back · ${name}`)}
              >
                Put back
              </button>
              {h.requested && (
                // The Outreach worker who asked books this themselves; Staff can do it for them (FR-HLD-61).
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setBooking(h.id);
                  }}
                >
                  {h.collection ? "Change collection" : "Book collection…"}
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      {placing ? (
        <form
          className="hold-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canPlace) return;
            void run(
              () =>
                placeHold(store, {
                  item_id: it.id,
                  handle,
                  expires_on: until,
                  ...(pool ? { count: n } : {}),
                }),
              `On hold${pool ? ` · ${n}` : ""} until ${until} · ${name}`,
            );
          }}
        >
          <label>
            <span>Hold for</span>
            <input
              type="text"
              autoFocus
              maxLength={MAX_HANDLE}
              placeholder="A nickname or initials, nothing more"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
            />
          </label>
          {pool && (
            <label className="tight">
              <span>How many to hold</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={free}
                step={1}
                value={count}
                onChange={(e) => setCount(e.target.value)}
              />
            </label>
          )}
          <label className="tight">
            <span>Hold until</span>
            <input type="date" min={tomorrow} value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
          {pool && <p className="muted small">{free} free to hold</p>}
          <div className="row">
            <button type="submit" className="primary" disabled={busy || !canPlace}>
              Place hold
            </button>
            <button type="button" onClick={() => setPlacing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        free > 0 &&
        !it.merged_into && (
          <div className="row minors">
            <button type="button" className="minor" disabled={busy} onClick={open}>
              Hold for someone…
            </button>
          </div>
        )
      )}
    </section>
  );
}

/** Every hold in force, soonest to run out first, and what became of those that ended lately (FR-HLD-13). */
export function Holds({ store }: { store: Store }) {
  useStore(store);
  const day = today(store);
  const all = holds(store.state);
  const live = all.filter((h) => isLive(h, day));
  const since = store.now() - SHOWN_ENDED_MS;
  const ended = all
    .filter(
      (h) => !isLive(h, day) && !isWaiting(h, day) && (h.ended_at ?? Date.parse(`${h.expires_on}T23:59:59`)) >= since,
    )
    .reverse();
  const open = (h: Hold) => navigate(`/items/${resolveItem(store.state, h.item_id)}`);
  return (
    <Page title="Holds" back="/">
      <Requests store={store} />
      <Deliveries store={store} />
      {live.length === 0 ? (
        <p>Nothing is on hold.</p>
      ) : (
        <>
          <p className="muted small">{plural(live.length, "hold")}</p>
          <ul className="items">
            {live.map((h) => (
              <li key={h.id}>
                <button className="item" type="button" onClick={() => open(h)}>
                  <span className="item-name">{nameOf(store.state, h.item_id)}</span>
                  <span className="muted small">
                    {holdLabel(store, h)} · placed by {userName(store.state, h.created_by)}
                    {h.collection === "in_person" && " · collected in person"}
                    {h.collection === "delivery" && " · delivery"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {ended.length > 0 && (
        <section aria-label="Ended lately">
          <h2 className="section">Ended in the last two weeks</h2>
          <ul className="items">
            {ended.map((h) => (
              <li key={h.id}>
                <button className="item" type="button" onClick={() => open(h)}>
                  <span className="item-name">{nameOf(store.state, h.item_id)}</span>
                  <span className="muted small">
                    {ENDED[holdState(h, day)]}
                    {h.count != null ? ` · ${h.count}` : ""} · was until {h.expires_on} · placed by{" "}
                    {userName(store.state, h.created_by)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Page>
  );
}

/**
 * Requests from Outreach workers that nobody has answered (FR-HLD-05). Staff see them; only an
 * Administrator approves or declines (FR-HLD-06). A request sets nothing aside, so one that asks
 * for more than is free now cannot be approved until goods are freed.
 */
function Requests({ store }: { store: Store }) {
  const day = today(store);
  const waiting = waitingHolds(store.state, day);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (waiting.length === 0) return null;

  async function run(act: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await act();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record it");
    }
    setBusy(false);
  }

  return (
    <section aria-label="Requests waiting for approval">
      <h2 className="section">Waiting for approval</h2>
      {!store.admin && <p className="muted small">An Administrator approves or declines these.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="items">
        {waiting.map((h) => {
          const name = nameOf(store.state, h.item_id);
          const free = freeFor(store, h);
          const short = (h.count ?? 1) > free;
          return (
            <li key={h.id} className="request">
              <button
                className="item"
                type="button"
                onClick={() => navigate(`/items/${resolveItem(store.state, h.item_id)}`)}
              >
                <span className="item-name">{name}</span>
                <span className="muted small">
                  {holdLabel(store, h)} · requested by {userName(store.state, h.created_by)}
                </span>
              </button>
              {short && (
                <p className="notice" role="note">
                  {free === 0 ? "None are free to hold now." : `Only ${free} free to hold now.`}
                </p>
              )}
              {store.admin && (
                <div className="row">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || short}
                    aria-label={`Approve the request for ${name}`}
                    onClick={() => void run(() => approveHold(store, h.id))}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Decline the request for ${name}`}
                    onClick={() => void run(() => declineHold(store, h.id))}
                  >
                    Decline
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Deliveries Outreach workers have booked, soonest first (FR-HLD-24). A delivery is a time and a
 * drop-off point (FR-HLD-15). Any Staff member or Administrator takes one, and is then named on the
 * hold (FR-HLD-25); taking one someone else has takes it over. The goods are handed out from the
 * item's page when the delivery is made.
 */
function Deliveries({ store }: { store: Store }) {
  const booked = deliveries(store.state, today(store));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (booked.length === 0) return null;
  const me = store.meta.user?.id;

  async function take(id: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await takeDelivery(store, id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record it");
    }
    setBusy(false);
  }

  return (
    <section aria-label="Deliveries">
      <h2 className="section">Deliveries</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="items">
        {booked.map((h) => {
          const name = nameOf(store.state, h.item_id);
          const where = dropOffFor(store, h.id);
          return (
            <li key={h.id} className="request">
              <button
                className="item"
                type="button"
                onClick={() => navigate(`/items/${resolveItem(store.state, h.item_id)}`)}
              >
                <span className="item-name">
                  {h.count != null ? `${h.count} × ` : ""}
                  {name}
                </span>
                <span className="muted small">
                  {deliveryTime(h.delivery_at)} · to {where ?? "a drop-off point not yet synced"} · for{" "}
                  {handleFor(store, h.id) ?? "someone"} · booked by {userName(store.state, h.created_by)}
                </span>
              </button>
              {h.delivery_by === me ? (
                <p className="notice" role="note">
                  You are delivering this.
                </p>
              ) : (
                <div className="row">
                  {h.delivery_by && (
                    <span className="muted small">{userName(store.state, h.delivery_by)} is delivering this.</span>
                  )}
                  <button
                    type="button"
                    className={h.delivery_by ? undefined : "primary"}
                    disabled={busy}
                    aria-label={`${h.delivery_by ? "Take over" : "Take"} the delivery of ${name}`}
                    onClick={() => void take(h.id)}
                  >
                    {h.delivery_by ? "Take over" : "I will deliver it"}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
