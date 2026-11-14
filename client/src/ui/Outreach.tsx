import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  type Api,
  ApiError,
  Offline,
  type OutreachHold,
  type OutreachHoldState,
  type OutreachItem,
  type OutreachItems,
} from "../lib/api";
import { DAY_MS } from "../lib/clock";
import { MAX_HANDLE } from "../lib/holds";
import { localDate } from "../lib/time";
import { Contact } from "./Contact";
import { Page } from "./Page";
import { PrivacyLink } from "./PrivacyLink";
import { RichText } from "./RichText";

/** How long a request runs when nobody picks a day: a week, as a hold placed by Staff does. */
const DEFAULT_DAYS = 7;

const STATES: Record<OutreachHoldState, string> = {
  waiting: "Waiting for approval",
  approved: "Approved",
  declined: "Declined",
  expired: "Expired",
  handed_out: "Handed out",
  put_back: "Put back into stock",
};

interface Props {
  api: Api;
  name: string;
  onSignOut: () => void;
  now?: () => number;
}

/**
 * All an Outreach worker sees (FR-USR-39): the items marked for them, where each is kept and how many
 * could be asked for (FR-VIS-09), and their own requests (FR-HLD-07). They ask for a hold here, and an
 * Administrator answers (FR-HLD-05, FR-HLD-06). Everything is read from the server each time and
 * nothing is kept on the device (FR-VIS-03), so it needs a connection.
 */
export function Outreach({ api, name, onSignOut, now = Date.now }: Props) {
  const [found, setFound] = useState<OutreachItems | null>(null);
  const [holds, setHolds] = useState<OutreachHold[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [asking, setAsking] = useState<string | null>(null);

  const failed = useCallback(
    (e: unknown) => {
      if (e instanceof Offline) setError("No connection. This page needs one.");
      // The session ended at the server: a role change, a revoked device, a deactivated account.
      else if (e instanceof ApiError && (e.status === 401 || e.code === "deactivated")) onSignOut();
      else setError(e instanceof Error ? e.message : String(e));
    },
    // onSignOut is made new on every render of the app.
    [],
  );

  const load = useCallback(async () => {
    const [items, mine] = await Promise.all([api.outreachItems(), api.outreachHolds()]);
    setFound(items.data);
    setHolds(mine.data.holds);
  }, [api]);

  useEffect(() => {
    load().catch(failed);
  }, [load, failed]);

  /** After a request or a moved date: say so, and read both lists again, since counts may have changed. */
  async function done(message: string) {
    setAsking(null);
    setError(null);
    setNotice(message);
    await load().catch(failed);
  }

  const signOut = (
    <button type="button" onClick={onSignOut}>
      Sign out
    </button>
  );
  const title = found?.group.name || "What is available";
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (found?.items ?? []).filter((it) => {
    const hay = `${it.name} ${it.categories.join(" ")} ${it.description}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });

  return (
    <div className="app">
      <Page title={title} actions={signOut}>
        <p className="muted small">Signed in as {name}, Outreach.</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="confirmed" role="status">
            {notice}
          </p>
        )}
        {!found && !error && <p className="muted">Loading…</p>}
        {found && (
          <>
            <MyHolds api={api} holds={holds} now={now} onMoved={done} onError={failed} />
            <h2 className="section">What is available</h2>
            <p>
              Ask for goods to be held for a client. Nothing is set aside until one of our Administrators approves the
              request.
            </p>
            {found.group.contact && (
              <p>
                <Contact contact={found.group.contact} />
              </p>
            )}
            {found.items.length === 0 ? (
              <p>Nothing is available right now.</p>
            ) : (
              <>
                {found.items.length > 8 && (
                  <input
                    type="search"
                    aria-label="Search what is available"
                    placeholder="Search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                )}
                {shown.length === 0 && <p>Nothing matches.</p>}
                <ul className="catalogue">
                  {shown.map((it) => (
                    <li key={it.id}>
                      <h3 className="item-title">{it.name}</h3>
                      <p className="small">
                        {it.available} available
                        {it.locations.length > 0 && ` · ${it.locations.join(", ")}`}
                      </p>
                      {it.categories.length > 0 && <p className="muted small">{it.categories.join(" · ")}</p>}
                      {it.photos.length > 0 && (
                        <div className="catalogue-photos">
                          {it.photos.map((id) => (
                            <OutreachPhoto key={id} api={api} id={id} alt={`Photo of ${it.name}`} />
                          ))}
                        </div>
                      )}
                      {it.description && (
                        <div className="description">
                          <RichText text={it.description} />
                        </div>
                      )}
                      {asking === it.id ? (
                        <RequestForm
                          api={api}
                          it={it}
                          now={now}
                          onDone={done}
                          onCancel={() => setAsking(null)}
                          onError={failed}
                        />
                      ) : (
                        <div className="row minors">
                          <button
                            type="button"
                            className="minor"
                            aria-label={`Ask for a hold on ${it.name}`}
                            onClick={() => {
                              setNotice(null);
                              setError(null);
                              setAsking(it.id);
                            }}
                          >
                            Ask for a hold…
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
        <PrivacyLink />
      </Page>
    </div>
  );
}

/** Who it is for, how many, and until when (FR-HLD-05). The handle is a nickname or initials and nothing more (FR-HLD-18). */
function RequestForm({
  api,
  it,
  now,
  onDone,
  onCancel,
  onError,
}: {
  api: Api;
  it: OutreachItem;
  now: () => number;
  onDone: (message: string) => Promise<void>;
  onCancel: () => void;
  onError: (e: unknown) => void;
}) {
  const today = localDate(now());
  const tomorrow = localDate(now() + DAY_MS);
  const [handle, setHandle] = useState("");
  const [count, setCount] = useState("1");
  const [until, setUntil] = useState(localDate(now() + DEFAULT_DAYS * DAY_MS));
  const [busy, setBusy] = useState(false);

  const n = Number(count.trim());
  const validCount = count.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= it.available;
  const ready = handle.trim() !== "" && until > today && validCount;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      await api.requestHold({
        item_id: it.id,
        count: n,
        expires_on: until,
        handle: handle.trim(),
      });
      await onDone(`Asked for ${n} × ${it.name}, until ${until}. An Administrator will answer.`);
    } catch (err) {
      onError(err);
      setBusy(false);
    }
  }

  return (
    <form className="hold-form" onSubmit={submit}>
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
      {it.available > 1 && (
        <label className="tight">
          <span>How many</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={it.available}
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
      <div className="row">
        <button type="submit" className="primary" disabled={busy || !ready}>
          Send request
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The worker's own requests and holds, and how each stands (FR-HLD-07). One still open can have its day moved (FR-HLD-21). */
function MyHolds({
  api,
  holds,
  now,
  onMoved,
  onError,
}: {
  api: Api;
  holds: OutreachHold[];
  now: () => number;
  onMoved: (message: string) => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const [moving, setMoving] = useState<string | null>(null);
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const today = localDate(now());
  const tomorrow = localDate(now() + DAY_MS);
  if (holds.length === 0) return null;

  async function move(h: OutreachHold) {
    if (busy) return;
    setBusy(true);
    try {
      await api.moveOutreachHold(h.id, until);
      setMoving(null);
      await onMoved(`${h.item} is now until ${until}.`);
    } catch (e) {
      onError(e);
    }
    setBusy(false);
  }

  return (
    <section aria-label="Your requests">
      <h2 className="section">Your requests</h2>
      <ul className="items">
        {holds.map((h) => {
          const open = h.state === "waiting" || h.state === "approved";
          return (
            <li key={h.id} className="request">
              <p>
                <span className="item-name">
                  {h.count > 1 ? `${h.count} × ` : ""}
                  {h.item}
                </span>
                <br />
                <span className="muted small">
                  {STATES[h.state]}
                  {h.for ? ` · for ${h.for}` : ""} · {open ? "until" : "was until"} {h.expires_on}
                </span>
              </p>
              {open &&
                (moving === h.id ? (
                  <form
                    className="row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void move(h);
                    }}
                  >
                    <label className="tight">
                      <span>Hold until</span>
                      <input type="date" min={tomorrow} value={until} onChange={(e) => setUntil(e.target.value)} />
                    </label>
                    <button type="submit" className="primary" disabled={busy || until <= today}>
                      Save date
                    </button>
                    <button type="button" onClick={() => setMoving(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <div className="row minors">
                    <button
                      type="button"
                      className="minor"
                      aria-label={`Change the date for ${h.item}`}
                      onClick={() => {
                        setUntil(h.expires_on);
                        setMoving(h.id);
                      }}
                    >
                      Change date
                    </button>
                  </div>
                ))}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** An <img> cannot send the bearer header, so the bytes are fetched and shown from memory. One that fails is left out. */
function OutreachPhoto({ api, id, alt }: { api: Api; id: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    let live = true;
    api.fetchOutreachPhoto(id).then(
      (blob) => {
        if (!live) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      },
      () => undefined,
    );
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [api, id]);
  return url ? <img src={url} alt={alt} /> : null;
}
