/**
 * PostgreSQL schema (Drizzle ORM) for production persistence.
 * The runnable local store is SqliteStore (see ./sqlite-store.ts); this schema and
 * migrations/0001_initial.sql define the production relational model.
 * Kept dependency-light: table definitions are expressed as SQL in the
 * migration, which is the source of truth applied by `pnpm db:migrate`.
 */
export const TABLES = [
  "users",
  "github_installations",
  "github_user_connections",
  "repositories",
  "workflow_runs",
  "repository_analysis_snapshots",
  "impact_reports",
  "implementation_plans",
  "agent_tasks",
  "agent_sessions",
  "tool_invocations",
  "worktrees",
  "verification_runs",
  "pull_requests",
  "audit_events",
  "user_approvals",
] as const;
export type TableName = (typeof TABLES)[number];
