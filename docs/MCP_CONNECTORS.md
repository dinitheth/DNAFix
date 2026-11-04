# MCP connectors

DNAFix can use **Docker Desktop's MCP Toolkit** as an optional source of external tools during coding and verification. The connector is read-only toward Docker itself: DNAFix lists and selects existing profiles, then launches the documented gateway command. It never installs MCP servers, edits profiles, enables Docker beta features, or starts Docker Desktop.

MCP access is deliberately separate from GitHub App authentication. Connecting or disconnecting Docker MCP does not change the GitHub session, and MCP tools cannot use GitHub credentials.

---

## 1. What the connector is

| Concern | Behaviour |
|---|---|
| Where it appears | Top-level **Connectors** page → **MCP Connection — Docker Desktop**, plus MCP cards on a run's detail page |
| Transport | stdio child process: `docker mcp gateway run --profile <id> --transport stdio --block-secrets` |
| Protocol | Official MCP TypeScript SDK `@modelcontextprotocol/sdk` **1.32.2** (`Client` + `StdioClientTransport`) |
| Default state | Connector disabled for DNAFix; no profile selected; no child process |
| Connected state | Only after a real MCP `initialize` handshake and successful discovery |
| Inventory | Actual servers, tools, input schemas, resources, and prompts reported by the gateway |
| Permissions | Per-server and per-tool, DNAFix-side, independent of enablement |
| Approval | Level 2 run grant; Level 3 per-call human approval |
| Audit | Every invocation, approval decision, inventory change, and phase warning |
| Build sandbox | Unrelated. MCP is **not** the DNAFix `ExecutionProvider` and does not execute builds or tests |

The UI labels the inventory **Live gateway** only when the handshake succeeded. It never injects mock servers, tools, or tool counts; automated tests use mocked clients and are not shown as live data.

---

## 2. Prerequisites

1. **Docker Desktop is installed and running.** DNAFix refuses to start it. If Desktop is stopped, the connector reports the exact reason and stops before listing profiles.
2. **Docker CLI** is available on `PATH`, or `DNAFIX_DOCKER_PATH` points at a real `docker` executable.
3. **Docker MCP Toolkit is enabled** in Docker Desktop and exposes the `docker mcp` CLI plus `docker mcp gateway`.
4. **At least one MCP profile already exists.** Profiles are created and edited in Docker Desktop, not in DNAFix.

DNAFix checks these with read-only commands:

| Check | Command |
|---|---|
| Docker CLI version | `docker --version` |
| Docker Desktop | `docker desktop version` |
| Desktop running | `docker desktop status --format json` |
| MCP CLI | `docker mcp version` |
| Toolkit feature state | `docker mcp feature ls --format json` |
| Gateway availability | `docker mcp gateway --help` |
| Profiles | `docker mcp profile ls --format json` |
| Selected profile detail | `docker mcp profile show <profile-id> --format json` |

No `profile create`, `profile server add`, `server enable`, `tools enable`, or other mutating command is ever issued. Profile IDs are validated server-side against `^[A-Za-z0-9][A-Za-z0-9._-]*$` (max 64 characters) and must exist in Docker's own profile list before selection.

### Executable and environment rules

- Args are passed as an argv array through `execFile`/`spawn`; there is **no shell**, no string interpolation, and no `shell: true`.
- `.cmd` / `.bat` shims are refused because spawning them correctly would require a shell. Point `DNAFIX_DOCKER_PATH` at the real executable instead.
- The gateway child receives an **allowlist** of environment variables only: `PATH`, `HOME`, `USERPROFILE`, `SystemRoot`, `WINDIR`, `TEMP`, `TMP`, `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`, `PROGRAMFILES`, `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, and `DOCKER_TLS_VERIFY`.
- DNAFix model keys, GitHub credentials, AWS credentials, and all other secrets are never forwarded to the gateway.

---

## 3. Enabling and connecting

1. Open **Connectors**.
2. Leave integrations (GitHub) as they are; GitHub auth is separate.
3. Turn on **Enable Docker MCP connector for DNAFix**. This only changes DNAFix's own record.
4. Click **Re-check Docker** if detection is stale.
5. Choose a profile from the list Docker actually reports.
6. Click **Connect**.

Connection states and their exact meaning:

| State | Meaning |
|---|---|
| `disabled` | Connector turned off in DNAFix; no connection attempt allowed |
| `not-detected` | Host, Docker CLI, or Docker Desktop not usable; reason is shown |
| `not-configured` | Enabled, but no valid profile selected |
| `connecting` | Child process starting / MCP handshake in flight |
| `connected` | Handshake **and** discovery succeeded |
| `not-connected` | Enabled and configured, but no live session |
| `authentication-required` | Docker/Toolkit needs the user to sign in or authorise |
| `connection-error` | Spawn, handshake, discovery, or gateway exit failed; exact reason retained |

A successful TCP/CLI check is never treated as connected. `connected` is set only after the SDK client has completed initialization and the gateway identity is known. If the child exits later, the state becomes `connection-error` with the exit reason, and optionally a bounded exponential reconnect is attempted (1s, 2s, … capped at 10s) when auto-reconnect is enabled.

Disconnect, profile changes, and API shutdown close the child process and abort run-scoped work. Reconnect creates a fresh session rather than reusing a dead one.

---

## 4. Inventory and model-facing tool names

After the handshake, DNAFix discovers:

- tools, grouped by server;
- each tool's description, JSON input schema, and parameter summary;
- MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) where present;
- resources and prompts;
- the gateway's server name, version, instructions, and capabilities.

Tools are associated with a server using the gateway metadata, the selected profile's server list, or a normalised name prefix. Discovery is paginated and bounded by a timeout. The inventory has a fingerprint; a change is audited as `mcp.inventory.changed` with added/removed tool names. **Refresh inventory** re-reads it; tools that disappeared stop being offered.

The exact MCP tool name is preserved in the UI and audit records. The model receives a stable, sanitized function name:

```text
mcp_<server>_<tool>_<8-char-sha256>
```

Example: `mcp_docker_list_containers_1a2b3c4d`. Names are limited to 64 characters and match `^[A-Za-z0-9_-]{1,64}$`.

A tool whose input schema cannot be compiled by Ajv is marked `schemaValid: false` and is never exposed to an agent, even if a permission record exists.

---

## 5. Permission model

Connection enablement, server enablement, tool enablement, and agent scoping are separate controls.

| Level | Name | Intended scope | Human approval |
|---|---|---|---|
| 1 | Read-only | Listing, inspecting, reading | None per call, provided the tool and server are enabled |
| 2 | Workspace / run-scoped | Changes confined to the current DNAFix run and its workspace | First use per run creates a **run-grant** approval; once approved, later calls in that run may reuse the grant |
| 3 | Destructive / host-wide | Removal, pruning, host/global changes, unreviewed tools | **Every call** creates a fresh **per-call** approval tied to that invocation |

Levels come from an explicit reviewed policy keyed by server and tool name. Free-text tool descriptions are not trusted to lower risk. If a tool is unknown or unreviewed, or if a destructive annotation conflicts with the policy:

- it defaults to **Level 3**;
- it is **disabled**;
- it cannot be enabled until a human records an explicit `reviewedLevel`;
- once enabled, it still requires per-call approval on every use.

The UI exposes the level, risk, review state, parameter summary, and allowed agents. A disabled server disables all of its tools. A disabled tool is never sent to the model and cannot be executed through the API.

Default agent scoping:

| Agent | Tools offered |
|---|---|
| Coding agent | Enabled tools at Levels 1–3 for the run |
| Verification agent | Enabled **Level 1** tools only |

`allowedAgents` can narrow a tool to one agent; an empty list is rejected. The verification agent's restriction is enforced both when listing tools and again when executing a call, so a forged tool object cannot escalate it.

---

## 6. Approvals

Level 2 and Level 3 calls block inside the tool loop until the approval resolves. The approval record carries the run, connection, server, tool, level, correlation ID, redacted arguments, argument hash, summary, consequences, and expiry.

| Kind | Created | Reuse |
|---|---|---|
| `run-grant` | First Level 2 call in a run | Reused for that run/tool; stored with `workspaceScope: "DNAFix run workspace only"` |
| `per-call` | Every Level 3 call | Never reused; the next call requires a new approval |

Possible decisions and terminal states:

- **Approve** — the gateway is invoked exactly once with the validated arguments that were shown for approval.
- **Deny** — the call is not executed and the tool loop receives an error result.
- **Expire** — unanswered approvals expire (default 5 minutes) and the call is not executed.
- **Cancel** — cancelling the run cancels every pending approval and aborts in-flight work.

A denied, expired, or cancelled call is recorded with `executed: false` and never reaches the gateway. Approvals are visible on the Connectors **Activity** tab and on the run detail page, where pending approvals can be approved or denied without leaving the run.

---

## 7. Agent integration and loop bounds

MCP evidence is **optional enrichment**, not a source of truth:

- Coding agent: gathers enabled evidence first, then generates the patch with a bounded MCP context.
- Verification agent: gathers Level 1 evidence, then produces its review.
- If no tools are enabled, the phase is skipped.
- If the phase fails, it is recorded as a warning and audited; the agent still completes without fabricated evidence.

The model loop supports both the Responses API (`function_call` / `function_call_output`, `previous_response_id`) and a Chat Completions fallback. Bounds and protections:

- maximum tool calls and maximum rounds per phase;
- per-call and overall timeouts;
- run cancellation through an `AbortSignal`;
- Ajv validation of arguments against the discovered schema before execution;
- duplicate-call suppression within one loop;
- unknown or malformed function calls answered locally with an error output, without invoking the executor;
- bounded result sizes and safe serialization;
- incomplete provider responses surface as incomplete, never as invented results;
- per-run executed-call budget (default 24); validation failures and denied calls do not consume it;
- at most 48 tools per agent.

MCP results are inserted into model context inside an explicit **UNTRUSTED MCP TOOL RESULT** boundary. Text inside a result is data: it cannot change DNAFix policy, approvals, permissions, or system instructions. Secret-looking keys and token patterns are redacted before persistence, display, and model feedback.

---

## 8. Audit and activity

Every invocation writes an `McpInvocationRecord` and an audit event containing:

- correlation ID, run ID, connection, server, tool, agent, model ID;
- permission level, approval ID and status;
- start/completion time, duration, success/error;
- redacted arguments and an argument hash;
- bounded, redacted result summary;
- whether the gateway call was actually executed.

The Connectors **Activity** tab shows connection and run activity, including denied, expired, and cancelled attempts. Run detail shows the same activity for that run plus any pending approvals. Redaction runs before data is stored or rendered; secrets must never appear in audit evidence.

Inventory changes and approval decisions are audited as well. Phase failures are audited as warnings; the pipeline does not claim MCP evidence it did not obtain.

---

## 9. API endpoints

All routes are under `/api/v1`. Errors include `{ error, code }`; connector errors are mapped to explicit HTTP statuses (for example `profile_invalid` → 400, `connection_error` → 409, `not_detected` → 503).

| Method | Path | Purpose |
|---|---|---|
| GET | `/mcp/status` | Connector overview: state, enablement, profile, detection, inventory, permissions |
| POST | `/mcp/detect` | Re-run read-only detection |
| GET | `/mcp/profiles` | List Docker-reported profiles |
| POST | `/mcp/profile` | Select a validated profile (`{ profileId }`) |
| POST | `/mcp/enable` | Enable/disable DNAFix's connector record (`{ enabled }`) |
| POST | `/mcp/connect` | Start gateway and complete handshake (`{ profileId? }`) |
| POST | `/mcp/disconnect` | Stop the session |
| POST | `/mcp/refresh` | Re-discover tools/resources/prompts |
| POST | `/mcp/permissions` | Update server or tool permission |
| GET | `/mcp/activity` | Activity list (`runId?`, `limit?`) |
| GET | `/mcp/approvals` | Approval list (`runId?`, `status?`) |
| GET | `/runs/:id/mcp` | Run-scoped approvals and activity |
| POST | `/runs/:id/mcp/approvals/:approvalId` | Approve or deny (`{ decision: "approve" \| "deny" }`) |
| POST | `/runs/:id/mcp/cancel` | Cancel all pending approvals for a run |

Permission updates accept:

```json
{
  "serverName": "docker",
  "toolName": "remove_container",
  "enabled": true,
  "allowedAgents": ["coding-agent"],
  "reviewedLevel": 3
}
```

`reviewedLevel` is required the first time an unreviewed tool is enabled. Permissions for servers or tools that were never discovered are rejected.

---

## 10. Persistence

Records live in the same store as runs and integrations (SQLite by default, shared with the API and worker; memory store in tests):

- `mcpConnections` — one record for `docker-desktop-mcp`;
- `mcpToolPermissions` / `mcpServerPermissions`;
- `mcpRunGrants`;
- `mcpApprovals`;
- `mcpInvocations`.

Connection state is DNAFix's own record. Docker Desktop remains the authority for profiles, servers, and MCP credentials. Resetting DNAFix data does not modify Docker.

---

## 11. Security boundaries

| Requirement | Implementation |
|---|---|
| No Docker mutation | Read-only CLI commands only; profiles and servers are never created or edited |
| No silent host changes | Docker is never installed, started, or reconfigured |
| No shell | argv-only `execFile`/`spawn`; `.cmd`/`.bat` shims refused |
| Profile injection | Strict profile-ID regex plus existence check against Docker's own list |
| Credential isolation | Gateway environment allowlist; DNAFix secrets excluded |
| No fake connection | `connected` only after a real MCP handshake and discovery |
| No fake inventory | Only gateway-reported data; tests are mocked and labelled as such |
| Least privilege | Separate server/tool enablement, agent scoping, unknown tools disabled at Level 3 |
| Destructive actions | Per-call human approval bound to the invocation |
| Denied calls | Never executed; recorded as such |
| Prompt injection | Results wrapped as untrusted data and cannot alter policy |
| Secret leakage | Recursive redaction before storage, audit, and model feedback |
| Sandbox separation | MCP is not the build `ExecutionProvider`; builds still run in the DNAFix sandbox |

---

## 12. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| “Docker Desktop is not running” | Start Docker Desktop yourself, then **Re-check Docker**. DNAFix will not start it. |
| “Docker CLI was not detected” | Install Docker CLI or set `DNAFIX_DOCKER_PATH` to the real executable. |
| “Refusing to launch a .cmd/.bat Docker shim” | The resolved command is a Windows shim. Set `DNAFIX_DOCKER_PATH` to `docker.exe`. |
| Profiles list is empty | Create a profile in Docker Desktop's MCP Toolkit, then refresh. |
| “Profile is not known to Docker” | The selected profile was deleted or renamed outside DNAFix. Select another. |
| Toolkit unavailable / disabled | Enable the MCP Toolkit in Docker Desktop. DNAFix does not enable beta features. |
| “authentication-required” | Sign in to Docker Desktop or authorise the Toolkit, then reconnect. |
| Handshake fails | Inspect the Desktop MCP logs; verify `docker mcp gateway run --profile <id> --transport stdio --block-secrets` works in a terminal. |
| Connected but no tools | The profile contains no enabled servers/tools, or discovery returned none. Check the profile in Docker Desktop. |
| A tool is missing from the agent | Check server enablement, tool enablement, review state, agent scoping, and `schemaValid`. |
| Approval never appears | The run may have been cancelled, the call may have been denied validation, or the connector is disconnected. Check Activity. |
| Call blocked as Level 3 | The tool is unreviewed. Review it deliberately and record a `reviewedLevel`; per-call approval still applies. |
| Reconnect loop | Fix the underlying Docker/gateway failure. Auto-reconnect is bounded and does not hide the last error. |

---

## 13. Verification

Automated coverage uses mocked Docker CLI output and a fake MCP client/session; no real destructive MCP operation runs in tests.

```bash
pnpm vitest run packages/mcp
pnpm vitest run packages/model-provider packages/agent-orchestrator
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @dnafix/web build
```

Covered scenarios include: detection and `.cmd` refusal, profile parsing/validation, argv and environment construction, handshake lifecycle, failed handshakes and unexpected exits, discovery/pagination/refresh, unknown-tool review, server/tool/agent scoping, Level 1 execution, Level 2 run grants, Level 3 per-call approvals, denial/expiry/cancellation, per-run budgets, argument validation, redaction, audit records, Responses and Chat tool loops, duplicate/unknown/malformed calls, result bounds, and phase failures without fabricated evidence.

Live QA requires:

1. Docker Desktop running with the MCP Toolkit enabled and a profile defined.
2. A real `docker mcp gateway run` handshake.
3. A manually selected read-only tool call.

Until those are available, report live MCP verification as **blocked**, not as passing. Do not start Docker Desktop automatically and do not substitute mocked results for live evidence.
