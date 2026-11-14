-- Where a delivery is dropped off (FR-HLD-15): a few words typed by the Outreach
-- worker who booked it.
--
-- Not on the event log, for the reason a handle is not (0015). A drop-off point
-- can say where a client will be, the log is kept for good, and this must go
-- when the hold ends (FR-HLD-53). The log records that a delivery was booked
-- and when; the place is a row here, deleted with the hold's handle. Devices are
-- sent the current rows with every sync, which is how a deletion reaches them.
CREATE TABLE hold_drop_offs (
    hold_id TEXT PRIMARY KEY,
    place   TEXT NOT NULL CHECK (length(trim(place)) > 0),
    set_by  TEXT NOT NULL,
    set_at  INTEGER NOT NULL
);
