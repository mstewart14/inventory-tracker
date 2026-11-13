-- Who a hold is for (FR-HLD-02): a handle typed by staff, and the only thing the
-- system knows about a client (FR-HLD-18).
--
-- Not on the event log, on purpose. The log is append-only and kept for good,
-- and a handle must be removed once its hold has ended (FR-HLD-17). So the hold
-- is an entity on the log with no handle in it, and the handle is a row here,
-- deleted when the hold ends. Devices are sent the current rows with every
-- sync, which is how a deletion reaches them.
CREATE TABLE hold_handles (
    hold_id TEXT PRIMARY KEY,
    handle  TEXT NOT NULL CHECK (length(trim(handle)) > 0),
    set_by  TEXT NOT NULL,
    set_at  INTEGER NOT NULL
);
