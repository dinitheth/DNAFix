import { readFile } from "node:fs/promises";
import type { Store } from "./index.js";

/**
 * One-off copy of a legacy `dnafix.json` FileStore database into another store
 * (normally SQLite). Idempotent: a record whose id already exists in the target
 * is left alone, so restarting api and worker together cannot duplicate or
 * overwrite anything, and the source file is never modified or deleted.
 */
export interface LegacyImportReport {
  source: string;
  target: string;
  imported: Record<string, number>;
  skipped: Record<string, number>;
  total: Record<string, number>;
}

type Collection = "repositories" | "runs" | "audit" | "githubConnections" | "mcpConnections" | "mcpToolPermissions" | "mcpServerPermissions" | "mcpRunGrants" | "mcpApprovals" | "mcpInvocations";

const COLLECTIONS: Collection[] = [
  "repositories",
  "runs",
  "audit",
  "githubConnections",
  "mcpConnections",
  "mcpToolPermissions",
  "mcpServerPermissions",
  "mcpApprovals",
  "mcpRunGrants",
  "mcpInvocations",
];

export async function importLegacyJson(sourcePath: string, target: Store, targetLabel: string): Promise<LegacyImportReport | null> {
  let raw: string;
  try {
    raw = await readFile(sourcePath, "utf8");
  } catch {
    return null; // Nothing to import.
  }
  const parsed = JSON.parse(raw) as Partial<Record<Collection, unknown[]>>;

  const report: LegacyImportReport = { source: sourcePath, target: targetLabel, imported: {}, skipped: {}, total: {} };
  // Order matters only for foreign keys: repositories and runs before grants.
  for (const collection of COLLECTIONS) {
    const items = (parsed[collection] ?? []) as never[];
    report.total[collection] = items.length;
    report.imported[collection] = 0;
    report.skipped[collection] = 0;

    for (const item of items) {
      switch (collection) {
        case "repositories": {
          const record = item as Parameters<Store["saveRepository"]>[0];
          if (await target.getRepository(record.id)) {
            report.skipped[collection] += 1;
            break;
          }
          await target.saveRepository(record);
          report.imported[collection] += 1;
          break;
        }
        case "runs": {
          const record = item as Parameters<Store["saveRun"]>[0];
          if (await target.getRun(record.id)) {
            report.skipped[collection] += 1;
            break;
          }
          await target.saveRun(record);
          report.imported[collection] += 1;
          break;
        }
        case "audit": {
          const record = item as Parameters<Store["appendAudit"]>[0];
          // Audit ids are generated per event, so an existing id means this
          // file was already imported; appending again would double the history.
          const existing = await target.listAudit(record.runId ?? undefined);
          if (existing.some((event) => event.id === record.id)) {
            report.skipped[collection] += 1;
            break;
          }
          await target.appendAudit(record);
          report.imported[collection] += 1;
          break;
        }
        case "githubConnections": {
          const record = item as Parameters<Store["saveGitHubConnection"]>[0];
          if (await target.getGitHubConnection(record.sessionId)) {
            report.skipped[collection] += 1;
            break;
          }
          await target.saveGitHubConnection(record);
          report.imported[collection] += 1;
          break;
        }
        case "mcpConnections": {
          const record = item as Parameters<Store["saveMcpConnection"]>[0];
          if (await target.getMcpConnection(record.id)) {
            report.skipped[collection] += 1;
            break;
          }
          await target.saveMcpConnection(record);
          report.imported[collection] += 1;
          break;
        }
        case "mcpToolPermissions": {
          const record = item as Parameters<Store["saveMcpToolPermission"]>[0];
          const existing = await target.listMcpToolPermissions(record.connectionId);
          if (existing.some((p) => p.serverName === record.serverName && p.toolName === record.toolName)) {
            report.skipped[collection] += 1;
            break;
          }
          await target.saveMcpToolPermission(record);
          report.imported[collection] += 1;
          break;
        }
        case "mcpServerPermissions": {
          const record = item as Parameters<Store["saveMcpServerPermission"]>[0];
          const existing = await target.listMcpServerPermissions(record.connectionId);
          if (existing.some((p) => p.serverName === record.serverName)) {
            report.skipped[collection] += 1;
            break;
          }
          await target.saveMcpServerPermission(record);
          report.imported[collection] += 1;
          break;
        }
        case "mcpApprovals": {
          const record = item as Parameters<Store["saveMcpApproval"]>[0];
          if (await target.getMcpApproval(record.id)) {
            report.skipped[collection] += 1;
            break;
          }
          await target.saveMcpApproval(record);
          report.imported[collection] += 1;
          break;
        }
        case "mcpRunGrants": {
          const record = item as Parameters<Store["saveMcpRunGrant"]>[0];
          const existing = await target.listMcpRunGrants(record.runId);
          if (existing.some((g) => g.id === record.id)) {
            report.skipped[collection] += 1;
            break;
          }
          await target.saveMcpRunGrant(record);
          report.imported[collection] += 1;
          break;
        }
        case "mcpInvocations": {
          const record = item as Parameters<Store["saveMcpInvocation"]>[0];
          const existing = await target.listMcpInvocations({ runId: record.runId ?? undefined });
          if (existing.some((i) => i.id === record.id)) {
            report.skipped[collection] += 1;
            break;
          }
          await target.saveMcpInvocation(record);
          report.imported[collection] += 1;
          break;
        }
      }
    }
  }
  return report;
}
