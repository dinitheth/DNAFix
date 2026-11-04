import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RepositoryIntelligenceReportSchema, type RepositoryIntelligenceReport } from "@dnafix/contracts";

/**
 * Default Project DNA location resolution:
 * 1. PROJECT_DNA_PATH (explicit, always wins)
 * 2. vendor/Project-DNA git submodule at the DNAFix repository root
 * The fallback is anchored to this package's own location, not process.cwd(),
 * because the API and worker can be started from their app directories.
 * Project DNA is consumed only through its public IProjectDNAService API;
 * its source is never copied into DNAFix packages (ADR-0002).
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function resolveProjectDnaPath(explicit = process.env.PROJECT_DNA_PATH ?? ""): string {
  if (explicit.trim()) return explicit.trim();
  for (const candidate of [path.join(REPO_ROOT, "vendor", "Project-DNA"), path.resolve(process.cwd(), "vendor", "Project-DNA")]) {
    if (existsSync(path.join(candidate, "packages", "dna-core", "src", "index.ts"))) return candidate;
  }
  return "";
}

export class RepositoryIntelligenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryIntelligenceError";
  }
}

/** Port: deterministic repository intelligence. Facts only — no model hypotheses. */
export interface RepositoryIntelligence {
  readonly providerName: string;
  /** Where the real Project DNA checkout resolved to, for readiness reporting. Absent for test doubles. */
  readonly location?: string | null;
  analyze(input: { rootPath: string; baseCommitSha: string; targetPaths: string[]; changedPaths?: string[] }): Promise<RepositoryIntelligenceReport>;
}

const BRIDGE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bridge", "project-dna-bridge.ts");

/**
 * Runtime used to execute the bridge. Project DNA declares Node >=22.23.2 <23,
 * so an operator can pin an isolated runtime with PROJECT_DNA_NODE_PATH without
 * changing the Node version DNAFix itself runs on.
 */
export function projectDnaRuntime(): string {
  return process.env.PROJECT_DNA_NODE_PATH?.trim() || process.execPath;
}

/**
 * Adapter over Project DNA's public IProjectDNAService, executed out-of-process
 * against a Project DNA checkout (PROJECT_DNA_PATH). See ADR-0002.
 * Never falls back to fabricated analysis: misconfiguration fails the run.
 */
export class ProjectDNAAdapter implements RepositoryIntelligence {
  readonly providerName = "project-dna";
  readonly location: string | null;
  constructor(
    private readonly projectDnaPath = resolveProjectDnaPath(),
    private readonly timeoutMs = Number(process.env.PROJECT_DNA_TIMEOUT_MS ?? 600_000),
  ) {
    this.location = this.projectDnaPath || null;
  }

  async analyze(input: { rootPath: string; baseCommitSha: string; targetPaths: string[]; changedPaths?: string[] }): Promise<RepositoryIntelligenceReport> {
    if (!this.projectDnaPath) {
      throw new RepositoryIntelligenceError(
        "Project DNA is not reachable: set PROJECT_DNA_PATH or populate the vendor/Project-DNA submodule and run `pnpm install` under Node 22.23.2. DNAFix does not fabricate repository analysis.",
      );
    }
    const payload = JSON.stringify({ ...input, projectDnaPath: this.projectDnaPath });
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(projectDnaRuntime(), ["--import", "tsx", BRIDGE_PATH], {
        env: { ...process.env, PROJECT_DNA_PATH: this.projectDnaPath },
        windowsHide: true,
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new RepositoryIntelligenceError(`Project DNA bridge timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
      child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new RepositoryIntelligenceError(`Failed to start Project DNA bridge: ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new RepositoryIntelligenceError(`Project DNA bridge exited ${code}: ${err.slice(-2000)}`));
        else resolve(out);
      });
      child.stdin.end(payload);
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new RepositoryIntelligenceError(`Project DNA bridge returned non-JSON output: ${stdout.slice(0, 500)}`);
    }
    const report = RepositoryIntelligenceReportSchema.safeParse(parsed);
    if (!report.success) {
      throw new RepositoryIntelligenceError(`Project DNA bridge output failed validation: ${report.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 1000)}`);
    }
    if (report.data.baseCommitSha.toLowerCase() !== input.baseCommitSha.toLowerCase()) {
      throw new RepositoryIntelligenceError(
        `Commit mismatch: analysis is for ${report.data.baseCommitSha}, run requires ${input.baseCommitSha}. Refusing to reuse stale impact data.`,
      );
    }
    return report.data;
  }
}
