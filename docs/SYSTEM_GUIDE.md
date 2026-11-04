# DNAFix system guide

DNAFix is one connected workbench: an issue enters, Project DNA explains the repository, Muse Wonder plans, scoped coding agents patch in isolated worktrees, deterministic checks verify, an independent verifier reviews, and a human approves the draft PR. Every page in the UI is a view over that single pipeline — not a separate tool.

## The workflow (end to end)

1. **New Analysis** — pick a local repository or a Github repository/issue, describe the bug and acceptance criteria.
2. **Repository preparation** — the repo is cloned/registered and a clean worktree is created. Your working tree is never mutated.
3. **Baseline verification** — existing checks run first so pre-existing failures are known before any change.
4. **Project DNA analysis** — deterministic AST/dependency analysis maps impact. This is evidence, not model opinion.
5. **Planning** — Muse Wonder produces tasks with file scopes. A human approves the plan before coding starts.
6. **Coding** — one scoped agent per task, in its own worktree, with an optional Docker MCP evidence phase.
7. **Verification** — deterministic test/typecheck/lint runners are the authority. The verifier model only reviews evidence.
8. **Human review** — approve to create a **draft** PR, or finish as a local patch. DNAFix never merges.

Run states, stages, approvals and audit events are the same data shown on Overview, Runs, Run Detail and the notification bell.

## Pages

| Page | What it does |
|---|---|
| Overview | Counts and recent runs. Links into Runs, Repositories, Settings. |
| New Analysis | Start a run (local path or Github). Blocked states come from the notification bell. |
| Runs | Search/filter every run. Click a run for its workspace. |
| Run Detail | Pipeline stages, plan approval, clarification, coding tasks, verification, draft-PR approval, MCP approvals/activity, audit history. |
| Repositories | Repositories registered by runs, with run counts and latest-run links. |
| Connectors | Plugin directory: Github, Docker MCP, and Docker MCP Catalog servers. |
| Connectors / Github | Connect/disconnect the Github App account, install the App, jump to repository browsing. |
| Connectors / Docker MCP | Enable the connector, select a profile, connect, and manage server/tool permissions. |
| Settings | Live runtime values (model, Project DNA, execution, workflow) with refresh. Secrets never reach the browser. |
| Docs | This guide and the linked reference docs. |

## Notifications

The bell in the top bar is the single place issues surface: API offline, blocked readiness items (model key, Project DNA), pending MCP approvals, and failed/blocked runs. Each item links to where it is fixed. There are no separate readiness side panels.

## Connectors

### Github

Github App authentication (OAuth user token + installation token) is used for repository/issue import and draft PRs. Connect it on **Connectors → Github**. Tokens are encrypted at rest and never sent to the browser. Setup: `docs/GITHUB_APP_SETUP.md`.

### Docker MCP

Docker Desktop's MCP Toolkit is an optional evidence source for agents. DNAFix reads existing profiles and launches `docker mcp gateway run --profile <id> --transport stdio --block-secrets`. It never installs Docker, starts Docker Desktop, edits profiles, or installs servers. Full reference: `docs/MCP_CONNECTORS.md`.

Permission levels:

- **L1 Read-only** — no per-call approval. The verification agent only receives L1.
- **L2 Run-scoped** — first use in a run needs a human run grant.
- **L3 Host-wide / destructive** — every call needs its own approval. Denied calls never execute.

Unknown tools default to disabled L3 until a human reviews them. Tool output is untrusted data.

### Catalog servers

Postgres, Filesystem, Playwright, Stripe, Notion, Brave Search and others in the grid are Docker MCP Catalog servers. They are enabled inside a Docker Desktop MCP profile, then used through the Docker MCP connection above — they are not separate DNAFix plugins.

## Safety invariants

- Human approval before plan execution and before draft PR creation. Never auto-merge.
- Deterministic checks, not model claims, decide test outcomes.
- Coding tasks cannot exceed their approved file scope; deletions need explicit approval.
- MCP and model results are treated as untrusted; secrets are redacted before storage or display.
- No AWS resources outside ap-southeast-2; no billable provisioning without explicit approval.

## Reference docs

- `docs/ARCHITECTURE.md` — module layout and boundaries
- `docs/SECURITY.md` — trust boundaries and controls
- `docs/MODEL_INTEGRATION.md` — Muse Wonder endpoint and transport
- `docs/INTEGRATION_PROJECT_DNA.md` — Project DNA bridge
- `docs/GITHUB_APP_SETUP.md` — Github App registration and env
- `docs/MCP_CONNECTORS.md` — Docker MCP setup, permissions, approvals, API
- `docs/AWS_EXECUTION.md` — optional CodeBuild execution
- `docs/IMPLEMENTATION_STATUS.md` — verified vs blocked status
- `docs/adr/` — architecture decision records
