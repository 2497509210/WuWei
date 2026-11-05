ALTER TABLE items ADD COLUMN archived_at TEXT;
ALTER TABLE items ADD COLUMN archive_reason TEXT;
ALTER TABLE items ADD COLUMN archived_location_json TEXT;

ALTER TABLE compartments ADD COLUMN custom_name TEXT;
ALTER TABLE compartments ADD COLUMN default_name TEXT NOT NULL DEFAULT '';
UPDATE compartments SET default_name = name;

ALTER TABLE item_events ADD COLUMN event_type TEXT NOT NULL DEFAULT 'move';
ALTER TABLE item_events ADD COLUMN actor_name TEXT;
ALTER TABLE item_events ADD COLUMN from_path_json TEXT;
ALTER TABLE item_events ADD COLUMN to_path_json TEXT;
ALTER TABLE item_events ADD COLUMN changes_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE item_events ADD COLUMN item_version INTEGER;
ALTER TABLE item_events ADD COLUMN legacy INTEGER NOT NULL DEFAULT 1;

CREATE INDEX idx_item_events_history ON item_events(item_id, item_version DESC, created_at DESC);
CREATE INDEX idx_items_household_archive ON items(household_id, archived_at);
