export const SQLITE_SCHEMA_VERSION = 4;

export const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE, data TEXT NOT NULL, body_hash TEXT);
CREATE TABLE IF NOT EXISTS node_body (hash TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS edges (position INTEGER PRIMARY KEY, data TEXT NOT NULL, from_id TEXT, to_id TEXT, edge_type TEXT);
CREATE TABLE IF NOT EXISTS initiatives (name TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS log (position INTEGER PRIMARY KEY, data TEXT NOT NULL, from_revision INTEGER, state_revision INTEGER, delta TEXT);
CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS edge_validation_edge_insert AFTER INSERT ON edges BEGIN
  UPDATE sync_state SET value = value + 1 WHERE key = 'edge_validation_epoch';
END;
CREATE TRIGGER IF NOT EXISTS edge_validation_edge_delete AFTER DELETE ON edges BEGIN
  UPDATE sync_state SET value = value + 1 WHERE key = 'edge_validation_epoch';
END;
CREATE TRIGGER IF NOT EXISTS edge_validation_edge_update AFTER UPDATE OF position, data, from_id, to_id, edge_type ON edges BEGIN
  UPDATE sync_state SET value = value + 1 WHERE key = 'edge_validation_epoch';
END;
CREATE TRIGGER IF NOT EXISTS edge_validation_node_insert AFTER INSERT ON nodes BEGIN
  UPDATE sync_state SET value = value + 1 WHERE key = 'edge_validation_epoch';
END;
CREATE TRIGGER IF NOT EXISTS edge_validation_node_delete AFTER DELETE ON nodes BEGIN
  UPDATE sync_state SET value = value + 1 WHERE key = 'edge_validation_epoch';
END;
CREATE TRIGGER IF NOT EXISTS edge_validation_node_update AFTER UPDATE OF id, data ON nodes
WHEN OLD.id IS NOT NEW.id OR CASE
  WHEN json_valid(OLD.data) AND json_valid(NEW.data)
  THEN json_type(OLD.data) IS NOT json_type(NEW.data)
    OR json_type(OLD.data, '$.kind') IS NOT json_type(NEW.data, '$.kind')
    OR json_extract(OLD.data, '$.kind') IS NOT json_extract(NEW.data, '$.kind')
    OR json_type(OLD.data, '$.subkind') IS NOT json_type(NEW.data, '$.subkind')
    OR json_extract(OLD.data, '$.subkind') IS NOT json_extract(NEW.data, '$.subkind')
    OR (CASE WHEN json_type(OLD.data) IN ('null', 'false')
      OR (json_type(OLD.data) IN ('integer', 'real') AND json_extract(OLD.data, '$') = 0)
      OR (json_type(OLD.data) = 'text' AND json_extract(OLD.data, '$') = '') THEN 0 ELSE 1 END)
      IS NOT (CASE WHEN json_type(NEW.data) IN ('null', 'false')
        OR (json_type(NEW.data) IN ('integer', 'real') AND json_extract(NEW.data, '$') = 0)
        OR (json_type(NEW.data) = 'text' AND json_extract(NEW.data, '$') = '') THEN 0 ELSE 1 END)
  ELSE 1
END
BEGIN
  UPDATE sync_state SET value = value + 1 WHERE key = 'edge_validation_epoch';
END;
CREATE TRIGGER IF NOT EXISTS edge_validation_log_invalid_insert AFTER INSERT ON log
WHEN json_valid(NEW.data) = 0
BEGIN
  UPDATE sync_state SET value = value + 1 WHERE key = 'edge_validation_epoch';
END;
CREATE TRIGGER IF NOT EXISTS edge_validation_log_invalid_update AFTER UPDATE OF data ON log
WHEN json_valid(OLD.data) = 0 OR json_valid(NEW.data) = 0
BEGIN
  UPDATE sync_state SET value = value + 1 WHERE key = 'edge_validation_epoch';
END;
CREATE TRIGGER IF NOT EXISTS edge_validation_log_invalid_delete AFTER DELETE ON log
WHEN json_valid(OLD.data) = 0
BEGIN
  UPDATE sync_state SET value = value + 1 WHERE key = 'edge_validation_epoch';
END;
`;

export const SQLITE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_edges_from_type_position ON edges (from_id, edge_type, position);
CREATE INDEX IF NOT EXISTS idx_edges_to_type_position ON edges (to_id, edge_type, position);
CREATE INDEX IF NOT EXISTS idx_edges_identity ON edges (from_id, to_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_json_fields ON edges (json_type(data), json_type(data, '$.from'), json_extract(data, '$.from'), json_type(data, '$.to'), json_extract(data, '$.to'), json_type(data, '$.type'), json_extract(data, '$.type'), from_id, to_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_nodes_id_shape_kind ON nodes (id, json_type(data), json_extract(data, '$'), json_type(data, '$.kind'), json_extract(data, '$.kind'));
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
