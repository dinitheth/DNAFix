/** Creates a git-initialized copy of the fixture repo at .data/fixture-repo for the offline demo. */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const dest = path.resolve(process.cwd(), ".data", "fixture-repo");
if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
cpSync(path.resolve(process.cwd(), "tests", "fixtures", "sample-repo"), dest, { recursive: true });
const git = (args: string[]) => execFileSync("git", args, { cwd: dest, stdio: "inherit" });
git(["init", "-b", "main"]);
git(["config", "user.email", "demo@dnafix.local"]);
git(["config", "user.name", "DNAFix Demo"]);
git(["add", "-A"]);
git(["commit", "-m", "Fixture: sample-shop with percentage-discount bug"]);
console.log(`Fixture repo ready at ${dest}`);
