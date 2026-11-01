import { AlertTriangle, FolderGit2, GitBranch } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ReadinessPanel, useConfigStatus } from "../components/ReadinessPanel";
import { Button, Field, Input, Textarea } from "../components/ui";
import { api, type Run } from "../lib/api";
import { blockingReasons } from "../lib/status";

type Source = "local" | "github";

export function NewAnalysis() {
  const navigate = useNavigate();
  const config = useConfigStatus();
  const [source, setSource] = useState<Source>("local");
  const [repositoryPath, setRepositoryPath] = useState("");
  const [githubOwner, setGithubOwner] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [issueTitle, setIssueTitle] = useState("");
  const [issueBody, setIssueBody] = useState("");
  const [issueNumber, setIssueNumber] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const blockers = config.data ? blockingReasons(config.data) : [];
  const githubConfigured = config.data?.github.configured ?? false;

  function validate(): Record<string, string> {
    const next: Record<string, string> = {};
    if (source === "local" && !repositoryPath.trim()) next.repositoryPath = "Enter the path to a local Git repository.";
    if (source === "github") {
      if (!githubOwner.trim()) next.githubOwner = "Enter the repository owner.";
      if (!githubRepo.trim()) next.githubRepo = "Enter the repository name.";
    }
    if (!issueTitle.trim()) next.issueTitle = "Give the issue a short, specific title.";
    if (!issueBody.trim()) next.issueBody = "Describe the problem, expected behavior, and how success will be judged.";
    if (issueNumber && (!/^\d+$/.test(issueNumber) || Number(issueNumber) < 1)) next.issueNumber = "Issue number must be a positive integer.";
    return next;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const validation = validate();
    setErrors(validation);
    if (Object.keys(validation).length > 0) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const run = await api<Run>("/runs", {
        method: "POST",
        body: JSON.stringify({
          repositoryPath: source === "local" ? repositoryPath.trim() : undefined,
          githubOwner: source === "github" ? githubOwner.trim() : undefined,
          githubRepo: source === "github" ? githubRepo.trim() : undefined,
          issueTitle: issueTitle.trim(),
          issueBody: issueBody.trim(),
          issueNumber: issueNumber ? Number(issueNumber) : undefined,
        }),
      });
      navigate(`/runs/${run.id}`);
    } catch (err) {
      // Entered content is preserved; only the error is surfaced.
      setServerError((err as Error).message);
      setSubmitting(false);
    }
  }

  const submitDisabled = submitting || !config.data || blockers.length > 0;

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">New analysis</h1>
        <p className="mt-1 text-sm text-text-secondary">Understand a repository, investigate an issue, and prepare a verified engineering change.</p>
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,720px)_300px]">
        <form onSubmit={submit} noValidate className="min-w-0 rounded-lg border border-border bg-surface">
          <fieldset className="border-b border-border px-5 py-4">
            <legend className="float-left mr-3 pt-0.5 text-[13px] font-semibold">Repository</legend>
            <div className="clear-both pt-2">
              <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-background p-1" role="tablist" aria-label="Repository source">
                {(
                  [
                    { id: "local", label: "Local repository", icon: FolderGit2 },
                    { id: "github", label: "GitHub repository", icon: GitBranch },
                  ] as const
                ).map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={source === id}
                    onClick={() => setSource(id)}
                    className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-[13px] font-medium transition-colors ${
                      source === id ? "bg-surface-elevated text-text-primary ring-1 ring-border-strong" : "text-text-secondary hover:text-text-primary"
                    }`}
                  >
                    <Icon size={15} aria-hidden /> {label}
                  </button>
                ))}
              </div>

              <div className="mt-4 space-y-4">
                {source === "local" && (
                  <Field label="Repository path" hint="An absolute path to a Git repository, accessible to the DNAFix server process. DNAFix analyses the exact committed state; uncommitted changes are not required." error={errors.repositoryPath}>
                    <Input
                      value={repositoryPath}
                      onChange={(e) => setRepositoryPath(e.target.value)}
                      placeholder="G:\projects\my-service"
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={Boolean(errors.repositoryPath)}
                    />
                  </Field>
                )}
                {source === "github" && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Owner" error={errors.githubOwner}>
                        <Input value={githubOwner} onChange={(e) => setGithubOwner(e.target.value)} placeholder="acme" autoComplete="off" spellCheck={false} aria-invalid={Boolean(errors.githubOwner)} />
                      </Field>
                      <Field label="Repository" error={errors.githubRepo}>
                        <Input value={githubRepo} onChange={(e) => setGithubRepo(e.target.value)} placeholder="billing-api" autoComplete="off" spellCheck={false} aria-invalid={Boolean(errors.githubRepo)} />
                      </Field>
                    </div>
                    {config.data && !githubConfigured && (
                      <p className="flex gap-2 rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-warning">
                        <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
                        <span>
                          GitHub App is not configured. Public repositories can still be cloned and analysed, but draft pull-request creation will be unavailable — verified runs
                          will complete as a local patch. Configure the GitHub App to enable draft PRs.
                        </span>
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </fieldset>

          <fieldset className="border-b border-border px-5 py-4">
            <legend className="float-left mr-3 pt-0.5 text-[13px] font-semibold">Issue</legend>
            <div className="clear-both space-y-4 pt-2">
              <Field label="Issue title" error={errors.issueTitle}>
                <Input value={issueTitle} onChange={(e) => setIssueTitle(e.target.value)} placeholder="Percentage discounts are calculated as flat amounts" aria-invalid={Boolean(errors.issueTitle)} />
              </Field>
              <Field
                label="Issue description"
                hint="State the problem, the expected behavior, and acceptance criteria. DNAFix plans against this text and the repository's deterministic analysis — precise criteria produce verifiable results."
                error={errors.issueBody}
              >
                <Textarea value={issueBody} onChange={(e) => setIssueBody(e.target.value)} rows={9} placeholder={"Bug: a 10% discount on a 200 item charges 190 instead of 180.\n\nExpected: applyDiscount(200, 10) === 180.\nAcceptance: existing test suite passes."} aria-invalid={Boolean(errors.issueBody)} />
              </Field>
              <div className="max-w-[220px]">
                <Field label="GitHub issue number (optional)" error={errors.issueNumber}>
                  <Input value={issueNumber} onChange={(e) => setIssueNumber(e.target.value)} inputMode="numeric" placeholder="142" aria-invalid={Boolean(errors.issueNumber)} />
                </Field>
              </div>
            </div>
          </fieldset>

          <div className="px-5 py-4">
            {blockers.length > 0 && (
              <div className="mb-3 rounded-md border border-red-500/25 bg-red-500/5 px-3.5 py-2.5" role="alert">
                <p className="text-[13px] font-medium text-danger">Analysis cannot start yet</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-text-secondary">
                  {blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            )}
            {serverError && (
              <p className="mb-3 rounded-md border border-red-500/25 bg-red-500/5 px-3.5 py-2.5 text-[13px] text-danger" role="alert">
                The API rejected this submission: {serverError}. Your input has been preserved — fix the problem and try again.
              </p>
            )}
            <div className="flex items-center gap-3">
              <Button type="submit" variant="primary" loading={submitting} disabled={submitDisabled} className="px-5">
                Start analysis
              </Button>
              <p className="text-xs text-text-muted">
                {blockers.length > 0 ? "Resolve the blockers on the right to continue." : "DNAFix analyses the repository first. You approve the plan before any code changes."}
              </p>
            </div>
          </div>
        </form>

        <aside className="min-w-0">
          <ReadinessPanel config={config.data} />
          <div className="mt-5 rounded-lg border border-border bg-surface px-4 py-3">
            <h2 className="text-[13px] font-semibold">What happens next</h2>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-text-secondary">
              <li>The repository is pinned to an exact commit and baseline tests are recorded.</li>
              <li>Project DNA analyses architecture and structural impact.</li>
              <li>The AI planner proposes a plan for your approval.</li>
              <li>Coding agents work in isolated worktrees; results are verified with real test executions.</li>
              <li>You review the verified patch before anything is published.</li>
            </ol>
          </div>
        </aside>
      </div>
    </div>
  );
}
