import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => path.join(root, "packages", name, "src", "index.ts");

export default defineConfig({
  resolve: {
    alias: {
      "@dnafix/contracts": pkg("contracts"),
      "@dnafix/domain": pkg("domain"),
      "@dnafix/persistence": pkg("persistence"),
      "@dnafix/git-engine": pkg("git-engine"),
      "@dnafix/execution": pkg("execution"),
      "@dnafix/verification": pkg("verification"),
      "@dnafix/repository-intelligence": pkg("repository-intelligence"),
      "@dnafix/model-provider": pkg("model-provider"),
      "@dnafix/github": pkg("github"),
      "@dnafix/agent-orchestrator": pkg("agent-orchestrator"),
      "@dnafix/application": pkg("application"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts", "apps/**/*.test.ts"],
    testTimeout: 180_000,
  },
});
