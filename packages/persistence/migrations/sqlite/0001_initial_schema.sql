-- DNAFix SQLite store, 0001. Single-host, multi-process (api + worker) source of truth.
--
-- Shape: queryable fields are real columns; the aggregate itself is carried in
-- payload_json so a RunRecord's nested values (tasks, waivers, idempotency keys)
-- are written and read as one unit. Child tables (verification_checks,
-- executions) are projections of that aggregate, written in the same
-- transaction, so they can be queried per row without ever diverging from it.
--
-- runs.version is the optimistic concurrency token: a writer that read revision
-- N can only write when the row still says N. Two zero-row updates mean two
-- processes raced, and neither may overwrite the other.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  local_path TEXT,
  github_owner TEXT,
  github_repo TEXT,
  default_branch TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS repositories_github_idx ON repositories(github_owner, github_repo);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
  state TEXT NOT NULL,
  repository_path TEXT NOT NULL,
  issue_number INTEGER,
  issue_title TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  pull_request_url TEXT,
  repair_attempts INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_repository_idx ON runs(repository_id);
CREATE INDEX IF NOT EXISTS runs_state_idx ON runs(state);
CREATE INDEX IF NOT EXISTS runs_created_idx ON runs(created_at DESC, id);

-- One row per executed or planned check, so a run's evidence can be queried
-- without loading every run.
CREATE TABLE IF NOT EXISTS verification_checks (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('baseline', 'final')),
  check_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  waived INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, phase, check_id)
);
CREATE INDEX IF NOT EXISTS verification_checks_status_idx ON verification_checks(status);

-- Remote (cloud) execution records projected from the run aggregate.
CREATE TABLE IF NOT EXISTS executions (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  index_number INTEGER NOT NULL,
  phase TEXT NOT NULL,
  provider TEXT NOT NULL,
  build_id TEXT,
  status TEXT NOT NULL,
  source_sha256 TEXT,
  containment_status TEXT,
  quarantined_at TEXT,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, index_number)
);
CREATE INDEX IF NOT EXISTS executions_provider_status_idx ON executions(provider, status);

CREATE TABLE IF NOT EXISTS github_connections (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  login TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_tool_permissions (
  connection_id TEXT NOT NULL,
  server_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  reviewed_level INTEGER,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (connection_id, server_name, tool_name)
);

CREATE TABLE IF NOT EXISTS mcp_server_permissions (
  connection_id TEXT NOT NULL,
  server_name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (connection_id, server_name)
);

CREATE TABLE IF NOT EXISTS mcp_run_grants (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  server_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  permission_level INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (run_id, connection_id, server_name, tool_name)
);

-- Approvals outlive the MCP connector they came from, so they do not cascade
-- with the run: a denied or expired approval is evidence and stays readable.
CREATE TABLE IF NOT EXISTS mcp_approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  server_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  permission_level INTEGER NOT NULL,
  correlation_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_approval_run_status_idx ON mcp_approvals(run_id, status);
CREATE INDEX IF NOT EXISTS mcp_approval_pending_idx ON mcp_approvals(status, expires_at);

CREATE TABLE IF NOT EXISTS mcp_invocations (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  run_id TEXT,
  server_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  agent TEXT NOT NULL,
  permission_level INTEGER NOT NULL,
  approval_status TEXT NOT NULL,
  executed INTEGER NOT NULL,
  success INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  duration_ms INTEGER,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_invocation_run_idx ON mcp_invocations(run_id, started_at DESC, id);
CREATE INDEX IF NOT EXISTS mcp_invocation_correlation_idx ON mcp_invocations(correlation_id);

-- Append-only. Ordered by rowid, never by created_at: two events in the same
-- millisecond must not replay out of order to the SSE stream.
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  repository_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_run_idx ON audit_events(run_id);
CREATE INDEX IF NOT EXISTS audit_repository_idx ON audit_events(repository_id);
