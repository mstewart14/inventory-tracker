import { type FormEvent, useState } from "react";
import type { CollectionBooking } from "../lib/api";
import { MAX_DROP_OFF } from "../lib/holds";

interface Props {
  /** Makes the radio group's name unique on a page with several holds. */
  id: string;
  today: string;
  /** The hold's last day: a delivery is on or before it (FR-HLD-51). */
  expiresOn: string;
  booked: { collection?: "in_person" | "delivery" | null; delivery_at?: string | null; drop_off?: string | null };
  /** What "Delivered by…" says: an Outreach worker reads "our staff", Staff read "Staff". */
  deliveredBy: string;
  onSave: (booking: CollectionBooking) => Promise<void>;
  onCancel: () => void;
}

/**
 * How an approved hold is collected: in person, or delivered (FR-HLD-14). A delivery is a time, on or
 * before the hold's last day, and a drop-off point: a place to meet, and nothing about the client
 * (FR-HLD-15). The Outreach worker who asked fills this in, or Staff do for them (FR-HLD-61).
 */
export function CollectionForm({ id, today, expiresOn, booked, deliveredBy, onSave, onCancel }: Props) {
  const [method, setMethod] = useState<"in_person" | "delivery">(booked.collection ?? "in_person");
  const [at, setAt] = useState(booked.delivery_at ?? "");
  const [place, setPlace] = useState(booked.drop_off ?? "");
  const [busy, setBusy] = useState(false);
  const day = at.slice(0, 10);
  const validTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at) && day >= today && day <= expiresOn;
  const ready = method === "in_person" || (validTime && place.trim() !== "");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      await onSave(method === "in_person" ? { method } : { method, at: at.slice(0, 16), drop_off: place.trim() });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="hold-form" onSubmit={submit}>
      <fieldset className="categories">
        <legend>How will it be collected?</legend>
        <label className="check">
          <input
            type="radio"
            name={`collection-${id}`}
            checked={method === "in_person"}
            onChange={() => setMethod("in_person")}
          />
          <span>In person</span>
        </label>
        <label className="check">
          <input
            type="radio"
            name={`collection-${id}`}
            checked={method === "delivery"}
            onChange={() => setMethod("delivery")}
          />
          <span>{deliveredBy}</span>
        </label>
      </fieldset>
      {method === "delivery" && (
        <>
          <label className="tight">
            <span>Deliver at</span>
            <input
              type="datetime-local"
              min={`${today}T00:00`}
              max={`${expiresOn}T23:59`}
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </label>
          <label>
            <span>Drop-off point</span>
            <input
              type="text"
              maxLength={MAX_DROP_OFF}
              placeholder="A place to meet. No name, no room number"
              value={place}
              onChange={(e) => setPlace(e.target.value)}
            />
          </label>
          <p className="muted small">The delivery must be on or before {expiresOn}, the hold's last day.</p>
        </>
      )}
      <div className="row">
        <button type="submit" className="primary" disabled={busy || !ready}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
