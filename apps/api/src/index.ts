import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { z } from "zod";
import { Pipeline, RunService, createDefaultDeps } from "@dnafix/application";
import { CreateRunRequestSchema } from "@dnafix/contracts";
import { verifyWebhookSignature } from "@dnafix/github";

const deps = createDefaultDeps();
const runs = new RunService(deps);
const pipeline = new Pipeline(deps);
const app = Fastify({ logger: true });

await app.register(cors, { origin: process.env.WEB_ORIGIN ?? "http://localhost:5173" });
await app.register(swagger, { openapi: { info: { title: "DNAFix API", version: "0.1.0" } } });
await app.register(swaggerUi, { routePrefix: "/docs" });

const sessionToken = process.env.DNAFIX_SESSION_TOKEN;
app.addHook("onRequest", async (req, reply) => {
  if (!sessionToken) return;
  if (req.url === "/health" || req.url.startsWith("/api/v1/webhooks/") || req.url.startsWith("/docs")) return;
  if (req.headers.authorization !== `Bearer ${sessionToken}`) {
    return reply.code(401).send({ error: "Unauthorized: missing or invalid session token" });
  }
});

function kick(runId: string): void {
  void pipeline.process(runId).catch((err: Error) => app.log.error({ err, runId }, "pipeline error"));
}

app.get("/health", async () => ({ status: "ok", service: "dnafix-api", time: new Date().toISOString() }));

app.get("/api/v1/config/status", async () => ({
  model: {
    provider: deps.model.name,
    modelId: deps.model.modelId,
    subAgentModelId: deps.subAgentModel?.modelId ?? deps.model.modelId,
    configured: Boolean(process.env.MODEL_API_KEY),
    transport: process.env.MODEL_TRANSPORT ?? "responses",
    baseUrl: process.env.MODEL_API_BASE_URL ?? "https://api.meta.ai/v1",
  },
  projectDna: { configured: Boolean(process.env.PROJECT_DNA_PATH), path: process.env.PROJECT_DNA_PATH ?? null },
  github: { configured: deps.github.configured },
  sandboxMode: deps.runner.mode,
  execution: {
    provider: process.env.DNAFIX_EXECUTION_PROVIDER === "codebuild" ? "codebuild" : "local",
    remoteConfigured: deps.remoteExecution?.configured() ?? false,
    project: process.env.AWS_CODEBUILD_PROJECT ?? null,
    bucket: process.env.AWS_ARTIFACT_BUCKET ?? process.env.AWS_ARTIFACTS_BUCKET ?? null,
    region: process.env.AWS_REGION ?? "ap-southeast-2",
  },
  workflowEngine: process.env.WORKFLOW_ENGINE === "temporal" ? "temporal" : "in-process-durable",
  temporalAddress: process.env.TEMPORAL_ADDRESS ?? null,
}));

app.get("/api/v1/repositories", async () => deps.store.listRepositories());

app.post("/api/v1/runs", async (req, reply) => {
  const parsed = CreateRunRequestSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  const run = await runs.createRun(parsed.data);
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
  const run = await deps.store.getRun(id);
  if (!run) {
    reply.code(404).send({ error: "Run not found" });
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
  run.state = "CANCELLED";
  await runs.save(run);
  await runs.audit(run.id, run.repositoryId, "user", "run.cancelled", "ok", null);
  return run;
});

app.get("/api/v1/runs/:id/diff", async (req, reply) => {
  const run = await loadRun((req.params as { id: string }).id, reply);
  if (!run) return;
  return { changedPaths: run.changedPaths, diff: run.diff };
});

app.get("/api/v1/runs/:id/verification", async (req, reply) => {
  const run = await loadRun((req.params as { id: string }).id, reply);
  if (!run) return;
  return { baselineChecks: run.baselineChecks, verificationChecks: run.verificationChecks, verifierReview: run.verifierReview, repairAttempts: run.repairAttempts };
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
  const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  if (!verifyWebhookSignature(raw, req.headers["x-hub-signature-256"] as string | undefined, secret)) {
    return reply.code(401).send({ error: "Invalid webhook signature" });
  }
  const event = req.headers["x-github-event"] as string;
  await runs.audit(null, null, "system", `github.webhook.${event}`, "ok", null);
  return { received: true };
});

const port = Number(process.env.API_PORT ?? 3001);
await app.listen({ port, host: "0.0.0.0" });
app.log.info(`DNAFix API listening on :${port} (model provider: ${deps.model.name}, sandbox: ${deps.runner.mode})`);
