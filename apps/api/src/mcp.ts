import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  McpApprovalDecisionSchema,
  McpPermissionUpdateSchema,
  McpProfileIdSchema,
  McpAgentRoleSchema,
} from "@dnafix/contracts";
import {
  McpConnectorError,
  type McpConnectorService,
} from "@dnafix/mcp";

const EnableBody = z.object({ enabled: z.boolean() });
const ConnectBody = z.object({ profileId: McpProfileIdSchema.optional() });
const SelectProfileBody = z.object({ profileId: McpProfileIdSchema });
const PermissionBody = McpPermissionUpdateSchema;
const DecisionBody = McpApprovalDecisionSchema;
const ActivityQuery = z.object({
  runId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const ApprovalQuery = z.object({
  runId: z.string().min(1).optional(),
  status: z.enum(["pending", "approved", "denied", "expired", "cancelled"]).optional(),
});
const RunIdParams = z.object({ id: z.string().min(1) });
const ApprovalParams = z.object({ id: z.string().min(1), approvalId: z.string().min(1) });

export interface McpRoutesOptions {
  connector: McpConnectorService;
}

function statusForCode(code: McpConnectorError["code"]): number {
  switch (code) {
    case "not_detected":
      return 503;
    case "disabled":
    case "not_configured":
    case "not_connected":
    case "authentication_required":
    case "tool_disabled":
    case "approval_denied":
    case "run_limit":
    case "cancelled":
    case "timeout":
    case "connection_error":
      return 409;
    case "profile_invalid":
    case "invalid_arguments":
    case "tool_unreviewed":
      return 400;
    default:
      return 500;
  }
}

/** Map connector failures to explicit HTTP codes without hiding the reason. */
function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof McpConnectorError) {
    return reply.code(statusForCode(err.code)).send({ error: err.message, code: err.code });
  }
  if (err instanceof z.ZodError) {
    return reply.code(400).send({ error: err.issues, code: "invalid_request" });
  }
  return reply.code(500).send({ error: err instanceof Error ? err.message : String(err), code: "mcp_error" });
}

/**
 * Docker Desktop MCP connector API. Every mutation is scoped to DNAFix's own
 * record: profiles/servers are only read from Docker, never created or changed.
 */
export function registerMcpRoutes(app: FastifyInstance, options: McpRoutesOptions): void {
  const base = "/api/v1/mcp";
  const connector = options.connector;

  app.get(`${base}/status`, async (_req, reply) => {
    try {
      return await connector.getOverview();
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Explicit refresh re-runs read-only Docker detection (never starts Docker). */
  app.post(`${base}/detect`, async (_req, reply) => {
    try {
      return await connector.getOverview(true);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get(`${base}/profiles`, async (_req, reply) => {
    try {
      return await connector.listProfiles(true);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post(`${base}/profile`, async (req, reply) => {
    try {
      const body = SelectProfileBody.parse(req.body ?? {});
      return await connector.selectProfile(body.profileId);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post(`${base}/enable`, async (req, reply) => {
    try {
      const body = EnableBody.parse(req.body ?? {});
      return await connector.setEnabled(body.enabled);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post(`${base}/connect`, async (req, reply) => {
    try {
      const body = ConnectBody.parse(req.body ?? {});
      return await connector.connect(body.profileId);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post(`${base}/disconnect`, async (req, reply) => {
    try {
      return await connector.disconnect();
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post(`${base}/refresh`, async (req, reply) => {
    try {
      return await connector.refresh();
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post(`${base}/permissions`, async (req, reply) => {
    try {
      const body = PermissionBody.parse(req.body ?? {});
      return await connector.updatePermission(body);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get(`${base}/activity`, async (req, reply) => {
    try {
      const query = ActivityQuery.parse(req.query ?? {});
      return await connector.listActivity(query);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get(`${base}/approvals`, async (req, reply) => {
    try {
      const query = ApprovalQuery.parse(req.query ?? {});
      return await connector.listApprovals(query);
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Run-scoped view used by the run detail page: approvals + MCP activity only. */
  app.get("/api/v1/runs/:id/mcp", async (req, reply) => {
    try {
      const { id } = RunIdParams.parse(req.params);
      return {
        approvals: await connector.listRunApprovals(id),
        activity: await connector.listActivity({ runId: id, limit: 100 }),
      };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/api/v1/runs/:id/mcp/approvals/:approvalId", async (req, reply) => {
    try {
      const { id, approvalId } = ApprovalParams.parse(req.params);
      const body = DecisionBody.parse(req.body ?? {});
      const approval = await connector.decideApproval(id, approvalId, body.decision);
      return { approval };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Cancel every pending MCP approval for a run (used with run cancellation). */
  app.post("/api/v1/runs/:id/mcp/cancel", async (req, reply) => {
    try {
      const { id } = RunIdParams.parse(req.params);
      await connector.cancelRun(id);
      return { cancelled: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get(`${base}/agent-roles`, async () => ({
    roles: McpAgentRoleSchema.options,
    levels: [1, 2, 3],
  }));
}
