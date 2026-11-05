ALTER TABLE users ADD COLUMN disabled_at TEXT;

CREATE TABLE session_groups (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0,1))
);

ALTER TABLE sessions ADD COLUMN group_id TEXT REFERENCES session_groups(id);
INSERT INTO session_groups (id,user_id,device_name,created_at,legacy)
SELECT 'legacy:' || user_id,user_id,'升级前登录（可能包含多台设备）',MIN(created_at),1
FROM sessions GROUP BY user_id;
UPDATE sessions SET group_id='legacy:' || user_id;
CREATE INDEX idx_sessions_group ON sessions(group_id,revoked_at);
CREATE INDEX idx_session_groups_user ON session_groups(user_id,revoked_at);

CREATE TABLE household_invites (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL REFERENCES users(id),
    code_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    used_by TEXT REFERENCES users(id),
    revoked_at TEXT
);
CREATE INDEX idx_household_invites_household ON household_invites(household_id,created_at);
