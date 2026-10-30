-- DNAFix initial schema (PostgreSQL 15+)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS github_installations (
  id TEXT PRIMARY KEY, installation_id BIGINT UNIQUE NOT NULL, account_login TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id), installation_id TEXT REFERENCES github_installations(id),
  github_owner TEXT, github_repo TEXT, local_path TEXT, default_branch TEXT, last_analyzed_commit_sha TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (github_owner, github_repo)
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id), state TEXT NOT NULL,
  issue_title TEXT NOT NULL, issue_body TEXT NOT NULL, issue_number INTEGER, base_ref TEXT NOT NULL,
  base_commit_sha TEXT, repository_snapshot_id TEXT, model_provider TEXT NOT NULL, workflow_engine TEXT NOT NULL,
  repair_attempts INTEGER NOT NULL DEFAULT 0, error TEXT, idempotency JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_runs_state ON workflow_runs(state);
CREATE TABLE IF NOT EXISTS repository_analysis_snapshots (
  id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id), base_commit_sha TEXT NOT NULL,
  analysis_version INTEGER, report JSONB NOT NULL, complete BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repository_id, base_commit_sha)
);
CREATE TABLE IF NOT EXISTS impact_reports (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id), snapshot_id TEXT REFERENCES repository_analysis_snapshots(id),
  report JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS implementation_plans (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(id), analysis JSONB NOT NULL, plan JSONB NOT NULL,
  approved_at TIMESTAMPTZ, approved_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id), task_id TEXT NOT NULL, status TEXT NOT NULL,
  worktree_id TEXT, changed_paths JSONB NOT NULL DEFAULT '[]', commit_sha TEXT, patch_summary TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (run_id, task_id)
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id), role TEXT NOT NULL, model TEXT NOT NULL,
  provider TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tool_invocations (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id), session_id TEXT REFERENCES agent_sessions(id),
  tool_name TEXT NOT NULL, input JSONB, output JSONB, result TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id), task_id TEXT, path TEXT NOT NULL UNIQUE,
  branch TEXT, base_commit_sha TEXT NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS verification_runs (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id), phase TEXT NOT NULL, checks JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pull_requests (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(id), github_number INTEGER, url TEXT,
  branch TEXT NOT NULL, draft BOOLEAN NOT NULL DEFAULT true, idempotency_key TEXT UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, run_id TEXT, repository_id TEXT, actor TEXT NOT NULL, action TEXT NOT NULL,
  result TEXT NOT NULL, evidence TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_events(run_id, created_at);
CREATE TABLE IF NOT EXISTS user_approvals (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id), kind TEXT NOT NULL, approved_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (run_id, kind)
);
