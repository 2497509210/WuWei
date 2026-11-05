ALTER TABLE items ADD COLUMN aliases_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE items ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE items ADD COLUMN location_status TEXT NOT NULL DEFAULT 'confirmed' CHECK (location_status IN ('confirmed', 'missing'));
ALTER TABLE items ADD COLUMN last_confirmed_at TEXT;
ALTER TABLE containers ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE item_batch_operations (
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    item_ids_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (household_id, operation_id)
);
