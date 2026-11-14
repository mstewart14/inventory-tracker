import { useEffect, useState } from "react";
import { type Api, Offline, type PublicCatalogue } from "../lib/api";
import { API_BASE } from "../lib/server";
import { Contact } from "./Contact";
import { Page } from "./Page";
import { PrivacyLink } from "./PrivacyLink";
import { RichText } from "./RichText";

/** Where a catalogue photo is fetched from. No sign-in: the server serves only photos of listed items (FR-VIS-05). */
export const cataloguePhotoUrl = (id: string): string => `${API_BASE}/public/photos/${id}`;

/**
 * What the society may be able to give, for anyone to read (FR-VIS-04). Each item's name, description
 * and photos, and nothing about how many there are or where they are kept (FR-VIS-05). Nothing can be
 * asked for here: the page says how to reach the society's staff, who arrange everything (FR-VIS-06,
 * FR-VIS-07). It needs a connection; nobody outside the society holds a copy of the inventory.
 */
export function Catalogue({ api, onSignIn }: { api: Api; onSignIn?: () => void }) {
  const [found, setFound] = useState<PublicCatalogue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    api.publicCatalogue().then(
      ({ data }) => live && setFound(data),
      (e: unknown) => {
        if (!live) return;
        if (e instanceof Offline) setError("No connection. This page needs one.");
        else setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [api]);

  const signIn = onSignIn && (
    <button type="button" onClick={onSignIn}>
      Staff sign in
    </button>
  );
  const title = found?.group.name || "What we have";

  if (error)
    return (
      <Frame title={title} actions={signIn}>
        <p className="error" role="alert">
          {error}
        </p>
      </Frame>
    );
  if (!found)
    return (
      <Frame title={title}>
        <p className="muted">Loading…</p>
      </Frame>
    );

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = found.items.filter((it) => {
    const hay = `${it.name} ${it.categories.join(" ")} ${it.description}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });

  return (
    <Frame title={title} actions={signIn}>
      <p>
        These are things we may be able to give. To ask for something, talk to our staff: come by in person, or get in
        touch. Nothing can be requested on this page.
      </p>
      {found.group.contact && (
        <p>
          <Contact contact={found.group.contact} />
        </p>
      )}
      {found.items.length === 0 ? (
        <p>Nothing is listed right now.</p>
      ) : (
        <>
          {found.items.length > 8 && (
            <input
              type="search"
              aria-label="Search what we have"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          {shown.length === 0 && <p>Nothing matches.</p>}
          <ul className="catalogue">
            {shown.map((it, i) => (
              <li key={`${it.name}-${i}`}>
                <h2 className="item-title">{it.name}</h2>
                {it.categories.length > 0 && <p className="muted small">{it.categories.join(" · ")}</p>}
                {it.photos.length > 0 && (
                  <div className="catalogue-photos">
                    {it.photos.map((id) => (
                      <img key={id} src={cataloguePhotoUrl(id)} alt={`Photo of ${it.name}`} loading="lazy" />
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
    </Frame>
  );
}

/** The app's frame without the app, as the found-item page has: no banner, no install prompt, no navigation. */
function Frame({ title, actions, children }: { title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="app">
      <Page title={title} actions={actions || undefined}>
        {children}
        <PrivacyLink />
      </Page>
    </div>
  );
}
