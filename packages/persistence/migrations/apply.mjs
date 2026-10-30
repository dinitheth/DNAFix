// Applies SQL migrations to DATABASE_URL using the `pg` driver if installed.
// Fails loudly when DATABASE_URL or the driver is unavailable — no silent fallback.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("db:migrate: DATABASE_URL is not set. Local development uses the file store and does not need this command.");
  process.exit(1);
}
let pg;
try {
  pg = await import("pg");
} catch {
  console.error("db:migrate: the 'pg' package is not installed. Add it (pnpm add -w pg) to use PostgreSQL persistence.");
  process.exit(1);
}
const dir = path.dirname(fileURLToPath(import.meta.url));
const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
const client = new pg.default.Client({ connectionString: url });
await client.connect();
try {
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), "utf8");
    await client.query(sql);
    console.log(`applied ${file}`);
  }
} finally {
  await client.end();
}
