import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { GitHubSourcePanel } from "../components/GitHubSourcePanel";
import { Icon } from "../components/Icon";
import { ReadinessPanel, useConfigStatus } from "../components/ReadinessPanel";
import { SectionLabel } from "../components/ui";
import {
  api,
  type GitHubIssueDetail,
  type GitHubIssueDetailResponse,
  type GitHubRepository,
  type GitHubStatus,
  type RepositoryRecord,
  type Run,
} from "../lib/api";
import { blockingReasons } from "../lib/status";
import { hasUnsavedIssueEdits, issueFieldLimitError } from "../lib/github-import";

type Source = "local" | "github";

const DRAFT_KEY = "dnafix-new-analysis-draft";

interface ImportedIssue {
  issue: GitHubIssueDetail;
  fetchedAt: string;
  validatedAt: string;
  cached: boolean;
  installationId: number;
}

type CallbackNotice = { tone: "success" | "warning" | "error"; title: string; message: string };

function formatMeasured(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `~${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `~${min}m ${sec % 60}s`;
  return `~${Math.floor(min / 60)}h ${min % 60}m`;
}

function parseRepositoryInput(value: string): { owner: string; repo: string } | null {
  const trimmed = value.trim();
  const url = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(trimmed);
  const short = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(trimmed);
  const match = url ?? short;
  return match ? { owner: match[1]!, repo: match[2]! } : null;
}

function readCallbackNotice(): CallbackNotice | null {
  const params = new URLSearchParams(window.location.search);
  const state = params.get("github");
  if (!state) return null;
  const message = params.get("github_message") ?? "";
  const code = params.get("github_code") ?? "";
  if (state === "connected") return { tone: "success", title: "GitHub connected", message: message || "Your GitHub account is connected. Choose an installation and repository below." };
  if (state === "installed") return { tone: "success", title: "Installation verified", message: message || "The GitHub App installation was verified and linked to this session." };
  if (state === "pending") return { tone: "warning", title: "Installation pending approval", message: message || "An organization owner must approve the GitHub App installation before repositories become available." };
  if (state === "denied") return { tone: "error", title: "GitHub authorization denied", message: message || "You declined the authorization request. Connect again when you are ready." };
  return { tone: "error", title: "GitHub connection failed", message: `${message || "GitHub could not complete the connection."}${code ? ` (${code})` : ""}` };
}

function FetchedAt({ iso }: { iso: string }) {
  return <span title={iso}>{new Date(iso).toLocaleString()}</span>;
}

export function NewAnalysis() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const config = useConfigStatus();
  const repos = useQuery({ queryKey: ["repos"], queryFn: () => api<RepositoryRecord[]>("/repositories") });
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs") });

  const [callbackNotice, setCallbackNotice] = useState<CallbackNotice | null>(readCallbackNotice);
  const [source, setSource] = useState<Source>(() => (callbackNotice ? "github" : "local"));
  const [githubChoiceMade, setGithubChoiceMade] = useState(false);
  const [repositoryPath, setRepositoryPath] = useState("");
  const [selectedRepository, setSelectedRepository] = useState<GitHubRepository | null>(null);
  const [issueTitle, setIssueTitle] = useState("");
  const [issueBody, setIssueBody] = useState("");
  const [issueNumber, setIssueNumber] = useState("");
  const [imported, setImported] = useState<ImportedIssue | null>(null);
  const [pendingImport, setPendingImport] = useState<ImportedIssue | null>(null);
  const [refreshingIssue, setRefreshingIssue] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const browseRef = useRef<HTMLDivElement>(null);

  const githubStatus = useQuery({
    queryKey: ["github-status"],
    queryFn: ({ signal }) => api<GitHubStatus>("/integrations/github/status", { signal }),
    enabled: source === "github",
    retry: false,
  });

  const blockers = config.data ? blockingReasons(config.data) : [];
  const submitDisabled = submitting || !config.data || blockers.length > 0 || (source === "github" && !githubChoiceMade);

  const savedLocalRepositories = useMemo(() => (repos.data ?? []).filter((r) => r.localPath).map((r) => ({ id: r.id, label: r.localPath! })), [repos.data]);

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

  const importedDirty = Boolean(imported && hasUnsavedIssueEdits({ title: issueTitle, body: issueBody }, imported.issue));
  const showSpecification = source === "local" || githubChoiceMade;

  function validate(): Record<string, string> {
    const next: Record<string, string> = {};
    if (!repositoryPath.trim()) {
      next.repositoryPath = source === "local" ? "Enter the path to a local Git repository." : "Select a repository or enter owner/repository.";
    } else if (source === "github" && !parseRepositoryInput(repositoryPath)) {
      next.repositoryPath = "Enter the repository as owner/repository or a canonical github.com URL.";
    }
    if (!issueTitle.trim()) next.issueTitle = "Give the issue a short, specific title.";
    if (issueTitle.length > 500) next.issueTitle = "The issue summary exceeds the 500-character API limit. Edit it before starting the analysis.";
    if (!issueBody.trim()) next.issueBody = "Describe the problem, expected behavior, and how success will be judged.";
    const limits = issueFieldLimitError({ title: issueTitle, body: issueBody });
    if (limits.title) next.issueTitle = limits.title;
    if (limits.body) next.issueBody = limits.body;
    if (issueNumber && (!/^\d+$/.test(issueNumber) || Number(issueNumber) < 1)) {
      next.issueNumber = source === "github" ? "GitHub tracking reference must be a positive issue number." : "Issue number must be a positive integer.";
    }
    if (imported && issueNumber !== String(imported.issue.number)) {
      next.issueNumber = `Tracking reference must remain #${imported.issue.number} for the imported GitHub issue. Use “Clear imported issue” to unlink it.`;
    }
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

    const parsed = source === "github" ? parseRepositoryInput(repositoryPath) : null;
    try {
      const run = await api<Run>("/runs", {
        method: "POST",
        body: JSON.stringify({
          repositoryPath: source === "local" ? repositoryPath.trim() : undefined,
          githubOwner: source === "github" ? parsed?.owner : undefined,
          githubRepo: source === "github" ? parsed?.repo : undefined,
          issueTitle: issueTitle.trim(),
          issueBody: imported ? issueBody : issueBody.trim(),
          issueNumber: /^\d+$/.test(issueNumber) ? Number(issueNumber) : undefined,
          githubInstallationId: imported?.installationId ?? (source === "github" && githubStatus.data?.installation ? githubStatus.data.installation.id : undefined),
          issueUrl: imported?.issue.htmlUrl,
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
  // Tokens and GitHub credentials are never written to browser storage.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw) as Record<string, string>;
      if (!callbackNotice && (draft.source === "local" || draft.source === "github")) setSource(draft.source);
      setRepositoryPath(draft.repositoryPath ?? "");
      setIssueTitle(draft.issueTitle ?? "");
      setIssueBody(draft.issueBody ?? "");
      setIssueNumber(draft.issueNumber ?? "");
    } catch {
      /* corrupted draft is ignored */
    }
  }, []);

  // OAuth return parameters are consumed once; the URL is cleaned so refreshes do not replay the notice.
  useEffect(() => {
    if (!window.location.search.includes("github=")) return;
    window.history.replaceState({}, "", window.location.pathname);
    if (callbackNotice?.tone === "success") void queryClient.invalidateQueries();
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
    if (next === "github") setGithubChoiceMade(Boolean(selectedRepository));
    setErrors((prev) => ({ ...prev, repositoryPath: "" }));
  }

  function changeRepository(value: string, repository: GitHubRepository | null) {
    setRepositoryPath(value);
    setSelectedRepository(repository);
    setImported(null);
    setPendingImport(null);
    setIssueNumber("");
    setErrors((prev) => ({ ...prev, repositoryPath: "" }));
  }

  function applyImportedIssue(detail: GitHubIssueDetailResponse, force: boolean) {
    const next: ImportedIssue = { issue: detail.issue, fetchedAt: detail.fetchedAt, validatedAt: detail.validatedAt, cached: detail.cached, installationId: detail.installationId };
    const dirty = hasUnsavedIssueEdits({ title: issueTitle, body: issueBody }, imported?.issue ?? null);
    if (!force && dirty) {
      setPendingImport(next);
      return;
    }
    setIssueTitle(detail.issue.title);
    setIssueBody(detail.issue.body ?? "");
    setIssueNumber(String(detail.issue.number));
    setImported(next);
    setPendingImport(null);
    setErrors({});
  }

  function restoreImported() {
    if (!imported) return;
    setIssueTitle(imported.issue.title);
    setIssueBody(imported.issue.body ?? "");
    setIssueNumber(String(imported.issue.number));
  }

  function clearImported() {
    setImported(null);
    setPendingImport(null);
  }

  async function refreshImported() {
    if (!imported || !selectedRepository) return;
    setRefreshingIssue(true);
    setServerError(null);
    try {
      const detail = await api<GitHubIssueDetailResponse>(
        `/integrations/github/repositories/${encodeURIComponent(selectedRepository.owner)}/${encodeURIComponent(selectedRepository.name)}/issues/${imported.issue.number}?refresh=true`,
      );
      applyImportedIssue(detail, false);
    } catch (err) {
      setServerError((err as Error).message);
    } finally {
      setRefreshingIssue(false);
    }
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

      {callbackNotice && (
        <div
          className={`mb-3 flex items-start justify-between gap-2 rounded-lg border px-2.5 py-2 text-[12px] leading-4 ${
            callbackNotice.tone === "success"
              ? "border-[#27A567]/25 bg-[#27A567]/5 text-[#34D399]"
              : callbackNotice.tone === "warning"
                ? "border-[#E5A158]/25 bg-[#E5A158]/5 text-[#E5A158]"
                : "border-[#E5484D]/25 bg-[#E5484D]/5 text-[#E5484D]"
          }`}
          role={callbackNotice.tone === "error" ? "alert" : "status"}
        >
          <span>
            <span className="font-medium">{callbackNotice.title}.</span> {callbackNotice.message}
          </span>
          <button type="button" onClick={() => setCallbackNotice(null)} className="shrink-0 rounded px-1 text-[11px] opacity-70 hover:opacity-100" aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

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

            {source === "local" ? (
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
                    placeholder="G:\projects\my-service"
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
                      ) : savedLocalRepositories.length === 0 ? (
                        <p className="px-2 pb-2 text-[12px] text-[#8A8F98]">No saved local repositories yet.</p>
                      ) : (
                        <div className="max-h-56 overflow-y-auto p-1">
                          {savedLocalRepositories.map((r) => (
                            <button
                              key={r.id}
                              type="button"
                              onClick={() => {
                                setRepositoryPath(r.label);
                                setBrowseOpen(false);
                                setErrors((prev) => ({ ...prev, repositoryPath: "" }));
                              }}
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
                      Absolute filesystem path to local Git repository accessible to server. Working tree will not be mutated.
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <>
                <GitHubSourcePanel
                  status={githubStatus.data}
                  statusLoading={githubStatus.isLoading}
                  statusError={githubStatus.isError ? (githubStatus.error as Error).message : null}
                  onRefreshStatus={() => void githubStatus.refetch()}
                  repositoryPath={repositoryPath}
                  onRepositoryPathChange={changeRepository}
                  selectedRepository={selectedRepository}
                  onIssueLoaded={(detail) => applyImportedIssue(detail, false)}
                  selectedIssueNumber={imported?.issue.number ?? null}
                  autoOpenGitHub={callbackNotice?.tone === "success"}
                  onChoiceChange={setGithubChoiceMade}
                />
                {!selectedRepository && repositoryPath && (
                  <p className="mt-1.5 text-[11px] leading-4 text-[#8A8F98]">
                    Manual reference <span className="font-mono text-[#ECEEF0]">{repositoryPath}</span> will be validated against GitHub before an issue can be imported.
                  </p>
                )}
                {errors.repositoryPath && (
                  <p className="mt-1.5 text-[12px] leading-4 text-[#E5484D]" role="alert">
                    {errors.repositoryPath}
                  </p>
                )}
              </>
            )}
          </section>

          {showSpecification && (
            <>
              {/* 02 / Issue specification */}
              <section className="flex flex-col rounded-xl border border-[#26282E] bg-[#1A1B20] p-3 shadow-sm" aria-label="Issue specification">
                <div className="mb-2 flex items-center justify-between">
                  <SectionLabel index="02">Issue Specification</SectionLabel>
                </div>

                {pendingImport && (
                  <div className="mb-3 rounded-lg border border-[#E5A158]/30 bg-[#E5A158]/5 p-2" role="alert">
                    <p className="text-[12px] font-medium text-[#E5A158]">
                      Replace your edited content with {pendingImport.issue.repositoryFullName}#{pendingImport.issue.number}?
                    </p>
                    <p className="mt-0.5 text-[11px] leading-4 text-[#8A8F98]">
                      The fetched issue differs from what you have typed. DNAFix will not silently overwrite your edits.
                    </p>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <button type="button" onClick={() => applyImportedIssue({ issue: pendingImport.issue, fetchedAt: pendingImport.fetchedAt, validatedAt: pendingImport.validatedAt, cached: pendingImport.cached, etag: null, installationId: pendingImport.installationId }, true)} className="h-6 rounded bg-[#5E6AD2] px-2 text-[11px] font-medium text-white hover:bg-[#6875E3]">
                        Replace my edits
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingImport(null)}
                        className="h-6 rounded border border-[#2E3038] px-2 text-[11px] text-[#ECEEF0] hover:border-[#424652]"
                      >
                        Keep my edits
                      </button>
                    </div>
                  </div>
                )}

                {imported && (
                  <div className="mb-3 rounded-lg border border-[#2E3038] bg-[#141518]">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#26282E] px-2 py-1.5">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-1.5 text-[11px] leading-4 text-[#8A8F98]">
                          <Icon name="bug_report" size={13} className={imported.issue.state === "open" ? "text-[#34D399]" : "text-[#C084FC]"} />
                          <span className="font-mono text-[#ECEEF0]">{imported.issue.repositoryFullName}#{imported.issue.number}</span>
                          <span className="rounded border border-[#2E3038] px-1 font-mono text-[9px] uppercase text-[#8A8F98]">{imported.issue.state}</span>
                          <span>{imported.cached ? "cached from GitHub" : "fetched live from GitHub"}</span>
                          <span>· last fetched <FetchedAt iso={imported.fetchedAt} /></span>
                          <span>· checked <FetchedAt iso={imported.validatedAt} /></span>
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button type="button" onClick={() => void refreshImported()} disabled={refreshingIssue} className="inline-flex h-6 items-center gap-1 rounded border border-[#2E3038] px-1.5 text-[10px] text-[#8A8F98] hover:text-[#ECEEF0] disabled:opacity-50">
                          <Icon name="refresh" size={12} className={refreshingIssue ? "animate-spin" : ""} /> Refresh
                        </button>
                        <a href={imported.issue.htmlUrl} target="_blank" rel="noreferrer" className="inline-flex h-6 items-center gap-1 rounded border border-[#2E3038] px-1.5 text-[10px] text-[#8A8F98] hover:text-[#ECEEF0]">
                          <Icon name="open_in_new" size={12} /> Open on GitHub
                        </a>
                        {importedDirty && (
                          <button type="button" onClick={restoreImported} className="h-6 rounded border border-[#E5A158]/40 px-1.5 text-[10px] text-[#E5A158] hover:bg-[#E5A158]/10">
                            Restore from GitHub
                          </button>
                        )}
                        <button type="button" onClick={clearImported} className="h-6 rounded px-1.5 text-[10px] text-[#5E626E] hover:text-[#ECEEF0]">
                          Clear
                        </button>
                      </div>
                    </div>
                    <div className="px-2.5 py-2">
                      <p className="text-[13px] font-medium leading-[18px] text-[#ECEEF0]">{imported.issue.title}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[10px] leading-[14px] text-[#5E626E]">
                        {imported.issue.author?.login && <span>opened by {imported.issue.author.login}</span>}
                        {imported.issue.labels.length > 0 && <span>· {imported.issue.labels.map((l) => l.name).join(", ")}</span>}
                        {imported.issue.milestone && <span>· milestone {imported.issue.milestone}</span>}
                        <span>· {imported.issue.comments} comment{imported.issue.comments === 1 ? "" : "s"}</span>
                      </p>
                      <pre className="mt-1.5 max-h-44 overflow-y-auto whitespace-pre-wrap break-words rounded border border-[#26282E] bg-[#0F1013] p-2 font-mono text-[11px] leading-[17px] text-[#BDC2FF]">
                        {imported.issue.body ?? "(This issue has no description. Add reproduction details before starting the analysis.)"}
                      </pre>
                      {importedDirty && (
                        <p className="mt-1.5 text-[11px] leading-4 text-[#E5A158]">
                          The fields below differ from the fetched issue. The original Markdown is preserved above; use “Restore from GitHub” to replace your edits.
                        </p>
                      )}
                    </div>
                  </div>
                )}

                <div className="mb-3 flex flex-col gap-1">
                  <label htmlFor="issue-title" className="flex items-center justify-between text-[13px] font-medium leading-[18px] text-[#ECEEF0]">
                    <span>Issue summary</span>
                    <span className={`font-mono text-[11px] font-normal leading-[14px] ${issueTitle.length > 500 ? "text-[#E5484D]" : "text-[#5E626E]"}`}>{issueTitle.length}/500 chars</span>
                  </label>
                  <input
                    id="issue-title"
                    value={issueTitle}
                    onChange={(e) => setIssueTitle(e.target.value)}
                    maxLength={500}
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
                      <span className="text-[#5E626E]">{imported ? "Original GitHub Markdown" : "Markdown enabled"}</span>
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
                      {imported && !importedDirty
                        ? "Imported verbatim from GitHub. Editing keeps the source link and enables “Restore from GitHub”."
                        : "State the failure mechanism, expected behavior, and verification boundary. Deterministic patch generation depends on precise invariants."}
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
                        readOnly={Boolean(imported)}
                        title={imported ? `Imported from GitHub issue #${imported.issue.number}` : undefined}
                        aria-invalid={Boolean(errors.issueNumber)}
                        className={`h-7 w-full rounded-md border border-[#2E3038] bg-[#1A1B20] pl-6 pr-3 font-mono text-[12px] leading-[18px] text-[#ECEEF0] transition-colors placeholder:text-[#5E626E] focus:border-[#5E6AD2] focus:outline-none ${imported ? "opacity-70" : ""}`}
                      />
                    </div>
                    {errors.issueNumber && (
                      <p className="text-[11px] leading-4 text-[#E5484D]" role="alert">
                        {errors.issueNumber}
                      </p>
                    )}
                    {imported && (
                      <p className="text-[10px] leading-[14px] text-[#5E626E]">
                        Linked to <a href={imported.issue.htmlUrl} target="_blank" rel="noreferrer" className="text-[#BDC2FF] hover:underline">{imported.issue.repositoryFullName}#{imported.issue.number}</a>
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
            </>
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
