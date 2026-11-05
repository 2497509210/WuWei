CREATE TABLE item_bulk_operations (
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    item_ids_json TEXT NOT NULL,
    processed INTEGER NOT NULL,
    changed INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (household_id, operation_id)
);
