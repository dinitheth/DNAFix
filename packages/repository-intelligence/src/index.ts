import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RepositoryIntelligenceReportSchema, type RepositoryIntelligenceReport } from "@dnafix/contracts";

/**
 * Default Project DNA location resolution:
 * 1. PROJECT_DNA_PATH (explicit, always wins)
 * 2. vendor/Project-DNA git submodule at the DNAFix repository root
 * Project DNA is consumed only through its public IProjectDNAService API;
 * its source is never copied into DNAFix packages (ADR-0002).
 */
export function resolveProjectDnaPath(explicit = process.env.PROJECT_DNA_PATH ?? ""): string {
  if (explicit) return explicit;
  const candidate = path.resolve(process.cwd(), "vendor", "Project-DNA");
  return existsSync(path.join(candidate, "packages", "dna-core", "src", "index.ts")) ? candidate : "";
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
  analyze(input: { rootPath: string; baseCommitSha: string; targetPaths: string[]; changedPaths?: string[] }): Promise<RepositoryIntelligenceReport>;
}

const BRIDGE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bridge", "project-dna-bridge.ts");

/**
 * Adapter over Project DNA's public IProjectDNAService, executed out-of-process
 * against a Project DNA checkout (PROJECT_DNA_PATH). See ADR-0002.
 * Never falls back to fabricated analysis: misconfiguration fails the run.
 */
export class ProjectDNAAdapter implements RepositoryIntelligence {
  readonly providerName = "project-dna";
  constructor(
    private readonly projectDnaPath = resolveProjectDnaPath(),
    private readonly timeoutMs = Number(process.env.PROJECT_DNA_TIMEOUT_MS ?? 600_000),
  ) {}

  async analyze(input: { rootPath: string; baseCommitSha: string; targetPaths: string[]; changedPaths?: string[] }): Promise<RepositoryIntelligenceReport> {
    if (!this.projectDnaPath) {
      throw new RepositoryIntelligenceError(
        "PROJECT_DNA_PATH is not set. Clone https://github.com/dinitheth/Project-DNA, run `pnpm install` under Node 22.23.2, and set PROJECT_DNA_PATH to that checkout. DNAFix does not fabricate repository analysis.",
      );
    }
    const payload = JSON.stringify({ ...input, projectDnaPath: this.projectDnaPath });
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", BRIDGE_PATH], {
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
