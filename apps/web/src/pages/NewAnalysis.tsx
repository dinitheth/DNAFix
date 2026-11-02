import { AlertTriangle, FolderOpen, GitBranch, Play, Terminal } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ReadinessPanel, useConfigStatus } from "../components/ReadinessPanel";
import { Button, Field, Input, SectionLabel, Textarea } from "../components/ui";
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
  const submitDisabled = submitting || !config.data || blockers.length > 0;

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

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (submitting || submitDisabled) return;
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
      setServerError((err as Error).message);
      setSubmitting(false);
    }
  }

  // Ctrl/Cmd+Enter submits, as indicated on the primary action.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <div>
      <header className="mb-6 border-b border-border pb-5">
        <h1 className="text-xl font-semibold tracking-tight text-text-primary">New Analysis</h1>
        <p className="mt-1 max-w-2xl text-sm text-text-secondary">Understand the repository. Investigate the issue. Prepare a verified engineering change with reproducible telemetry.</p>
      </header>

      <div className="grid items-start gap-5 lg:grid-cols-12">
        <form onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-5 lg:col-span-8">
          {/* 01 / Repository source */}
          <section className="rounded-xl border border-border bg-surface p-5 shadow-sm" aria-label="Repository source">
            <div className="mb-4 flex items-center justify-between">
              <SectionLabel index="01">Repository Source</SectionLabel>
            </div>
            <div className="mb-5 grid max-w-md grid-cols-2 gap-1 rounded-lg border border-border bg-background p-1" role="tablist" aria-label="Repository source">
              {(
                [
                  { id: "local", label: "Local repository", icon: FolderOpen },
                  { id: "github", label: "GitHub repository", icon: GitBranch },
                ] as const
              ).map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={source === id}
                  onClick={() => setSource(id)}
                  className={`flex items-center justify-center gap-2 rounded-md px-3 py-1 text-[13px] transition-all ${
                    source === id
                      ? "border border-border-strong bg-surface-elevated font-medium text-text-primary shadow-sm"
                      : "border border-transparent text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                  }`}
                >
                  <Icon size={15} className={source === id ? "text-accent-soft" : ""} aria-hidden /> {label}
                </button>
              ))}
            </div>

            {source === "local" && (
              <Field
                label={
                  <>
                    Repository path <span className="text-danger">*</span>
                  </>
                }
                hint="Absolute filesystem path to a local Git repository accessible to the server. The working tree will not be mutated."
                error={errors.repositoryPath}
              >
                <span className="relative block">
                  <Terminal size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden />
                  <Input
                    value={repositoryPath}
                    onChange={(e) => setRepositoryPath(e.target.value)}
                    placeholder="G:\projects\my-service"
                    className="pl-9 font-mono text-[13px]"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={Boolean(errors.repositoryPath)}
                  />
                </span>
              </Field>
            )}
            {source === "github" && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Owner" error={errors.githubOwner}>
                    <Input value={githubOwner} onChange={(e) => setGithubOwner(e.target.value)} placeholder="acme" className="font-mono text-[13px]" autoComplete="off" spellCheck={false} aria-invalid={Boolean(errors.githubOwner)} />
                  </Field>
                  <Field label="Repository" error={errors.githubRepo}>
                    <Input value={githubRepo} onChange={(e) => setGithubRepo(e.target.value)} placeholder="billing-api" className="font-mono text-[13px]" autoComplete="off" spellCheck={false} aria-invalid={Boolean(errors.githubRepo)} />
                  </Field>
                </div>
                {config.data && !githubConfigured && (
                  <p className="mt-3 flex gap-2 rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-warning">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
                    <span>
                      GitHub App is not configured. Public repositories can still be cloned and analysed, but draft pull-request creation will be unavailable — verified runs will
                      complete as local diffs. Configure the GitHub App to enable automated PR generation.
                    </span>
                  </p>
                )}
              </>
            )}
          </section>

          {/* 02 / Issue specification */}
          <section className="rounded-xl border border-border bg-surface p-5 shadow-sm" aria-label="Issue specification">
            <div className="mb-4 flex items-center justify-between">
              <SectionLabel index="02">Issue Specification</SectionLabel>
            </div>
            <div className="flex flex-col gap-5">
              <Field
                label={
                  <span className="flex items-center justify-between">
                    <span>Issue summary</span>
                    <span className="font-mono text-[11px] font-normal text-text-muted">{issueTitle.length} chars</span>
                  </span>
                }
                error={errors.issueTitle}
              >
                <Input value={issueTitle} onChange={(e) => setIssueTitle(e.target.value)} placeholder="Percentage discounts are calculated as flat amounts" aria-invalid={Boolean(errors.issueTitle)} />
              </Field>
              <Field
                label={
                  <span className="flex items-center justify-between">
                    <span>Detailed reproduction &amp; acceptance criteria</span>
                    <span className="text-[11px] font-normal text-text-muted">Markdown enabled</span>
                  </span>
                }
                hint="State the failure mechanism, expected behavior, and verification boundary. Deterministic patch generation depends on precise invariants."
                error={errors.issueBody}
              >
                <Textarea
                  value={issueBody}
                  onChange={(e) => setIssueBody(e.target.value)}
                  rows={7}
                  placeholder={"Bug: a 10% discount on a 200 item charges 190 instead of 180.\n\nExpected: applyDiscount(200, 10) === 180.\nAcceptance: existing test suite passes with regression coverage."}
                  aria-invalid={Boolean(errors.issueBody)}
                />
              </Field>
              <div className="rounded-lg border border-border bg-background p-4">
                <div className="max-w-[260px]">
                  <Field label={<span className="text-xs font-normal text-text-secondary">Issue tracking reference (Optional)</span>} error={errors.issueNumber}>
                    <span className="relative block">
                      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-xs text-text-muted" aria-hidden>
                        #
                      </span>
                      <Input value={issueNumber} onChange={(e) => setIssueNumber(e.target.value)} inputMode="numeric" placeholder="e.g. 142" className="pl-6 font-mono text-[13px]" aria-invalid={Boolean(errors.issueNumber)} />
                    </span>
                  </Field>
                </div>
              </div>
            </div>
          </section>

          {/* 03 / Execution action bar */}
          <section className="flex flex-col items-stretch justify-between gap-4 rounded-xl border border-border bg-surface p-5 shadow-sm sm:flex-row sm:items-center" aria-label="Start analysis">
            <p className="flex items-center gap-2 text-xs leading-relaxed text-text-secondary">
              <Play size={14} className="shrink-0 text-accent" aria-hidden />
              <span>
                DNAFix analyses first. <span className="text-text-primary">You approve the plan</span> before any code changes.
              </span>
            </p>
            <div className="flex flex-col items-stretch gap-2 sm:items-end">
              <Button type="submit" variant="primary" loading={submitting} disabled={submitDisabled} className="px-5">
                Start Analysis
                <kbd className="rounded border border-white/20 bg-black/20 px-1 py-px font-mono text-[10px] font-medium" aria-hidden>
                  Ctrl ↵
                </kbd>
              </Button>
            </div>
          </section>

          {blockers.length > 0 && (
            <div className="rounded-xl border border-red-500/25 bg-red-500/5 px-4 py-3" role="alert">
              <p className="text-[13px] font-medium text-danger">Analysis cannot start yet</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-text-secondary">
                {blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          )}
          {serverError && (
            <p className="rounded-xl border border-red-500/25 bg-red-500/5 px-4 py-3 text-[13px] text-danger" role="alert">
              The API rejected this submission: {serverError}. Your input has been preserved — fix the problem and try again.
            </p>
          )}
        </form>

        <aside className="min-w-0 lg:col-span-4">
          <ReadinessPanel config={config.data} />
        </aside>
      </div>
    </div>
  );
}
