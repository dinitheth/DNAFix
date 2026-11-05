import type { ConfigStatus, GitHubStatus, RepositoryRecord, Run } from "./api";
import { stateLabel, stateTone } from "./status";

export type OnboardingTone = "success" | "warning" | "danger" | "neutral" | "accent";

export interface OnboardingStep {
  id: "model" | "dna" | "execution" | "store" | "github" | "repository" | "first-run";
  title: string;
  label: string;
  tone: OnboardingTone;
  detail: string;
  href: string;
  cta: string;
  /** Required before DNAFix can run an analysis at all. */
  blocking: boolean;
}

const leaf = (value: string | null): string => (value ? (value.split(/[\\/]/).filter(Boolean).pop() ?? value) : "not set");

/** The folder above a binary carries the version (node-v22.23.4-win-x64/node.exe), the leaf never does. */
const parentLeaf = (value: string | null): string => {
  const parts = value ? value.split(/[\\/]/).filter(Boolean) : [];
  return parts.length > 1 ? parts[parts.length - 2]! : leaf(value);
};

/**
 * The zero-to-first-analysis path, in the order the pipeline needs it. Every field
 * is a value the API resolved on this host, so a step cannot be marked done because
 * an operator clicked something.
 */
export function onboardingSteps(config: ConfigStatus | null, github: GitHubStatus | null, repos: RepositoryRecord[], runs: Run[]): OnboardingStep[] {
  const steps: OnboardingStep[] = [];
  const usable = repos.filter((repo) => repo.checkoutState === "present").length;
  const latest = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  steps.push(
    config === null
      ? { id: "model", title: "Planner model", label: "unknown", tone: "neutral", detail: "The API has not answered yet.", href: "/settings#model", cta: "Model settings →", blocking: true }
      : config.model.configured
        ? { id: "model", title: "Planner model", label: "configured", tone: "success", detail: `${config.model.provider} · ${config.model.modelId} · ${config.model.transport}`, href: "/settings#model", cta: "Model settings →", blocking: false }
        : { id: "model", title: "Planner model", label: "missing", tone: "danger", detail: "No MODEL_API_KEY in the API process, so planning blocks and nothing is invented.", href: "/settings#model", cta: "Set MODEL_API_KEY →", blocking: true },
  );

  steps.push(
    config === null
      ? { id: "dna", title: "Project DNA", label: "unknown", tone: "neutral", detail: "The API has not answered yet.", href: "/settings#dna", cta: "Analysis settings →", blocking: true }
      : config.projectDna.configured
        ? { id: "dna", title: "Project DNA", label: "resolved", tone: "success", detail: `${leaf(config.projectDna.path)} · runtime ${parentLeaf(config.projectDna.runtime ?? null)}`, href: "/settings#dna", cta: "Analysis settings →", blocking: false }
        : { id: "dna", title: "Project DNA", label: "missing", tone: "danger", detail: "Structural analysis does not resolve, so runs stop before planning.", href: "/settings#dna", cta: "Resolve Project DNA →", blocking: true },
  );

  if (config) {
    const remote = config.execution.provider === "codebuild";
    steps.push({
      id: "execution",
      title: "Execution",
      label: remote ? (config.execution.remoteConfigured ? "CodeBuild" : "misconfigured") : config.sandboxMode === "docker" ? "Docker sandbox" : "host",
      tone: remote ? (config.execution.remoteConfigured ? "success" : "danger") : config.sandboxMode === "docker" ? "success" : "warning",
      detail: remote
        ? config.execution.remoteConfigured
          ? `${config.execution.project} in ${config.execution.region}`
          : "AWS execution is selected without a project or bucket, so runs cannot build."
        : config.sandboxMode === "docker"
          ? "Repository scripts run in isolated, network-restricted containers."
          : "Repository scripts run directly on this host with no OS isolation.",
      href: "/settings#execution",
      cta: "Execution settings →",
      blocking: remote && !config.execution.remoteConfigured,
    });
    steps.push({
      id: "store",
      title: "Persistence",
      label: config.store ? (config.store.kind === "sqlite" ? "SQLite" : config.store.kind) : "unknown",
      tone: config.store?.kind === "sqlite" ? "success" : "warning",
      detail: config.store ? `${config.store.kind === "sqlite" ? "Shared transactional store" : "Single-process store"} · ${leaf(config.store.location)}` : "The API did not report a store.",
      href: "/settings#workflow",
      cta: "Workflow settings →",
      blocking: config.store?.kind === "file",
    });
  }

  steps.push(githubStep(github));

  steps.push(
    repos.length === 0
      ? { id: "repository", title: "Repository", label: "none", tone: "neutral", detail: "DNAFix registers a repository the first time an analysis is created against its path.", href: "/new", cta: "Choose a repository →", blocking: false }
      : usable === 0
        ? { id: "repository", title: "Repository", label: "unusable", tone: "warning", detail: `${repos.length} registered, none of them a checkout this host can open.`, href: "/repositories", cta: "Review repositories →", blocking: true }
        : { id: "repository", title: "Repository", label: `${usable} ready`, tone: "success", detail: `${usable} of ${repos.length} registered repositories are git checkouts on this host.`, href: "/repositories", cta: "Repositories →", blocking: false },
  );

  steps.push(
    runs.length === 0
      ? { id: "first-run", title: "First analysis", label: "not started", tone: "neutral", detail: "Describe a defect or a change; DNAFix prepares the workspace, the baseline and the analysis before any model runs.", href: "/new", cta: "Start an analysis →", blocking: false }
      : { id: "first-run", title: "Analyses", label: stateLabel(latest?.state ?? "UNKNOWN"), tone: stateTone(latest?.state ?? "UNKNOWN"), detail: `${runs.length} ${runs.length === 1 ? "analysis" : "analyses"} on this host · latest ${stateLabel(latest?.state ?? "UNKNOWN").toLowerCase()}.`, href: `/runs/${latest?.id ?? ""}`, cta: "Open the latest run →", blocking: false },
  );

  return steps;
}

/**
 * GitHub is optional, so the only honest label comes from the connection itself:
 * an App that is configured is not an account that is connected, and draft PRs
 * additionally need a selected installation.
 */
function githubStep(github: GitHubStatus | null): OnboardingStep {
  const base = { id: "github" as const, title: "GitHub (optional)", href: "/connectors/github", cta: "GitHub connector →" };
  if (github === null) return { ...base, label: "unknown", tone: "neutral", detail: "The API has not answered yet.", blocking: false };
  if (!github.configured) return { ...base, label: "not configured", tone: "neutral", detail: `Optional. Missing: ${github.missing.join(", ") || "GitHub App credentials"}.`, blocking: false };
  if (!github.connected) return { ...base, label: "not connected", tone: "neutral", detail: `App ${github.appSlug ?? "configured"} is ready. Without a connection, runs finish as local Git diffs.`, blocking: false };
  if (!github.installation) return { ...base, label: "sign-in only", tone: "warning", detail: `Signed in as ${github.account?.login ?? "unknown"}, but no installation is selected, so draft PRs cannot open.`, blocking: false };
  return { ...base, label: github.account?.login ?? "connected", tone: "success", detail: `Installation ${github.installation.accountLogin} · issues import and draft PRs are available.`, blocking: false };
}
