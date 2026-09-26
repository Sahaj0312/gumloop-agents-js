CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  access_hash TEXT UNIQUE,
  account_hash TEXT,
  connection_disabled INTEGER NOT NULL DEFAULT 0,
  connection_version INTEGER NOT NULL DEFAULT 0,
  connection_nonce TEXT,
  created_at INTEGER NOT NULL
);
INSERT INTO workspaces(id,name,account_hash,created_at)
VALUES('owner','My workspace',(SELECT account_hash FROM connections WHERE id=1),unixepoch()*1000);

ALTER TABLE connections RENAME TO legacy_connections;
CREATE TABLE connections (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  ciphertext TEXT NOT NULL,
  encryption_version INTEGER NOT NULL DEFAULT 2,
  updated_at INTEGER NOT NULL
);
INSERT INTO connections(workspace_id,ciphertext,encryption_version,updated_at)
SELECT 'owner',ciphertext,1,updated_at FROM legacy_connections WHERE id=1;
DROP TABLE legacy_connections;

ALTER TABLE owner_sessions ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'owner';
CREATE INDEX owner_sessions_workspace ON owner_sessions(workspace_id);
ALTER TABLE widgets ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'owner';
CREATE INDEX widgets_workspace ON widgets(workspace_id);
CREATE INDEX visitors_widget ON visitors(widget_id);
