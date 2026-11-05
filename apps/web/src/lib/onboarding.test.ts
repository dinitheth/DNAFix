import { describe, expect, it } from "vitest";
import type { ConfigStatus, GitHubStatus, RepositoryRecord, Run } from "./api";
import { onboardingSteps } from "./onboarding";

const config = (over: Partial<ConfigStatus> = {}): ConfigStatus => ({
  model: { provider: "meta-muse-wonder", modelId: "muse-wonder-1.0", subAgentModelId: "muse-spark-1.3", configured: true, transport: "responses", baseUrl: "https://api.meta.ai/v1" },
  projectDna: { configured: true, path: "G:\\DNAFix\\vendor\\Project-DNA", runtime: "G:\\DNAFix\\.tools\\node-v22.23.4-win-x64\\node.exe" },
  github: { configured: false, appConfigured: true, userIntegrationConfigured: false, missing: [], slug: "dnafix-dev" },
  sandboxMode: "docker",
  execution: { provider: "local", remoteConfigured: false, project: null, bucket: null, region: "ap-southeast-2" },
  workflowEngine: "in-process-durable",
  temporalAddress: null,
  store: { kind: "sqlite", location: "G:\\DNAFix\\.data\\dnafix.sqlite" },
  security: { bind: "127.0.0.1:3001", remoteBind: false, lanBindAllowed: false, sessionTokenRequired: false, repositoryRoots: [], webhookSecretConfigured: false, tokenEncryptionKeyConfigured: true, corsOrigin: "http://localhost:5173" },
  ...over,
});

const github = (over: Partial<GitHubStatus> = {}): GitHubStatus => ({
  configured: true,
  missing: [],
  appSlug: "dnafix-dev",
  webBaseUrl: "http://localhost:5173",
  connected: false,
  account: null,
  installation: null,
  tokenExpiresAt: null,
  refreshTokenExpiresAt: null,
  authorizationExpired: false,
  lastVerifiedAt: null,
  ...over,
});

const repo = (over: Partial<RepositoryRecord> = {}): RepositoryRecord => ({
  id: "local_1",
  localPath: "G:\\repos\\app",
  githubOwner: null,
  githubRepo: null,
  defaultBranch: null,
  lastAnalyzedCommitSha: null,
  createdAt: "2026-11-05T00:00:00.000Z",
  checkoutState: "present",
  ...over,
});

const run = (over: Partial<Run>): Run =>
  ({
    id: "run_1",
    state: "BLOCKED",
    createdAt: "2026-11-05T01:00:00.000Z",
    ...over,
  }) as Run;

const byId = (steps: ReturnType<typeof onboardingSteps>, id: string) => steps.find((step) => step.id === id)!;

describe("onboarding steps", () => {
  it("reports nothing as done while the API is unreachable", () => {
    const steps = onboardingSteps(null, null, [], []);
    expect(byId(steps, "model")).toMatchObject({ label: "unknown", tone: "neutral", blocking: true });
    expect(byId(steps, "dna").blocking).toBe(true);
    expect(steps.filter((s) => s.tone === "success")).toHaveLength(0);
    // Execution and persistence need a live answer, so they are absent rather than guessed.
    expect(byId(steps, "execution")).toBeUndefined();
    expect(byId(steps, "github").label).toBe("unknown");
  });

  it("marks a ready host done and reads GitHub from the connection, not the App config", () => {
    const steps = onboardingSteps(config(), github(), [], []);
    expect(byId(steps, "model")).toMatchObject({ label: "configured", tone: "success", detail: "meta-muse-wonder · muse-wonder-1.0 · responses" });
    // The runtime version lives in the parent folder; the leaf is just node.exe.
    expect(byId(steps, "dna").detail).toBe("Project-DNA · runtime node-v22.23.4-win-x64");
    expect(byId(steps, "execution")).toMatchObject({ label: "Docker sandbox", tone: "success" });
    expect(byId(steps, "store").label).toBe("SQLite");
    expect(byId(steps, "github")).toMatchObject({ label: "not connected", tone: "neutral" });
    expect(byId(steps, "repository").label).toBe("none");
    expect(byId(steps, "first-run").label).toBe("not started");
  });

  it("separates a configured App, a sign-in without installation and a full connection", () => {
    expect(byId(onboardingSteps(config(), github({ configured: false, missing: ["GITHUB_APP_ID"] }), [], []), "github")).toMatchObject({ label: "not configured", detail: "Optional. Missing: GITHUB_APP_ID." });
    const signedIn = byId(onboardingSteps(config(), github({ connected: true, account: { id: 1, login: "dinitheth", name: null, avatarUrl: null, htmlUrl: "" } }), [], []), "github");
    expect(signedIn).toMatchObject({ label: "sign-in only", tone: "warning", blocking: false });
    expect(signedIn.detail).toMatch(/no installation is selected/);
    const full = byId(onboardingSteps(config(), github({ connected: true, account: { id: 1, login: "dinitheth", name: null, avatarUrl: null, htmlUrl: "" }, installation: { id: 2, accountLogin: "dinitheth", accountType: "User" } }), [], []), "github");
    expect(full).toMatchObject({ label: "dinitheth", tone: "success" });
  });

  it("downgrades host execution and the file store to attention, and blocks a misconfigured provider", () => {
    expect(byId(onboardingSteps(config({ sandboxMode: "host" }), github(), [], []), "execution")).toMatchObject({ label: "host", tone: "warning" });
    expect(byId(onboardingSteps(config({ store: { kind: "file", location: "C:\\tmp\\x.json" } }), github(), [], []), "store").tone).toBe("warning");
    const broken = byId(onboardingSteps(config({ execution: { provider: "codebuild", remoteConfigured: false, project: null, bucket: null, region: "ap-southeast-2" } }), github(), [], []), "execution");
    expect(broken).toMatchObject({ label: "misconfigured", tone: "danger", blocking: true });
  });

  it("counts only repositories this host can actually open", () => {
    const mixed = onboardingSteps(config(), github(), [repo(), repo({ id: "local_2", localPath: "G:gone", checkoutState: "missing" })], []);
    expect(byId(mixed, "repository")).toMatchObject({ label: "1 ready", tone: "success" });
    const dead = byId(onboardingSteps(config(), github(), [repo({ checkoutState: "missing" })], []), "repository");
    expect(dead).toMatchObject({ label: "unusable", tone: "warning", blocking: true });
  });

  it("names the latest run state once an analysis exists", () => {
    const steps = onboardingSteps(config(), github(), [repo()], [run({ id: "run_old", state: "CANCELLED", createdAt: "2026-11-04T00:00:00.000Z" }), run({ id: "run_new", state: "AWAITING_PLAN_APPROVAL", createdAt: "2026-11-05T00:00:00.000Z" })]);
    const first = byId(steps, "first-run");
    expect(first.title).toBe("Analyses");
    expect(first.label).toBe("Awaiting plan approval");
    expect(first.href).toBe("/runs/run_new");
    expect(first.detail).toBe("2 analyses on this host · latest awaiting plan approval.");
  });
});
