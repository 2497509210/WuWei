CREATE TABLE item_quick_operations (
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    item_id TEXT NOT NULL REFERENCES items(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (household_id, operation_id)
);
