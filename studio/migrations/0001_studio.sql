CREATE TABLE IF NOT EXISTS connections (id INTEGER PRIMARY KEY CHECK(id=1), ciphertext TEXT NOT NULL, account_hash TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS owner_sessions (token_hash TEXT PRIMARY KEY, password_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS owner_sessions_expiry ON owner_sessions(expires_at);
CREATE TABLE IF NOT EXISTS widgets (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, agent_id TEXT NOT NULL, agent_name TEXT NOT NULL,
 config TEXT NOT NULL, allowed_origins TEXT NOT NULL DEFAULT '[]', published_config TEXT,
 published_origins TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1,
 published_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS previews (token_hash TEXT PRIMARY KEY, widget_id TEXT NOT NULL REFERENCES widgets(id), origin TEXT NOT NULL, config TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS previews_expiry ON previews(expires_at);
CREATE TABLE IF NOT EXISTS visitors (token_hash TEXT PRIMARY KEY, widget_id TEXT NOT NULL REFERENCES widgets(id), origin TEXT NOT NULL, preview_hash TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS visitors_expiry ON visitors(expires_at);
CREATE TABLE IF NOT EXISTS conversations (
 id TEXT PRIMARY KEY, visitor_hash TEXT NOT NULL REFERENCES visitors(token_hash), upstream_id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'idle', created_at INTEGER NOT NULL, lock_token TEXT, lock_until INTEGER NOT NULL DEFAULT 0,
 cancel_until INTEGER NOT NULL DEFAULT 0, active_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS conversations_visitor ON conversations(visitor_hash);
CREATE INDEX IF NOT EXISTS conversations_active ON conversations(active_until);
CREATE TABLE IF NOT EXISTS quotas (scope TEXT NOT NULL, bucket INTEGER NOT NULL, count INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(scope,bucket));
CREATE INDEX IF NOT EXISTS quotas_expiry ON quotas(expires_at);
