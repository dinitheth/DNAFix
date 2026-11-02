import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../components/Icon";
import { ReadinessPanel, useConfigStatus } from "../components/ReadinessPanel";
import { SectionLabel } from "../components/ui";
import { api, type RepositoryRecord, type Run } from "../lib/api";
import { blockingReasons } from "../lib/status";

type Source = "local" | "github";

const DRAFT_KEY = "dnafix-new-analysis-draft";

function formatMeasured(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `~${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `~${min}m ${sec % 60}s`;
  return `~${Math.floor(min / 60)}h ${min % 60}m`;
}

export function NewAnalysis() {
  const navigate = useNavigate();
  const config = useConfigStatus();
  const repos = useQuery({ queryKey: ["repos"], queryFn: () => api<RepositoryRecord[]>("/repositories") });
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs") });

  const [source, setSource] = useState<Source>("local");
  const [repositoryPath, setRepositoryPath] = useState("");
  const [issueTitle, setIssueTitle] = useState("");
  const [issueBody, setIssueBody] = useState("");
  const [issueNumber, setIssueNumber] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const browseRef = useRef<HTMLDivElement>(null);

  const blockers = config.data ? blockingReasons(config.data) : [];
  const githubConfigured = config.data?.github.configured ?? false;
  const submitDisabled = submitting || !config.data || blockers.length > 0;

  const savedRepositories = useMemo(() => {
    const all = repos.data ?? [];
    if (source === "github") {
      return all.filter((r) => r.githubOwner && r.githubRepo).map((r) => ({ id: r.id, label: `${r.githubOwner}/${r.githubRepo}` }));
    }
    return all.filter((r) => r.localPath).map((r) => ({ id: r.id, label: r.localPath! }));
  }, [repos.data, source]);

  /** Real measured median of completed runs; no invented performance numbers. */
  const estimate = useMemo(() => {
    const durations = (runs.data ?? [])
      .filter((r) => r.state === "COMPLETED")
      .map((r) => Date.parse(r.updatedAt) - Date.parse(r.createdAt))
      .filter((ms) => Number.isFinite(ms) && ms > 0)
      .sort((a, b) => a - b)
      .slice(-10);
    if (durations.length === 0) return null;
    const median = durations[Math.floor(durations.length / 2)];
    return median === undefined ? null : formatMeasured(median);
  }, [runs.data]);

  function validate(): Record<string, string> {
    const next: Record<string, string> = {};
    if (!repositoryPath.trim()) {
      next.repositoryPath = source === "local" ? "Enter the path to a local Git repository." : "Enter the repository as owner/repository.";
    } else if (source === "github" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryPath.trim())) {
      next.repositoryPath = "Enter the repository as owner/repository.";
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

    const [owner, repo] = repositoryPath.trim().split("/");
    try {
      const run = await api<Run>("/runs", {
        method: "POST",
        body: JSON.stringify({
          repositoryPath: source === "local" ? repositoryPath.trim() : undefined,
          githubOwner: source === "github" ? owner : undefined,
          githubRepo: source === "github" ? repo : undefined,
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

  // Browser-local draft persistence: restore once on mount, save on demand.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw) as Record<string, string>;
      if (draft.source === "local" || draft.source === "github") setSource(draft.source);
      setRepositoryPath(draft.repositoryPath ?? "");
      setIssueTitle(draft.issueTitle ?? "");
      setIssueBody(draft.issueBody ?? "");
      setIssueNumber(draft.issueNumber ?? "");
    } catch {
      /* corrupted draft is ignored */
    }
  }, []);

  useEffect(() => {
    if (!browseOpen) return;
    function onDown(e: MouseEvent) {
      if (browseRef.current && !browseRef.current.contains(e.target as Node)) setBrowseOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [browseOpen]);

  function saveDraft() {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ source, repositoryPath, issueTitle, issueBody, issueNumber }));
    setDraftSaved(true);
    window.setTimeout(() => setDraftSaved(false), 2000);
  }

  function chooseSource(next: Source) {
    setSource(next);
    setErrors((prev) => ({ ...prev, repositoryPath: "" }));
  }

  function chooseRepository(label: string) {
    setRepositoryPath(label);
    setBrowseOpen(false);
    setErrors((prev) => ({ ...prev, repositoryPath: "" }));
  }

  return (
    <div>
      {/* Workbench header */}
      <header className="mb-3 flex flex-col gap-1 border-b border-[#26282E] pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <h1 className="text-[20px] font-semibold leading-[26px] tracking-[-0.02em] text-[#ECEEF0]">New Analysis</h1>
          </div>
        </div>
        <p className="mt-0.5 max-w-2xl text-[13px] leading-[18px] text-[#8A8F98]">
          Understand the repository. Investigate the issue. Prepare a verified engineering change with reproducible telemetry.
        </p>
      </header>

      {/* Primary split-pane working grid */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
        {/* Left column: main form */}
        <form onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-3 lg:col-span-8">
          {/* 01 / Repository source */}
          <section className="flex flex-col rounded-xl border border-[#26282E] bg-[#1A1B20] p-3 shadow-sm" aria-label="Repository source">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <SectionLabel index="01">Repository Source</SectionLabel>
              </div>
            </div>

            <div className="mb-3 grid max-w-md grid-cols-2 rounded-lg border border-[#26282E] bg-[#141518] p-1" role="tablist" aria-label="Repository source">
              <button
                type="button"
                role="tab"
                aria-selected={source === "local"}
                onClick={() => chooseSource("local")}
                className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[13px] leading-[18px] transition-all ${
                  source === "local"
                    ? "border border-[#2E3038] bg-[#282A31] font-medium text-[#ECEEF0] shadow-sm"
                    : "border border-transparent text-[#8A8F98] hover:bg-[#1E2026] hover:text-[#ECEEF0]"
                }`}
              >
                <Icon name="folder_open" size={15} className={source === "local" ? "text-[#BDC2FF]" : "text-[#8A8F98]"} />
                <span>Local repository</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={source === "github"}
                onClick={() => chooseSource("github")}
                className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[13px] leading-[18px] transition-all ${
                  source === "github"
                    ? "border border-[#2E3038] bg-[#282A31] font-medium text-[#ECEEF0] shadow-sm"
                    : "border border-transparent text-[#8A8F98] hover:bg-[#1E2026] hover:text-[#ECEEF0]"
                }`}
              >
                <svg className="h-4 w-4 shrink-0 fill-current" viewBox="0 0 24 24" aria-hidden>
                  <path
                    clipRule="evenodd"
                    fillRule="evenodd"
                    d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                  />
                </svg>
                <span>GitHub repository</span>
              </button>
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <label htmlFor="repo-path" className="flex items-center gap-1 text-[13px] font-medium leading-[18px] text-[#ECEEF0]">
                  Repository path
                  <span className="text-[#E5484D]">*</span>
                </label>
              </div>
              <div className="relative flex items-center" ref={browseRef}>
                <Icon name="terminal" size={16} className="pointer-events-none absolute left-3 text-[#5E626E]" />
                <input
                  id="repo-path"
                  value={repositoryPath}
                  onChange={(e) => setRepositoryPath(e.target.value)}
                  placeholder={source === "local" ? "G:\\projects\\my-service" : "org-infrastructure/service-payments"}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={Boolean(errors.repositoryPath)}
                  className={`h-8 w-full rounded-md border bg-[#141518] pl-9 pr-24 font-mono text-[12px] leading-[18px] text-[#ECEEF0] transition-colors placeholder:text-[#5E626E] focus:outline-none focus:ring-1 focus:ring-[#5E6AD2] ${
                    errors.repositoryPath ? "border-[#E5484D]" : "border-[#2E3038] focus:border-[#5E6AD2]"
                  }`}
                />
                <div className="absolute right-1 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setBrowseOpen((v) => !v)}
                    aria-expanded={browseOpen}
                    className="rounded border border-[#2E3038] bg-[#222329] px-2.5 py-1 font-mono text-[11px] font-medium leading-[14px] text-[#ECEEF0] transition-colors hover:border-[#424652] hover:bg-[#282A31]"
                  >
                    Browse
                  </button>
                </div>

                {browseOpen && (
                  <div className="absolute right-0 top-full z-30 mt-1 w-72 overflow-hidden rounded-lg border border-[#363840] bg-[#222328] shadow-[0_4px_20px_0_rgba(0,0,0,0.45)]">
                    <p className="px-2 py-1.5 font-mono text-[10px] uppercase tracking-[0.03em] text-[#5E626E]">Saved repositories</p>
                    {repos.isLoading ? (
                      <p className="px-2 pb-2 text-[12px] text-[#8A8F98]">Loading repositories…</p>
                    ) : savedRepositories.length === 0 ? (
                      <p className="px-2 pb-2 text-[12px] text-[#8A8F98]">No saved {source === "local" ? "local" : "GitHub"} repositories yet.</p>
                    ) : (
                      <div className="max-h-56 overflow-y-auto p-1">
                        {savedRepositories.map((r) => (
                          <button
                            key={r.id}
                            type="button"
                            onClick={() => chooseRepository(r.label)}
                            className="block w-full truncate rounded px-2 py-1.5 text-left font-mono text-[12px] text-[#ECEEF0] transition-colors hover:bg-[#282A31]"
                            title={r.label}
                          >
                            {r.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {errors.repositoryPath ? (
                <p className="text-[12px] leading-4 text-[#E5484D]" role="alert">
                  {errors.repositoryPath}
                </p>
              ) : (
                <div className="mt-1 flex items-center justify-between text-[#8A8F98]">
                  <p className="text-[12px] leading-4 text-[#5E626E]">
                    {source === "local"
                      ? "Absolute filesystem path to local Git repository accessible to server. Working tree will not be mutated."
                      : "GitHub owner and repository. Public repositories are cloned into the API data directory."}
                  </p>
                </div>
              )}
              {source === "github" && config.data && !githubConfigured && (
                <p className="text-[12px] leading-4 text-[#E5A158]">
                  GitHub App is not configured. Verified changes will complete as local diffs instead of draft pull requests.
                </p>
              )}
            </div>
          </section>

          {/* 02 / Issue specification */}
          <section className="flex flex-col rounded-xl border border-[#26282E] bg-[#1A1B20] p-3 shadow-sm" aria-label="Issue specification">
            <div className="mb-2 flex items-center justify-between">
              <SectionLabel index="02">Issue Specification</SectionLabel>
            </div>

            <div className="mb-3 flex flex-col gap-1">
              <label htmlFor="issue-title" className="flex items-center justify-between text-[13px] font-medium leading-[18px] text-[#ECEEF0]">
                <span>Issue summary</span>
                <span className="font-mono text-[11px] font-normal leading-[14px] text-[#5E626E]">{issueTitle.length}/120 chars</span>
              </label>
              <input
                id="issue-title"
                value={issueTitle}
                onChange={(e) => setIssueTitle(e.target.value)}
                maxLength={120}
                aria-invalid={Boolean(errors.issueTitle)}
                className={`h-8 w-full rounded-md border bg-[#141518] px-3 text-[13px] leading-[18px] text-[#ECEEF0] transition-colors placeholder:text-[#5E626E] focus:outline-none focus:ring-1 focus:ring-[#5E6AD2] ${
                  errors.issueTitle ? "border-[#E5484D]" : "border-[#2E3038] focus:border-[#5E6AD2]"
                }`}
              />
              {errors.issueTitle && (
                <p className="text-[12px] leading-4 text-[#E5484D]" role="alert">
                  {errors.issueTitle}
                </p>
              )}
            </div>

            <div className="mb-3 flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <label htmlFor="issue-desc" className="text-[13px] font-medium leading-[18px] text-[#ECEEF0]">
                  Detailed reproduction &amp; acceptance criteria
                </label>
                <div className="flex items-center gap-1.5 font-mono text-[11px] leading-[14px] text-[#8A8F98]">
                  <span className="text-[#5E626E]">•</span>
                  <span className="text-[#5E626E]">Markdown enabled</span>
                </div>
              </div>
              <textarea
                id="issue-desc"
                rows={6}
                value={issueBody}
                onChange={(e) => setIssueBody(e.target.value)}
                aria-invalid={Boolean(errors.issueBody)}
                placeholder={
                  "Bug: a 10% discount on a 200 item charges 190 instead of 180.\n\nExpected: applyDiscount(200, 10) === 180.\nAcceptance: existing test suite passes with regression coverage."
                }
                className={`w-full resize-y rounded-md border bg-[#141518] p-3 font-mono text-[12px] leading-relaxed text-[#ECEEF0] transition-colors placeholder:text-[#5E626E] focus:outline-none focus:ring-1 focus:ring-[#5E6AD2] ${
                  errors.issueBody ? "border-[#E5484D]" : "border-[#2E3038] focus:border-[#5E6AD2]"
                }`}
              />
              {errors.issueBody ? (
                <p className="text-[12px] leading-4 text-[#E5484D]" role="alert">
                  {errors.issueBody}
                </p>
              ) : (
                <span className="mt-0.5 text-[12px] leading-4 text-[#5E626E]">
                  State the failure mechanism, expected behavior, and verification boundary. Deterministic patch generation depends on precise invariants.
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 gap-2 rounded-lg border border-[#26282E] bg-[#141518] p-2 pt-2 md:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label htmlFor="issue-ref" className="text-[12px] leading-4 text-[#8A8F98]">
                  Issue tracking reference (Optional)
                </label>
                <div className="relative flex items-center">
                  <span className="pointer-events-none absolute left-2.5 font-mono text-[12px] leading-[18px] text-[#5E626E]">#</span>
                  <input
                    id="issue-ref"
                    value={issueNumber}
                    onChange={(e) => setIssueNumber(e.target.value)}
                    inputMode="numeric"
                    placeholder="e.g. 142 or JIRA-899"
                    aria-invalid={Boolean(errors.issueNumber)}
                    className="h-7 w-full rounded-md border border-[#2E3038] bg-[#1A1B20] pl-6 pr-3 font-mono text-[12px] leading-[18px] text-[#ECEEF0] transition-colors placeholder:text-[#5E626E] focus:border-[#5E6AD2] focus:outline-none"
                  />
                </div>
                {errors.issueNumber && (
                  <p className="text-[11px] leading-4 text-[#E5484D]" role="alert">
                    {errors.issueNumber}
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="test-scope" className="text-[12px] leading-4 text-[#8A8F98]">
                  Targeted verification runner
                </label>
                <select
                  id="test-scope"
                  disabled
                  title="Verification uses the repository's detected test runner for every run."
                  className="h-7 w-full cursor-not-allowed rounded-md border border-[#2E3038] bg-[#1A1B20] px-2 font-mono text-[12px] leading-[18px] text-[#ECEEF0] focus:border-[#5E6AD2] focus:outline-none"
                >
                  <option>Auto-detect (repository test runner)</option>
                </select>
              </div>
            </div>
          </section>

          {/* 03 / Execution action bar */}
          <section
            className="flex flex-col items-stretch justify-between gap-2 rounded-xl border border-[#26282E] bg-[#1A1B20] p-3 shadow-sm sm:flex-row sm:items-center"
            aria-label="Start analysis"
          >
            <div className="flex items-center gap-1.5 text-[#8A8F98]">
              <Icon name="timelapse" size={16} className="text-[#5E6AD2]" />
              <span className="text-[12px] leading-4">
                Est. execution time: <span className="font-mono text-[#ECEEF0]">{estimate ?? "no baseline yet"}</span>
                {estimate ? " to deterministic patch." : "."}
              </span>
            </div>
            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                onClick={saveDraft}
                className="flex h-8 items-center gap-1.5 rounded-md border border-[#2E3038] bg-[#222329] px-3 text-[13px] font-medium text-[#8A8F98] transition-colors hover:border-[#424652] hover:bg-[#282A31] hover:text-[#ECEEF0]"
              >
                <Icon name={draftSaved ? "check" : "save"} size={14} />
                <span>{draftSaved ? "Draft saved" : "Save Draft"}</span>
              </button>
              <button
                type="submit"
                disabled={submitDisabled}
                title={blockers.length > 0 ? blockers.join("\n") : undefined}
                className="flex h-8 items-center gap-1.5 rounded-md bg-[#5E6AD2] px-3 text-[13px] font-medium text-white shadow-sm shadow-[#5E6AD2]/25 transition-all hover:bg-[#6875E3] active:translate-y-px disabled:cursor-not-allowed disabled:bg-[#282A31] disabled:text-[#5E626E] disabled:shadow-none"
              >
                <Icon name={submitting ? "sync" : "play_arrow"} size={16} className={submitting ? "animate-spin" : ""} />
                <span>{submitting ? "Validating..." : "Start Analysis"}</span>
                <kbd className="rounded border border-white/20 bg-black/20 px-1 py-0.5 font-mono text-[10px] font-medium leading-[14px] text-white">↵</kbd>
              </button>
            </div>
          </section>

          {blockers.length > 0 && (
            <p className="rounded-lg border border-[#E5484D]/25 bg-[#E5484D]/5 px-2 py-1.5 text-[12px] leading-4 text-[#E5484D]" role="alert">
              Analysis is blocked by {blockers.length} required action{blockers.length > 1 ? "s" : ""}. Review System Readiness to resolve{" "}
              {blockers.length > 1 ? "them" : "it"}.
            </p>
          )}
          {serverError && (
            <p className="rounded-lg border border-[#E5484D]/25 bg-[#E5484D]/5 px-2 py-1.5 text-[12px] leading-4 text-[#E5484D]" role="alert">
              The API rejected this submission: {serverError}. Your input has been preserved — fix the problem and try again.
            </p>
          )}
        </form>

        {/* Right column: system readiness */}
        <aside className="flex min-w-0 flex-col gap-2 lg:col-span-4">
          <ReadinessPanel config={config.data} />
        </aside>
      </div>
    </div>
  );
}
