import { useEffect, useState } from "react";
import { type Api, ApiError, Offline, type OutreachItems } from "../lib/api";
import { Contact } from "./Contact";
import { Page } from "./Page";
import { PrivacyLink } from "./PrivacyLink";
import { RichText } from "./RichText";

/**
 * All an Outreach worker sees (FR-USR-39): the items marked for them, where each is kept and how many
 * could be asked for (FR-VIS-09). It is read from the server each time and nothing is kept on the
 * device (FR-VIS-03), so it needs a connection.
 */
export function Outreach({ api, name, onSignOut }: { api: Api; name: string; onSignOut: () => void }) {
  const [found, setFound] = useState<OutreachItems | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    api.outreachItems().then(
      ({ data }) => live && setFound(data),
      (e: unknown) => {
        if (!live) return;
        if (e instanceof Offline) setError("No connection. This page needs one.");
        // The session ended at the server: a role change, a revoked device, a deactivated account.
        else if (e instanceof ApiError && (e.status === 401 || e.code === "deactivated")) onSignOut();
        else setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      live = false;
    };
    // onSignOut is made new on every render of the app; the read happens once.
  }, [api]);

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
        {!found && !error && <p className="muted">Loading…</p>}
        {found && (
          <>
            <p>These are the goods you can ask us to hold for a client. To ask, talk to our staff for now.</p>
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
                      <h2 className="item-title">{it.name}</h2>
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
