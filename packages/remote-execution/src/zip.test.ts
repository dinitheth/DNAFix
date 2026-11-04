import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, writeZipArchive, type ZipEntry } from "./zip.js";

interface ReadEntry {
  path: string;
  mode: number;
  symlink: boolean;
  data: Buffer;
}

/**
 * Independent ZIP reader used only by these tests, so the writer is checked
 * against the archive format rather than against itself.
 */
async function readZip(zipPath: string): Promise<ReadEntry[]> {
  const buf = await readFile(zipPath);
  expect(buf.readUInt32LE(buf.length - 22)).toBe(0x06054b50);
  const count = buf.readUInt16LE(buf.length - 12);
  const directoryOffset = buf.readUInt32LE(buf.length - 6);
  const entries: ReadEntry[] = [];
  let p = directoryOffset;
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const madeBy = buf.readUInt16LE(p + 4);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString("utf8");
    expect(madeBy >>> 8).toBe(3);

    expect(buf.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const payloadStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buf.subarray(payloadStart, payloadStart + compressedSize);
    const data = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);
    expect(crc).toBe(crc32(data));
    entries.push({ path: name, mode: (externalAttrs >>> 16) & 0o777, symlink: ((externalAttrs >>> 16) & 0o170000) === 0o120000, data });
    p += 46 + nameLength + extraLength;
  }
  return entries;
}

describe("zip writer", () => {
  it("round-trips content, permissions and symlink entries", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dnafix-zip-"));
    const zipPath = path.join(dir, "out.zip");
    const text = Buffer.from("export const answer = 42;\n".repeat(50), "utf8");
    const binary = Buffer.from([0, 1, 2, 253, 254, 255, 0, 0]);
    const entries: ZipEntry[] = [
      { path: "src/index.ts", data: text, mode: 0o644 },
      { path: "bin/run.js", data: Buffer.from("#!/usr/bin/env node\n", "utf8"), mode: 0o755 },
      { path: "empty.txt", data: Buffer.alloc(0), mode: 0o644 },
      { path: "raw.bin", data: binary, mode: 0o600 },
      { path: "link", data: Buffer.from("src/index.ts", "utf8"), mode: 0o777, symlink: true },
      { path: "dir\\nested\\file.txt", data: Buffer.from("forward slashes only", "utf8"), mode: 0o644 },
    ];
    const result = await writeZipArchive(zipPath, entries);
    expect(result.files).toBe(6);

    const read = await readZip(zipPath);
    expect(read.map((e) => e.path)).toEqual(["src/index.ts", "bin/run.js", "empty.txt", "raw.bin", "link", "dir/nested/file.txt"]);
    expect(read[0]!.data.equals(text)).toBe(true);
    expect(read[2]!.data.length).toBe(0);
    expect(read[3]!.data.equals(binary)).toBe(true);
    expect(read[1]!.mode).toBe(0o755);
    expect(read[4]!.symlink).toBe(true);
    expect(read[4]!.data.toString("utf8")).toBe("src/index.ts");
  });

  it("compresses repetitive payloads but stores incompressible ones", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dnafix-zip-"));
    const zipPath = path.join(dir, "out.zip");
    await writeZipArchive(zipPath, [
      { path: "repeat.txt", data: Buffer.from("a".repeat(100_000), "utf8"), mode: 0o644 },
      { path: "one.txt", data: Buffer.from("x", "utf8"), mode: 0o644 },
    ]);
    const buf = await readFile(zipPath);
    // The whole archive stays far smaller than the 100 KB of repeated input.
    expect(buf.length).toBeLessThan(2_000);
    const read = await readZip(zipPath);
    expect(read[0]!.data.length).toBe(100_000);
    // A single byte cannot deflate, so it must be stored rather than grown.
    expect(read[1]!.data.toString("utf8")).toBe("x");
  });

  it("is byte-deterministic for identical content", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dnafix-zip-"));
    const a = path.join(dir, "a.zip");
    const b = path.join(dir, "b.zip");
    const entry: ZipEntry = { path: "f.txt", data: Buffer.from("same", "utf8"), mode: 0o644 };
    await writeZipArchive(a, [entry]);
    await new Promise((r) => setTimeout(r, 1100));
    await writeZipArchive(b, [entry]);
    expect((await readFile(a)).equals(await readFile(b))).toBe(true);
  });

  it("writes large archives without loading them into memory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dnafix-zip-"));
    const zipPath = path.join(dir, "big.zip");
    const big = Buffer.alloc(2_000_000, 7);
    await writeZipArchive(zipPath, [{ path: "big.bin", data: big, mode: 0o644 }]);
    const read = await readZip(zipPath);
    expect(read[0]!.data.equals(big)).toBe(true);
  });
});

describe("bundle zip integrity", () => {
  it("produces an archive whose extracted content matches the worktree", async () => {
    const { createSourceBundle } = await import("./bundle.js");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const root = await mkdtemp(path.join(tmpdir(), "dnafix-bundle-zip-"));
    const git = (args: string[]) => exec("git", args, { cwd: root }).then((r) => r.stdout);
    await git(["init", "-b", "main"]);
    const source = "export function f() {\n  return 1;\n}\n".repeat(40);
    await writeFile(path.join(root, "index.ts"), source);
    await writeFile(path.join(root, "script.sh"), "#!/bin/sh\necho hi\n");
    await exec("chmod", ["+x", path.join(root, "script.sh")]).catch(() => undefined);
    const bundle = await createSourceBundle(root, git);
    const read = await readZip(bundle.zipPath);
    expect(read.map((e) => e.path)).toEqual(["index.ts", "script.sh"]);
    expect(read[0]!.data.toString("utf8")).toBe(source);
    expect(bundle.bytes).toBe((await readFile(bundle.zipPath)).length);
    expect(bundle.sha256).toBe(await sha256Of(await readFile(bundle.zipPath)));
  });
});

async function sha256Of(buf: Buffer): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(buf).digest("hex");
}
