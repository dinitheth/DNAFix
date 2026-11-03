-- DNAFix GitHub App user integration (OAuth connection, verified installations, issue provenance)
-- Tokens are stored only as AES-256-GCM ciphertext (v1.iv.tag.ciphertext); no plaintext credential column exists.

CREATE TABLE IF NOT EXISTS github_user_connections (
  id TEXT PRIMARY KEY,
  session_id TEXT UNIQUE NOT NULL,
  github_user_id BIGINT NOT NULL,
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  html_url TEXT NOT NULL,
  installation_id BIGINT,
  installation_account_login TEXT,
  installation_account_type TEXT,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT,
  access_token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  token_type TEXT NOT NULL DEFAULT 'bearer',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS github_user_connections_installation_idx
  ON github_user_connections (installation_id);

ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS github_installation_id BIGINT;

ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS github_installation_id BIGINT;

ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS issue_url TEXT;
