import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeZipArchive, type ZipEntry } from "./zip.js";

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
  // Only real files are packaged. Directories (including git submodule
  // gitlinks) would otherwise recurse into nested repositories, and symlinks
  // are stored as links rather than followed so a link outside the repository
  // cannot leak its target into a bundle.
  const entries: ZipEntry[] = [];
  const files: string[] = [];
  for (const f of listed.filter((entry) => !isExcludedFromBundle(entry))) {
    const info = await lstat(path.join(workspacePath, f)).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink()) {
      entries.push({ path: f, data: Buffer.from(await readlink(path.join(workspacePath, f)), "utf8"), mode: info.mode & 0o777, symlink: true });
      files.push(f);
    } else if (info.isFile()) {
      entries.push({ path: f, data: await readFile(path.join(workspacePath, f)), mode: info.mode & 0o777 });
      files.push(f);
    }
  }
  if (files.length === 0) throw new Error(`Source bundle for ${workspacePath} would be empty after exclusions`);
  const staging = await mkdtemp(path.join(tmpdir(), "dnafix-bundle-"));
  const zipPath = path.join(staging, "source.zip");
  await writeZipArchive(zipPath, entries);
  const sha256 = await sha256File(zipPath);
  return { zipPath, files, sha256, bytes: (await lstat(zipPath)).size };
}
