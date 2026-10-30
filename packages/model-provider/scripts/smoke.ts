/** Real-model smoke test. Requires MODEL_API_KEY. Prints only validated output + usage, never the key. */
import { MetaModelProvider } from "../src/index.js";

const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) {
  console.error("model:smoke BLOCKED: MODEL_API_KEY is not set. Muse Wonder endpoint has NOT been tested.");
  process.exit(2);
}
const baseURL = (process.env.MODEL_API_BASE_URL ?? "https://api.meta.ai/v1").replace(/\/$/, "");
const model = process.env.MUSE_WONDER_MODEL ?? "muse-wonder-1.0";
const listRes = await fetch(`${baseURL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
if (!listRes.ok) {
  console.error(`model:smoke FAILED: GET /models returned HTTP ${listRes.status}: ${(await listRes.text()).slice(0, 300)}`);
  process.exit(1);
}
const models = (await listRes.json()) as { data?: Array<{ id: string }> };
console.log("models:", (models.data ?? []).map((m) => m.id).join(", "));
if (!(models.data ?? []).some((m) => m.id === model)) {
  console.error(`model:smoke FAILED: ${model} not present in /v1/models for this key.`);
  process.exit(1);
}
const provider = new MetaModelProvider({});
const out = await provider.analyzeAndPlan({
  issueTitle: "Smoke test issue",
  issueBody: "A greeting function returns 'hello' but should return 'Hello'. Propose a minimal plan.",
  baseCommitSha: "1234567",
  repositorySnapshotId: "smoke",
  intelligence: {
    repositoryId: "smoke",
    baseCommitSha: "1234567",
    analysisVersion: 1,
    analyzedAt: new Date().toISOString(),
    architecture: { layers: [], patterns: [], summary: "smoke" },
    criticalComponents: [],
    risks: [],
    languages: ["TypeScript"],
    files: ["src/greet.ts"],
    targets: [],
    workingTree: null,
    complete: true,
    warnings: [],
  },
  fileExcerpts: [{ path: "src/greet.ts", content: "export const greet = () => 'hello';" }],
});
console.log(JSON.stringify(out, null, 2));
console.log(`usage: ${JSON.stringify(provider.lastUsage)}`);
console.log(`model:smoke OK via ${baseURL} transport=${process.env.MODEL_TRANSPORT ?? "responses"} model=${model}`);
