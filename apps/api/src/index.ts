import { timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { z } from "zod";
import { Pipeline, RunConflictError, RunService, createDefaultDeps, describeStore, migrateLegacyStore } from "@dnafix/application";
import { CreateRunRequestSchema } from "@dnafix/contracts";
import { GitHubError, GitHubIntegrationService, GitHubNotConfiguredError, verifyWebhookSignature } from "@dnafix/github";
import { GitHubConnectionManager, readGitHubSessionId, registerGitHubRoutes } from "./github.js";
import { registerMcpRoutes } from "./mcp.js";
import { withCheckoutState } from "./repository-checkout.js";
import { assertRepositoryPathAllowed, configuredRepositoryRoots, isLanBindEnabled, isRemoteBind, RepositoryPathError } from "./repository-policy.js";
import { evaluateVerification } from "@dnafix/verification";

const deps = createDefaultDeps();
await migrateLegacyStore(deps);
const runs = new RunService(deps);
const pipeline = new Pipeline(deps);
const app = Fastify({
  logger: { redact: ["req.headers.authorization", "req.headers.cookie", "code", "password"] },
});
const githubIntegration = new GitHubIntegrationService();
const githubConnections = new GitHubConnectionManager(githubIntegration, deps.store);

/**
 * GitHub signs the exact bytes it sent, so the webhook must verify those
 * bytes. Re-serialising the parsed body can differ from the original payload
 * in key order or number formatting and would reject valid deliveries.
 */
const rawBodies = new WeakMap<object, Buffer>();
app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
  const buffer = body as Buffer;
  rawBodies.set(req, buffer);
  try {
    done(null, buffer.length === 0 ? undefined : JSON.parse(buffer.toString("utf8")));
  } catch {
    // A syntax error here is the client's malformed body, not a server fault;
    // classify it as 400 so the error handler does not report it as a 500.
    const err = new SyntaxError("Request body is not valid JSON.") as SyntaxError & { statusCode: number };
    err.statusCode = 400;
    done(err, undefined);
  }
});

await app.register(cors, { origin: process.env.WEB_ORIGIN ?? "http://localhost:5173" });
await app.register(swagger, { openapi: { info: { title: "DNAFix API", version: "0.1.0" } } });
await app.register(swaggerUi, { routePrefix: "/docs" });

if (!githubIntegration.configured) {
  app.log.warn({ missing: githubIntegration.missingConfiguration }, "GitHub App user integration is not configured");
}

const sessionToken = process.env.DNAFIX_SESSION_TOKEN?.trim() ?? "";
const bearerPrefix = "Bearer ";
app.addHook("onRequest", async (req, reply) => {
  if (!sessionToken) return;
  if (
    req.url === "/health" ||
    req.url.startsWith("/api/v1/webhooks/") ||
    req.url.startsWith("/docs") ||
    req.url.startsWith("/api/v1/integrations/github/callback") ||
    req.url.startsWith("/api/v1/integrations/github/setup")
  )
    return;
  const presented = req.headers.authorization ?? "";
  if (!matchesToken(presented, sessionToken, bearerPrefix)) {
    return reply.code(401).send({ error: "Unauthorized: missing or invalid session token" });
  }
});

/** Constant-time compare of the token after the scheme prefix, without leaking length. */
function matchesToken(presented: string, expected: string, prefix: string): boolean {
  if (!presented.startsWith(prefix)) return false;
  const a = Buffer.from(presented.slice(prefix.length), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

app.setErrorHandler((error, req, reply) => {
  if (error instanceof GitHubError) {
    return reply.code(error.status ?? 500).send({
      error: error.message,
      code: error.code,
      ...(error instanceof GitHubNotConfiguredError ? { missing: error.missing } : {}),
    });
  }
  // A run another process moved while this request was in flight. The stored row
  // stays as it is; the client re-reads and decides.
  if (error instanceof RunConflictError) {
    return reply.code(409).send({ error: error.message, code: "run_conflict" });
  }
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: error.issues, code: "invalid_request" });
  }
  // Malformed bodies and unsupported content types arrive already classified by
  // Fastify. Reporting them as 500 hides a client mistake behind our own error.
  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return reply.code(status).send({ error: error instanceof Error ? error.message : "Invalid request.", code: "invalid_request" });
  }
  req.log.error({ err: error }, "unhandled request error");
  return reply.code(500).send({ error: "Internal server error" });
});

// Register after the auth hook and error handler so every integration route is
// covered by the optional bearer gate and the structured GitHub error mapping.
registerGitHubRoutes(app, { manager: githubConnections, integration: githubIntegration });
if (deps.mcp) registerMcpRoutes(app, { connector: deps.mcp });

// Close the Docker MCP Gateway child process when the API shuts down.
app.addHook("onClose", async () => {
  await deps.mcp?.shutdown().catch(() => undefined);
});

function kick(runId: string): void {
  void pipeline.process(runId).catch((err: Error) => app.log.error({ err, runId }, "pipeline error"));
}

app.get("/health", async () => ({ status: "ok", service: "dnafix-api", time: new Date().toISOString() }));

const port = Number(process.env.API_PORT ?? 3001);
const bindHost = process.env.DNAFIX_BIND_HOST?.trim() || "127.0.0.1";
const lanBind = isLanBindEnabled();
const remoteBind = isRemoteBind(bindHost);

/** Live readiness payload. Recomputed per request so runtime configuration changes are reflected immediately. */
function configStatusPayload() {
  const projectDnaPath = deps.intelligence.location ?? null;
  return {
    model: {
      provider: deps.model.name,
      modelId: deps.model.modelId,
      subAgentModelId: deps.subAgentModel?.modelId ?? deps.model.modelId,
      configured: Boolean(process.env.MODEL_API_KEY),
      transport: process.env.MODEL_TRANSPORT ?? "responses",
      baseUrl: process.env.MODEL_API_BASE_URL ?? "https://api.meta.ai/v1",
    },
    projectDna: { configured: Boolean(projectDnaPath), path: projectDnaPath, runtime: deps.intelligence.runtime ?? null },
    github: {
      configured: deps.github.configured,
      appConfigured: deps.github.appConfigured,
      userIntegrationConfigured: githubIntegration.configured,
      missing: githubIntegration.missingConfiguration,
      slug: githubIntegration.config.slug,
    },
    sandboxMode: deps.runner.mode,
    execution: {
      provider: process.env.DNAFIX_EXECUTION_PROVIDER === "codebuild" ? "codebuild" : "local",
      remoteConfigured: deps.remoteExecution?.configured() ?? false,
      project: process.env.AWS_CODEBUILD_PROJECT ?? null,
      bucket: process.env.AWS_ARTIFACT_BUCKET ?? process.env.AWS_ARTIFACTS_BUCKET ?? null,
      region: process.env.AWS_REGION ?? "ap-southeast-2",
    },
    workflowEngine: process.env.WORKFLOW_ENGINE === "temporal" ? "temporal" : "in-process-durable",
    temporalAddress: process.env.TEMPORAL_ADDRESS?.trim() || null,
    store: describeStore(deps.store),
    // Presence and policy only. Secret values never leave this process.
    security: {
      bind: `${bindHost}:${port}`,
      remoteBind,
      lanBindAllowed: lanBind,
      sessionTokenRequired: Boolean(sessionToken),
      repositoryRoots: configuredRepositoryRoots(),
      webhookSecretConfigured: Boolean(process.env.GITHUB_WEBHOOK_SECRET),
      tokenEncryptionKeyConfigured: Boolean(githubIntegration.config.encryptionKey),
      corsOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
    },
  };
}

app.get("/api/v1/config/status", async () => configStatusPayload());

/** SSE readiness stream: pushes the current status immediately, then whenever it changes. */
app.get("/api/v1/config/status/events", async (req, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write("retry: 3000\n\n");
  let lastPayload = "";
  const publish = () => {
    const payload = JSON.stringify(configStatusPayload());
    if (payload === lastPayload) return;
    lastPayload = payload;
    reply.raw.write(`event: status\ndata: ${payload}\n\n`);
  };
  publish();
  const poll = setInterval(publish, 1_000);
  const heartbeat = setInterval(() => reply.raw.write(": keep-alive\n\n"), 15_000);
  req.raw.on("close", () => {
    clearInterval(poll);
    clearInterval(heartbeat);
  });
});

app.get("/api/v1/repositories", async () => Promise.all((await deps.store.listRepositories()).map(withCheckoutState)));

app.post("/api/v1/runs", async (req, reply) => {
  const parsed = CreateRunRequestSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  let request = parsed.data;
  if (request.githubInstallationId !== undefined || request.issueUrl !== undefined) {
    const sessionId = readGitHubSessionId(req);
    if (!sessionId) return reply.code(401).send({ error: "GitHub provenance requires a connected GitHub session. Connect GitHub again.", code: "authentication_required" });
    const provenance = await githubConnections.validateRunProvenance(sessionId, request);
    const [owner, repo] = provenance.repositoryFullName.split("/");
    if (!owner || !repo) return reply.code(400).send({ error: "GitHub provenance did not resolve to a valid repository.", code: "invalid_request" });
    request = {
      ...request,
      githubOwner: owner,
      githubRepo: repo,
      githubInstallationId: provenance.installationId,
      issueUrl: provenance.issueUrl ?? undefined,
      issueNumber: provenance.issueNumber ?? request.issueNumber,
    };
  }
  if (request.repositoryPath !== undefined) {
    try {
      // Canonicalise before use: the browser never chooses where DNAFix reads.
      request = { ...request, repositoryPath: await assertRepositoryPathAllowed(request.repositoryPath) };
    } catch (err) {
      if (err instanceof RepositoryPathError) return reply.code(400).send({ error: err.message, code: "repository_not_allowed" });
      throw err;
    }
  }
  const run = await runs.createRun(request);
  kick(run.id);
  return reply.code(201).send(run);
});

app.get("/api/v1/runs", async () => deps.store.listRuns());

app.get("/api/v1/runs/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const run = await deps.store.getRun(id);
  if (!run) return reply.code(404).send({ error: "Run not found" });
  // Repository-boundary check: the run must belong to an existing repository record.
  const repo = await deps.store.getRepository(run.repositoryId);
  if (!repo) return reply.code(404).send({ error: "Run repository not found" });
  return run;
});

async function loadRun(id: string, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  const run = await runs.load(id);
  if (!run) {
    reply.code(404).send({ error: "Run not found" });
    return null;
  }
  // Every route that reaches a run goes through here, so the repository
  // boundary is enforced once instead of only on the read endpoint.
  if (!(await deps.store.getRepository(run.repositoryId))) {
    reply.code(404).send({ error: "Run repository not found" });
    return null;
  }
  return run;
}

app.post("/api/v1/runs/:id/approve-plan", async (req, reply) => {
  const run = await loadRun((req.params as { id: string }).id, reply);
  if (!run) return;
  if (run.state !== "AWAITING_PLAN_APPROVAL") return reply.code(409).send({ error: `Run is ${run.state}, not AWAITING_PLAN_APPROVAL` });
  await runs.audit(run.id, run.repositoryId, "user", "plan.approved", "ok", null);
  const updated = await runs.transition(run, "AGENT_EXECUTION");
  kick(run.id);
  return updated;
});

app.post("/api/v1/runs/:id/approve-pr", async (req, reply) => {
  const run = await loadRun((req.params as { id: string }).id, reply);
  if (!run) return;
  if (run.state !== "AWAITING_PR_APPROVAL") return reply.code(409).send({ error: `Run is ${run.state}, not AWAITING_PR_APPROVAL` });
  await runs.audit(run.id, run.repositoryId, "user", "pull-request.approved", "ok", null);
  const updated = await runs.transition(run, "PULL_REQUEST_CREATION");
  kick(run.id);
  return updated;
});

const ClarificationSchema = z.object({ answer: z.string().min(1).max(10_000) });
app.post("/api/v1/runs/:id/clarification", async (req, reply) => {
  const run = await loadRun((req.params as { id: string }).id, reply);
  if (!run) return;
  const parsed = ClarificationSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  if (run.state !== "NEEDS_CLARIFICATION") return reply.code(409).send({ error: `Run is ${run.state}, not NEEDS_CLARIFICATION` });
  run.clarificationAnswer = parsed.data.answer;
  await runs.audit(run.id, run.repositoryId, "user", "clarification.answered", "ok", parsed.data.answer.slice(0, 500));
  const updated = await runs.transition(run, "ISSUE_PLANNING");
  kick(run.id);
  return updated;
});

app.post("/api/v1/runs/:id/cancel", async (req, reply) => {
  const run = await loadRun((req.params as { id: string }).id, reply);
  if (!run) return;
  if (["COMPLETED", "FAILED", "CANCELLED"].includes(run.state)) return reply.code(409).send({ error: `Run already ${run.state}` });
  await runs.requestRemoteCancellation(run).catch(() => undefined);
  await deps.mcp?.cancelRun(run.id).catch(() => undefined);
  const cancelled = await runs.cancel(run.id);
  await runs.audit(run.id, run.repositoryId, "user", "run.cancelled", "ok", null);
  return cancelled;
});

app.post("/api/v1/runs/:id/resume", async (req, reply) => {
  const run = await loadRun((req.params as { id: string }).id, reply);
  if (!run) return;
  if (run.state !== "BLOCKED") return reply.code(409).send({ error: `Run is ${run.state}; only a BLOCKED run can be resumed` });
  const blocker = run.error;
  run.error = null;
  const queued = await runs.transition(run, "QUEUED");
  await runs.audit(run.id, run.repositoryId, "user", "run.resumed", "ok", blocker ? `previous blocker: ${blocker.slice(0, 300)}` : null);
  kick(run.id);
  return queued;
});

app.get("/api/v1/runs/:id/diff", async (req, reply) => {
  const run = await loadRun((req.params as { id: string }).id, reply);
  if (!run) return;
  return { changedPaths: run.changedPaths, diff: run.diff };
});

app.get("/api/v1/runs/:id/verification", async (req, reply) => {
  const run = await loadRun((req.params as { id: string }).id, reply);
  if (!run) return;
  return {
    baselineChecks: run.baselineChecks,
    verificationChecks: run.verificationChecks,
    verifierReview: run.verifierReview,
    repairAttempts: run.repairAttempts,
    waivers: run.verificationWaivers ?? [],
    evaluation: evaluateVerification(run.verificationChecks ?? [], {
      baselineFailingIds: new Set(run.baselineChecks.filter((c) => c.status === "failed").map((c) => c.id)),
      waivers: run.verificationWaivers ?? [],
    }),
  };
});

/**
 * Exclude a check that was already failing at baseline. Deliberately requires
 * a reason and evidence: without it, "pre-existing failure" would be a silent
 * way to make a run look verified.
 */
const WaiverSchema = z.object({ checkId: z.string().min(1), reason: z.string().min(20).max(2_000), evidence: z.string().min(20).max(4_000), waivedBy: z.string().min(1).max(200).default("user") });
app.post("/api/v1/runs/:id/verification-waivers", async (req, reply) => {
  const run = await loadRun((req.params as { id: string }).id, reply);
  if (!run) return;
  const parsed = WaiverSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  const failing = (run.verificationChecks ?? []).filter((c) => c.status === "pre-existing-failure").map((c) => c.id);
  if (!failing.includes(parsed.data.checkId)) {
    return reply.code(422).send({ error: `${parsed.data.checkId} is not a pre-existing failure on this run. Waivable checks: ${failing.join(", ") || "none"}`, code: "not_waivable" });
  }
  if ((run.verificationWaivers ?? []).some((w) => w.checkId === parsed.data.checkId)) {
    return reply.code(409).send({ error: `${parsed.data.checkId} is already waived.`, code: "already_waived" });
  }
  run.verificationWaivers = [
    ...(run.verificationWaivers ?? []),
    { ...parsed.data, waivedAt: new Date().toISOString() },
  ];
  await runs.save(run);
  await runs.audit(run.id, run.repositoryId, "user", "verification.waived", "ok", `check=${parsed.data.checkId} by=${parsed.data.waivedBy} reason=${parsed.data.reason.slice(0, 300)}`);
  return { waivers: run.verificationWaivers };
});

/** Operator view of cloud executions incl. role quarantine/containment state and unresolved cleanups. */
app.get("/api/v1/executions", async (req) => {
  const { unresolved } = req.query as { unresolved?: string };
  const runs = await deps.store.listRuns();
  const executions = runs.flatMap((run) =>
    (run.remoteExecutions ?? []).map((e) => ({ runId: run.id, runState: run.state, ...e })),
  );
  return unresolved === "true" ? executions.filter((e) => e.containmentStatus && e.containmentStatus !== "contained") : executions;
});

app.get("/api/v1/audit", async (req) => {
  const { runId } = req.query as { runId?: string };
  return deps.store.listAudit(runId);
});

/** SSE progress: replays persisted audit events, then streams new ones. Supports Last-Event-ID reconnect. */
app.get("/api/v1/runs/:id/events", async (req, reply) => {
  const { id } = req.params as { id: string };
  const run = await deps.store.getRun(id);
  if (!run) return reply.code(404).send({ error: "Run not found" });
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  let sent = 0;
  const lastEventId = Number(req.headers["last-event-id"] ?? 0);
  const tick = async () => {
    const events = await deps.store.listAudit(id);
    const fresh = await deps.store.getRun(id);
    for (let i = Math.max(sent, lastEventId); i < events.length; i++) {
      const e = events[i]!;
      reply.raw.write(`id: ${i + 1}\nevent: audit\ndata: ${JSON.stringify(e)}\n\n`);
    }
    sent = events.length;
    if (fresh) reply.raw.write(`event: state\ndata: ${JSON.stringify({ state: fresh.state, updatedAt: fresh.updatedAt })}\n\n`);
  };
  await tick();
  const timer = setInterval(() => void tick(), 1_000);
  req.raw.on("close", () => clearInterval(timer));
});

app.post("/api/v1/webhooks/github", async (req, reply) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
  const raw = rawBodies.get(req as unknown as object);
  if (!raw || !verifyWebhookSignature(raw.toString("utf8"), req.headers["x-hub-signature-256"] as string | undefined, secret)) {
    return reply.code(401).send({ error: "Invalid webhook signature" });
  }
  const event = req.headers["x-github-event"] as string;
  await runs.audit(null, null, "system", `github.webhook.${event}`, "ok", null);
  return { received: true };
});

if (remoteBind && !lanBind) {
  throw new Error(
    `Refusing to bind ${bindHost}: a non-loopback host exposes run creation, which executes repository code. Set DNAFIX_ALLOW_LAN_BIND=true to opt in.`,
  );
}
if (remoteBind && !sessionToken) {
  throw new Error(`Refusing to bind ${bindHost} without DNAFIX_SESSION_TOKEN: an exposed API must not be unauthenticated.`);
}
if (remoteBind && configuredRepositoryRoots().length === 0) {
  throw new Error(`Refusing to bind ${bindHost} without DNAFIX_ALLOWED_REPOSITORY_ROOTS: an exposed API must constrain which repositories it may open.`);
}
await app.listen({ port, host: bindHost });
app.log.info(
  `DNAFix API listening on ${bindHost}:${port} (data root: ${deps.dataRoot}, store: ${describeStore(deps.store).location}, model provider: ${deps.model.name}, sandbox: ${deps.runner.mode}, auth: ${sessionToken ? "bearer" : "loopback-only"}, repository roots: ${configuredRepositoryRoots().join(", ") || "unrestricted (loopback)"})`,
);
