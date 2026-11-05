CREATE INDEX idx_items_household_active_order
    ON items(household_id, archived_at, updated_at DESC, name, id);
CREATE INDEX idx_items_household_location_status_order
    ON items(household_id, location_status, archived_at, updated_at DESC, name, id);
