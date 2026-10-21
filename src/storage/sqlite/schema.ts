export const SQLITE_SCHEMA_VERSION = 4;

export const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE, data TEXT NOT NULL, body_hash TEXT);
CREATE TABLE IF NOT EXISTS node_body (hash TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS edges (position INTEGER PRIMARY KEY, data TEXT NOT NULL, from_id TEXT, to_id TEXT, edge_type TEXT);
CREATE TABLE IF NOT EXISTS initiatives (name TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS log (position INTEGER PRIMARY KEY, data TEXT NOT NULL, from_revision INTEGER, state_revision INTEGER, delta TEXT);
CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
`;

export const SQLITE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_edges_from_type_position ON edges (from_id, edge_type, position);
CREATE INDEX IF NOT EXISTS idx_edges_to_type_position ON edges (to_id, edge_type, position);
CREATE INDEX IF NOT EXISTS idx_edges_identity ON edges (from_id, to_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_log_state_revision_position ON log (state_revision, position);
CREATE INDEX IF NOT EXISTS idx_nodes_count_fields_position ON nodes (json_extract(data, '$.kind'), json_extract(data, '$.subkind'), json_extract(data, '$.status'), position);
CREATE INDEX IF NOT EXISTS idx_nodes_count_subkind_position ON nodes (json_extract(data, '$.subkind'), position);
CREATE INDEX IF NOT EXISTS idx_nodes_count_status_position ON nodes (json_extract(data, '$.status'), position);
CREATE INDEX IF NOT EXISTS idx_nodes_count_subkind_status_position ON nodes (json_extract(data, '$.subkind'), json_extract(data, '$.status'), position);
`;

export const SQLITE_PRAGMAS = `
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
`;
