import { type FileHandle, open } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";

/**
 * Minimal ZIP writer (stored + deflate), used instead of shelling out to `tar`.
 *
 * `tar -a -cf out.zip` only works where tar is bsdtar: GNU tar cannot write
 * zip archives at all, and on Windows Git Bash puts a GNU tar ahead of
 * System32's bsdtar on PATH and then reads `C:\...` as a remote host. Writing
 * the container directly also makes the archive byte-deterministic, so
 * `sourceSha256` describes content rather than the wall clock.
 */
const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_SIG = 0x06054b50;
const VERSION_MADE_BY_UNIX = 0x0314; // 3 = UNIX, 20 = zip 2.0
const VERSION_NEEDED = 20;
const FLAG_UTF8_NAMES = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** 1980-01-01 00:00:00 in MS-DOS date/time fields — the ZIP epoch. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

export interface ZipEntry {
  /** Archive-internal path; separators are normalised to `/`. */
  path: string;
  data: Buffer;
  /** Unix permission bits, e.g. 0o644 or 0o755. */
  mode: number;
  /** Set for symlink entries, whose data is the link target. */
  symlink?: boolean;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function unixMode(entry: ZipEntry): number {
  if (entry.symlink) return 0o120000 | (entry.mode & 0o777);
  return 0o100000 | (entry.mode & 0o777);
}

/** Writes entries sequentially into a ZIP archive at `zipPath`. */
export async function writeZipArchive(zipPath: string, entries: Iterable<ZipEntry>): Promise<{ files: number; bytes: number }> {
  const handle: FileHandle = await open(zipPath, "w");
  try {
    const central: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
      const name = Buffer.from(entry.path.replaceAll("\\", "/"), "utf8");
      const stored = entry.symlink || entry.data.length === 0;
      const deflated = stored ? entry.data : deflateRawSync(entry.data, { level: 9 });
      const useDeflate = !stored && deflated.length < entry.data.length;
      const payload = useDeflate ? deflated : entry.data;
      const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
      const crc = crc32(entry.data);
      const localOffset = offset;

      const local = Buffer.alloc(30);
      local.writeUInt32LE(LOCAL_HEADER_SIG, 0);
      local.writeUInt16LE(VERSION_NEEDED, 4);
      local.writeUInt16LE(FLAG_UTF8_NAMES, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(DOS_TIME, 10);
      local.writeUInt16LE(DOS_DATE, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(payload.length, 18);
      local.writeUInt32LE(entry.data.length, 22);
      local.writeUInt16LE(name.length, 26);
      await handle.write(local, 0, local.length, offset);
      offset += local.length;
      await handle.write(name, 0, name.length, offset);
      offset += name.length;
      if (payload.length > 0) {
        await handle.write(payload, 0, payload.length, offset);
        offset += payload.length;
      }

      const record = Buffer.alloc(46);
      record.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
      record.writeUInt16LE(VERSION_MADE_BY_UNIX, 4);
      record.writeUInt16LE(VERSION_NEEDED, 6);
      record.writeUInt16LE(FLAG_UTF8_NAMES, 8);
      record.writeUInt16LE(method, 10);
      record.writeUInt16LE(DOS_TIME, 12);
      record.writeUInt16LE(DOS_DATE, 14);
      record.writeUInt32LE(crc, 16);
      record.writeUInt32LE(payload.length, 20);
      record.writeUInt32LE(entry.data.length, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt32LE((unixMode(entry) << 16) >>> 0, 38);
      record.writeUInt32LE(localOffset, 42);
      central.push(Buffer.concat([record, name]));
    }

    const directory = Buffer.concat(central);
    const directoryOffset = offset;
    await handle.write(directory, 0, directory.length, directoryOffset);
    offset += directory.length;

    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_CENTRAL_SIG, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(directoryOffset, 16);
    await handle.write(end, 0, end.length, offset);
    return { files: central.length, bytes: offset + end.length };
  } finally {
    await handle.close();
  }
}
