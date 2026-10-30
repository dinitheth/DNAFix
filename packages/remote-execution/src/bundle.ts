import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Source bundle packaging for cloud execution.
 * File list comes from `git ls-files --cached --others --exclude-standard`
 * (tracked + untracked, gitignore-aware) and is then filtered by hard
 * exclusions. Secrets and credentials can never enter a bundle by design:
 * .env files, key material and credential filenames are always excluded.
 */
export const EXCLUDED_SEGMENTS = new Set([".git", "node_modules", ".data", ".turbo", ".cache", "coverage", "dist"]);
const SECRET_FILE_PATTERNS = [/^\.env($|\.)/, /\.pem$/i, /\.key$/i, /(^|\/)id_rsa/, /(^|\/)id_ed25519/, /credentials/i, /\.aws($|\/)/];

export function isExcludedFromBundle(repoRelativePath: string): boolean {
  const normalized = repoRelativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((s) => EXCLUDED_SEGMENTS.has(s))) return true;
  const base = segments[segments.length - 1] ?? "";
  if (SECRET_FILE_PATTERNS.some((re) => re.test(normalized) || re.test(base))) return true;
  if (base.endsWith(".log")) return true;
  return false;
}

export function s3KeysForRun(runId: string): { sourceKey: string; manifestKey: string; artifactsPrefix: string; reportsPrefix: string } {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-_]{0,127}$/.test(runId)) throw new Error(`Invalid runId for S3 layout: ${runId}`);
  const base = `runs/${runId}`;
  return {
    sourceKey: `${base}/source.zip`,
    manifestKey: `${base}/manifest.json`,
    artifactsPrefix: `${base}/artifacts/`,
    reportsPrefix: `${base}/reports/`,
  };
}

function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { shell: false, windowsHide: true });
    let err = "";
    child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar ${args.join(" ")} exited ${code}: ${err.slice(0, 400)}`))));
  });
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on("data", (chunk: Buffer | string) => hash.update(chunk))
      .on("end", resolve)
      .on("error", reject);
  });
  return hash.digest("hex");
}

export interface BundleResult {
  zipPath: string;
  files: string[];
  sha256: string;
  bytes: number;
}

export async function createSourceBundle(workspacePath: string, gitRunner: (args: string[]) => Promise<string>): Promise<BundleResult> {
  const listed = (await gitRunner(["ls-files", "--cached", "--others", "--exclude-standard"]))
    .split("\n")
    .map((s) => s.trim().replaceAll("\\", "/"))
    .filter(Boolean)
    .sort();
  const files = listed.filter((f) => !isExcludedFromBundle(f));
  if (files.length === 0) throw new Error(`Source bundle for ${workspacePath} would be empty after exclusions`);
  const staging = await mkdtemp(path.join(tmpdir(), "dnafix-bundle-"));
  const listPath = path.join(staging, "files.txt");
  const zipPath = path.join(staging, "source.zip");
  await writeFile(listPath, files.join("\n"), "utf8");
  await runTar(["-a", "-cf", zipPath, "-C", workspacePath, "-T", listPath]);
  const { stat } = await import("node:fs/promises");
  const sha256 = await sha256File(zipPath);
  return { zipPath, files, sha256, bytes: (await stat(zipPath)).size };
}
