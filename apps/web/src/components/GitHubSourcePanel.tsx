import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import {
  ApiError,
  api,
  type GitHubConnectResponse,
  type GitHubInstallation,
  type GitHubInstallationsResponse,
  type GitHubIssueDetailResponse,
  type GitHubIssuePage,
  type GitHubIssueSummary,
  type GitHubRepository,
  type GitHubRepositoryPage,
  type GitHubStatus,
} from "../lib/api";

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function timeAgo(iso: string): string {
  if (!iso) return "unknown";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message.replace(/^\d{3}: /, "") : error instanceof Error ? error.message : String(error);
}

function Avatar({ url, login, size = 20 }: { url: string | null; login: string; size?: number }) {
  if (url) return <img src={url} alt="" width={size} height={size} className="rounded-full border border-[#2E3038]" />;
  return (
    <span
      className="inline-flex items-center justify-center rounded-full border border-[#2E3038] bg-[#282A31] font-mono text-[9px] text-[#BDC2FF]"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {login.slice(0, 2).toUpperCase()}
    </span>
  );
}

function GitHubMark({ size = 18 }: { size?: number }) {
  return (
    <svg className="shrink-0 fill-current" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path
        clipRule="evenodd"
        fillRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
      />
    </svg>
  );
}

function LabelChip({ name, color }: { name: string; color: string | null }) {
  return (
    <span
      className="inline-flex items-center rounded-full border px-1.5 py-px font-mono text-[10px] leading-[14px]"
      style={{
        borderColor: color ? `#${color}66` : "#2E3038",
        color: color ? `#${color}` : "#8A8F98",
        backgroundColor: color ? `#${color}14` : "transparent",
      }}
    >
      {name}
    </span>
  );
}

function RepoRow({ repo, selected, onSelect, busy }: { repo: GitHubRepository; selected: boolean; onSelect: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={busy}
      className={`flex w-full items-start gap-2.5 border-b border-[#26282E] px-2 py-2 text-left transition-colors last:border-b-0 disabled:opacity-60 ${
        selected ? "bg-[#5E6AD2]/10" : "hover:bg-[#1E2026]"
      }`}
    >
      <Avatar url={repo.ownerAvatarUrl} login={repo.owner} size={22} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-mono text-[12px] font-medium text-[#ECEEF0]">
            {repo.owner}/<span className="text-[#BDC2FF]">{repo.name}</span>
          </span>
          <span className="shrink-0 rounded border border-[#2E3038] px-1 font-mono text-[9px] uppercase tracking-wide text-[#8A8F98]">{repo.visibility}</span>
        </span>
        {repo.description && <span className="mt-0.5 block truncate text-[11px] leading-4 text-[#8A8F98]">{repo.description}</span>}
        <span className="mt-0.5 flex items-center gap-2 font-mono text-[10px] leading-[14px] text-[#5E626E]">
          {repo.language && <span>{repo.language}</span>}
          <span className="inline-flex items-center gap-0.5">
            <Icon name="fork_right" size={11} />
            {repo.defaultBranch}
          </span>
          <span>updated {timeAgo(repo.updatedAt)}</span>
        </span>
      </span>
      {selected && <Icon name="check_circle" size={16} className="mt-0.5 text-[#5E6AD2]" filled />}
    </button>
  );
}

function IssueRow({ issue, selected, onSelect }: { issue: GitHubIssueSummary; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-start gap-2 border-b border-[#26282E] px-2 py-1.5 text-left transition-colors last:border-b-0 ${
        selected ? "bg-[#5E6AD2]/10" : "hover:bg-[#1E2026]"
      }`}
    >
      <span
        className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
          issue.state === "open" ? "border-[#27A567]/50 text-[#34D399]" : "border-[#8A4D9D]/50 text-[#C084FC]"
        }`}
        title={issue.state}
      >
        <Icon name={issue.state === "open" ? "bug_report" : "check"} size={10} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-[18px] text-[#ECEEF0]">{issue.title}</span>
          <span className="shrink-0 font-mono text-[10px] leading-[18px] text-[#5E626E]">#{issue.number}</span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {issue.labels.slice(0, 3).map((label) => (
            <LabelChip key={label.name} name={label.name} color={label.color} />
          ))}
          <span className="font-mono text-[10px] leading-[14px] text-[#5E626E]">
            {issue.author?.login ? `${issue.author.login} · ` : ""}
            {timeAgo(issue.updatedAt)}
            {issue.comments > 0 ? ` · ${issue.comments} comment${issue.comments === 1 ? "" : "s"}` : ""}
          </span>
        </span>
      </span>
      {selected && <Icon name="check" size={14} className="mt-1 text-[#5E6AD2]" />}
    </button>
  );
}

export interface GitHubSourcePanelProps {
  status: GitHubStatus | undefined;
  statusLoading: boolean;
  statusError: string | null;
  onRefreshStatus: () => void;
  repositoryPath: string;
  onRepositoryPathChange: (value: string, repository: GitHubRepository | null) => void;
  selectedRepository: GitHubRepository | null;
  onIssueLoaded: (detail: GitHubIssueDetailResponse) => void;
  selectedIssueNumber: number | null;
  /** Reveal the connected panel immediately, e.g. after returning from GitHub OAuth. */
  autoOpenGitHub?: boolean;
  /** Reports whether the user has moved past the sign-in / manual-entry choice. */
  onChoiceChange?: (chosen: boolean) => void;
}

type GitHubPanelView = "choose" | "github" | "manual";

export function GitHubSourcePanel(props: GitHubSourcePanelProps) {
  const { status, statusLoading, statusError, onRefreshStatus, repositoryPath, onRepositoryPathChange, selectedRepository, onIssueLoaded, selectedIssueNumber, autoOpenGitHub, onChoiceChange } = props;
  const [view, setView] = useState<GitHubPanelView>(() => (autoOpenGitHub || selectedRepository ? "github" : "choose"));
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [installations, setInstallations] = useState<GitHubInstallation[] | null>(null);
  const [installationId, setInstallationId] = useState<number | null>(null);

  const [repoSearch, setRepoSearch] = useState("");
  const debouncedRepoSearch = useDebounced(repoSearch, 300);
  const [ownerFilter, setOwnerFilter] = useState("");
  const [visibility, setVisibility] = useState<"all" | "public" | "private">("all");
  const [repoPage, setRepoPage] = useState(1);
  const [manualRepoOpen, setManualRepoOpen] = useState(false);

  const [issueState, setIssueState] = useState<"open" | "closed" | "all">("open");
  const [issueSearch, setIssueSearch] = useState("");
  const debouncedIssueSearch = useDebounced(issueSearch, 300);
  const [issuePage, setIssuePage] = useState(1);
  const [manualIssueOpen, setManualIssueOpen] = useState(false);
  const [manualIssue, setManualIssue] = useState("");
  const issueController = useRef<AbortController | null>(null);
  const issueRequest = useRef(0);

  const connected = Boolean(status?.connected);
  const configured = Boolean(status?.configured);
  const effectiveInstallation = installationId ?? status?.installation?.id ?? null;

  useEffect(() => {
    setInstallationId(status?.installation?.id ?? null);
  }, [status?.installation?.id]);

  useEffect(() => {
    issueController.current?.abort();
    issueRequest.current += 1;
    setRepoPage(1);
    setIssuePage(1);
    setIssueSearch("");
    setIssueState("open");
  }, [selectedRepository?.fullName]);

  useEffect(() => () => issueController.current?.abort(), []);

  useEffect(() => {
    onChoiceChange?.(view !== "choose");
  }, [view, onChoiceChange]);

  useEffect(() => {
    setIssuePage(1);
  }, [debouncedIssueSearch, issueState]);

  const installationsQuery = useQuery({
    queryKey: ["github-installations", status?.account?.login],
    queryFn: ({ signal }) => api<GitHubInstallationsResponse>("/integrations/github/installations", { signal }),
    enabled: connected,
    retry: false,
  });

  useEffect(() => {
    if (!installationsQuery.data) return;
    setInstallations(installationsQuery.data.installations);
    if (!installationId && installationsQuery.data.selectedInstallationId) setInstallationId(installationsQuery.data.selectedInstallationId);
  }, [installationsQuery.data, installationId]);

  const repositoriesQuery = useQuery({
    queryKey: ["github-repositories", effectiveInstallation, debouncedRepoSearch, ownerFilter, visibility, repoPage],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ page: String(repoPage), perPage: "20", visibility });
      if (debouncedRepoSearch.trim()) params.set("search", debouncedRepoSearch.trim());
      if (ownerFilter) params.set("owner", ownerFilter);
      return api<GitHubRepositoryPage>(`/integrations/github/repositories?${params.toString()}`, { signal });
    },
    enabled: connected && effectiveInstallation !== null,
    placeholderData: keepPreviousData,
    retry: false,
  });

  const issuesQuery = useQuery({
    queryKey: ["github-issues", selectedRepository?.fullName, issueState, debouncedIssueSearch, issuePage],
    queryFn: ({ signal }) => {
      if (!selectedRepository) throw new Error("No repository selected");
      const params = new URLSearchParams({ state: issueState, page: String(issuePage), perPage: "20" });
      if (debouncedIssueSearch.trim()) params.set("q", debouncedIssueSearch.trim());
      return api<GitHubIssuePage>(`/integrations/github/repositories/${encodeURIComponent(selectedRepository.owner)}/${encodeURIComponent(selectedRepository.name)}/issues?${params.toString()}`, { signal });
    },
    enabled: connected && Boolean(selectedRepository),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const selectedInstallation = useMemo(() => installations?.find((i) => i.id === effectiveInstallation) ?? null, [installations, effectiveInstallation]);
  const suspended = selectedInstallation?.suspended ?? false;

  async function connect() {
    setBusy("connect");
    setActionError(null);
    try {
      const res = await api<GitHubConnectResponse>("/integrations/github/connect", { method: "POST", body: JSON.stringify({ returnTo: "/new" }) });
      window.location.assign(res.authorizeUrl);
    } catch (err) {
      setActionError(errorMessage(err));
      setBusy(null);
    }
  }

  function openGitHub() {
    setActionError(null);
    if (connected || !configured) {
      setView("github");
      return;
    }
    void connect();
  }

  async function install() {
    setBusy("install");
    setActionError(null);
    try {
      const res = await api<{ installUrl: string }>("/integrations/github/installations/start", { method: "POST" });
      window.location.assign(res.installUrl);
    } catch (err) {
      setActionError(errorMessage(err));
      setBusy(null);
    }
  }

  async function chooseInstallation(id: number) {
    setBusy("installation");
    setActionError(null);
    try {
      await api("/integrations/github/installations/select", { method: "POST", body: JSON.stringify({ installationId: id }) });
      setInstallationId(id);
      setNotice("Installation verified.");
      onRefreshStatus();
      await installationsQuery.refetch();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect GitHub? DNAFix will revoke the stored authorization and delete the encrypted tokens.")) return;
    setBusy("disconnect");
    setActionError(null);
    try {
      await api("/integrations/github/disconnect", { method: "POST" });
      setInstallations(null);
      setInstallationId(null);
      onRepositoryPathChange("", null);
      onRefreshStatus();
      setNotice("GitHub disconnected and stored credentials removed.");
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function selectRepository(repo: GitHubRepository) {
    setBusy(`repo-${repo.id}`);
    setActionError(null);
    try {
      await api("/integrations/github/repositories/select", { method: "POST", body: JSON.stringify({ repository: repo.fullName }) });
      onRepositoryPathChange(repo.fullName, repo);
      setManualRepoOpen(false);
      setNotice(`Repository verified: ${repo.fullName}`);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function submitManualRepository() {
    const value = repositoryPath.trim();
    if (!value) {
      setActionError("Enter owner/repository or a github.com repository URL.");
      return;
    }
    if (!connected || !configured) {
      onRepositoryPathChange(value, null);
      setNotice("Public repository reference accepted. DNAFix will clone it without GitHub App access.");
      return;
    }
    setBusy("manual-repo");
    setActionError(null);
    try {
      const res = await api<{ repository: GitHubRepository }>("/integrations/github/repositories/select", { method: "POST", body: JSON.stringify({ repository: value }) });
      onRepositoryPathChange(res.repository.fullName, res.repository);
      setManualRepoOpen(false);
      setNotice(`Repository verified: ${res.repository.fullName}`);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function loadIssue(number: number): Promise<boolean> {
    if (!selectedRepository) return false;
    issueController.current?.abort();
    const controller = new AbortController();
    issueController.current = controller;
    const request = ++issueRequest.current;
    setBusy(`issue-${number}`);
    setActionError(null);
    try {
      const detail = await api<GitHubIssueDetailResponse>(
        `/integrations/github/repositories/${encodeURIComponent(selectedRepository.owner)}/${encodeURIComponent(selectedRepository.name)}/issues/${number}`,
        { signal: controller.signal },
      );
      if (request !== issueRequest.current || controller.signal.aborted) return false;
      onIssueLoaded(detail);
      return true;
    } catch (err) {
      if (request !== issueRequest.current || controller.signal.aborted) return false;
      setActionError(errorMessage(err));
      return false;
    } finally {
      if (request === issueRequest.current) setBusy(null);
    }
  }

  async function submitManualIssue() {
    if (!selectedRepository) return;
    const value = manualIssue.trim();
    if (!value) return;
    let number: number;
    const url = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(value);
    if (url) {
      if (url[1]!.toLowerCase() !== selectedRepository.owner.toLowerCase() || url[2]!.toLowerCase() !== selectedRepository.name.toLowerCase()) {
        setActionError("That issue URL belongs to a different repository. Select that repository first.");
        return;
      }
      number = Number(url[3]);
    } else {
      const cleaned = value.replace(/^#/, "");
      if (!/^\d+$/.test(cleaned)) {
        setActionError("Enter an issue number (for example 142) or a canonical GitHub issue URL.");
        return;
      }
      number = Number(cleaned);
    }
    if (await loadIssue(number)) setManualIssueOpen(false);
  }

  /* ------------------------------ render ------------------------------ */

  if (statusLoading) {
    return (
      <div className="mt-2 space-y-2">
        <div className="h-9 animate-pulse rounded-md bg-[#1E2026]" />
        <div className="h-9 animate-pulse rounded-md bg-[#1E2026]" />
      </div>
    );
  }

  if (statusError) {
    return (
      <div className="mt-2 rounded-lg border border-[#E5484D]/25 bg-[#E5484D]/5 p-2 text-[12px] text-[#E5484D]">
        Could not read GitHub connection status: {statusError}
        <button type="button" onClick={onRefreshStatus} className="ml-2 underline underline-offset-2">
          Retry
        </button>
      </div>
    );
  }

  const feedback = (
    <>
      {actionError && (
        <p className="rounded-md border border-[#E5484D]/25 bg-[#E5484D]/5 px-2 py-1.5 text-[12px] leading-4 text-[#E5484D]" role="alert">
          {actionError}
        </p>
      )}
      {notice && !actionError && (
        <p className="rounded-md border border-[#27A567]/25 bg-[#27A567]/5 px-2 py-1.5 text-[12px] leading-4 text-[#34D399]" role="status">
          {notice}
        </p>
      )}
    </>
  );

  if (view === "choose") {
    return (
      <div className="mt-2 flex flex-col gap-2">
        {feedback}
        <div className="rounded-lg border border-[#2E3038] bg-[#141518] p-3">
          <button
            type="button"
            onClick={openGitHub}
            disabled={busy !== null}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-[#30363D] bg-[#0D1117] text-[13px] font-semibold text-white shadow-sm transition-colors hover:border-[#484F58] hover:bg-[#161B22] disabled:opacity-60"
          >
            <GitHubMark size={18} />
            {busy === "connect" ? "Redirecting…" : "Log in with GitHub"}
          </button>
          <button
            type="button"
            onClick={() => setView("manual")}
            className="mt-2 flex h-8 w-full items-center justify-center rounded-md text-[12px] font-medium text-[#8A8F98] transition-colors hover:bg-[#1E2026] hover:text-[#ECEEF0]"
          >
            Enter Manually
          </button>
        </div>
      </div>
    );
  }

  if (view === "manual") {
    return (
      <div className="mt-2 flex flex-col gap-2">
        {feedback}
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.03em] text-[#5E626E]">Manual entry</span>
          <button type="button" onClick={() => setView("choose")} className="text-[10px] text-[#8A8F98] underline-offset-2 hover:text-[#ECEEF0] hover:underline">
            Back
          </button>
        </div>

        <div className="rounded-lg border border-[#2E3038] bg-[#141518]">
          <div className="flex items-center gap-1.5 border-b border-[#26282E] px-2 py-1.5">
            <Icon name="folder_open" size={14} className="text-[#5E626E]" />
            <span className="font-mono text-[10px] uppercase tracking-[0.03em] text-[#5E626E]">Repository</span>
          </div>
          <div className="flex items-center gap-1.5 p-2">
            <input
              value={repositoryPath}
              onChange={(e) => onRepositoryPathChange(e.target.value, null)}
              placeholder="https://github.com/owner/repository or owner/repository"
              spellCheck={false}
              className="h-7 min-w-0 flex-1 rounded border border-[#2E3038] bg-[#1A1B20] px-2 font-mono text-[11px] text-[#ECEEF0] placeholder:text-[#5E626E] focus:border-[#5E6AD2] focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void submitManualRepository()}
              disabled={busy !== null}
              className="h-7 rounded border border-[#2E3038] bg-[#222329] px-2.5 text-[11px] text-[#ECEEF0] hover:border-[#424652] disabled:opacity-50"
            >
              {busy === "manual-repo" ? "Verifying…" : "Use"}
            </button>
          </div>
          <p className="px-2 pb-2 text-[10px] leading-4 text-[#5E626E]">
            {connected
              ? "The repository is verified through the GitHub App before an issue can be imported."
              : "Public repositories can be referenced without GitHub App access. Connect GitHub to import an issue."}
          </p>
        </div>

        {connected && selectedRepository && (
          <div className="rounded-lg border border-[#2E3038] bg-[#141518]">
            <div className="flex items-center gap-1.5 border-b border-[#26282E] px-2 py-1.5">
              <Icon name="bug_report" size={14} className="text-[#5E626E]" />
              <span className="font-mono text-[10px] uppercase tracking-[0.03em] text-[#5E626E]">Issue</span>
            </div>
            <div className="flex items-center gap-1.5 p-2">
              <input
                value={manualIssue}
                onChange={(e) => setManualIssue(e.target.value)}
                placeholder="142 or https://github.com/owner/repo/issues/142"
                spellCheck={false}
                className="h-7 min-w-0 flex-1 rounded border border-[#2E3038] bg-[#1A1B20] px-2 font-mono text-[11px] text-[#ECEEF0] placeholder:text-[#5E626E] focus:border-[#5E6AD2] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void submitManualIssue()}
                disabled={busy !== null}
                className="h-7 rounded border border-[#2E3038] bg-[#222329] px-2.5 text-[11px] text-[#ECEEF0] hover:border-[#424652] disabled:opacity-50"
              >
                {busy?.startsWith("issue-") ? "Fetching…" : "Fetch"}
              </button>
            </div>
          </div>
        )}

        {connected && selectedRepository && (
          <p className="flex items-center gap-1 font-mono text-[10px] text-[#5E626E]">
            <Icon name="verified" size={12} className="text-[#27A567]" />
            {selectedRepository.fullName} · {selectedRepository.defaultBranch} · installation verified
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      {feedback}
      <div className="flex items-center justify-end">
        <button type="button" onClick={() => setView("choose")} className="text-[10px] text-[#8A8F98] underline-offset-2 hover:text-[#ECEEF0] hover:underline">
          Change source
        </button>
      </div>

      {!configured && (
        <div className="rounded-lg border border-[#E5A158]/25 bg-[#E5A158]/5 p-2.5">
          <p className="flex items-center gap-1.5 text-[12px] font-medium text-[#E5A158]">
            <Icon name="key_off" size={14} /> GitHub App is not configured
          </p>
          <p className="mt-0.5 text-[11px] leading-4 text-[#8A8F98]">
            The backend is missing {status?.missing.length ? status.missing.join(", ") : "GitHub App credentials"}. A connection cannot be created until the maintainer completes
            registration.
          </p>
          <p className="mt-1 text-[11px] leading-4 text-[#5E626E]">
            You can still enter a public <span className="font-mono">owner/repository</span> below; it will be cloned without GitHub App access.
          </p>
        </div>
      )}

      {connected && status?.account ? (
        <div className="rounded-lg border border-[#2E3038] bg-[#141518] p-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Avatar url={status.account.avatarUrl} login={status.account.login} size={26} />
              <div className="min-w-0">
                <p className="truncate text-[12px] font-medium text-[#ECEEF0]">
                  {status.account.name ?? status.account.login} <span className="font-mono text-[11px] text-[#8A8F98]">@{status.account.login}</span>
                </p>
                <p className="text-[10px] leading-[14px] text-[#5E626E]">
                  Connected{status.tokenExpiresAt ? ` · authorization expires ${new Date(status.tokenExpiresAt).toLocaleString()}` : ""}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {status.account.htmlUrl && (
                <a href={status.account.htmlUrl} target="_blank" rel="noreferrer" className="rounded border border-[#2E3038] px-1.5 py-1 text-[11px] text-[#8A8F98] hover:text-[#ECEEF0]">
                  Profile
                </a>
              )}
              <button type="button" onClick={() => void connect()} disabled={busy !== null} className="rounded border border-[#2E3038] px-1.5 py-1 text-[11px] text-[#ECEEF0] transition-colors hover:border-[#5E6AD2]/40 hover:bg-[#5E6AD2]/10 disabled:opacity-50">
                {busy === "connect" ? "Redirecting…" : "Reconnect"}
              </button>
              <button type="button" onClick={() => void disconnect()} disabled={busy !== null} className="rounded border border-[#2E3038] px-1.5 py-1 text-[11px] text-[#E5484D] transition-colors hover:border-[#E5484D]/40 hover:bg-[#E5484D]/10 disabled:opacity-50">
                {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>
          </div>

          {installationsQuery.isError && (
            <p className="mt-2 rounded border border-[#E5484D]/25 bg-[#E5484D]/5 px-2 py-1 text-[11px] text-[#E5484D]">
              {errorMessage(installationsQuery.error)}
              <button type="button" onClick={() => void installationsQuery.refetch()} className="ml-1 underline">Retry</button>
            </p>
          )}

          {installations && installations.length === 0 ? (
            <div className="mt-2 rounded border border-[#E5A158]/25 bg-[#E5A158]/5 px-2 py-2">
              <p className="text-[12px] text-[#E5A158]">No GitHub App installation is available to this account.</p>
              <p className="mt-0.5 text-[11px] leading-4 text-[#8A8F98]">Install DNAFix on a personal account or organization, then choose the repositories it may access.</p>
              <button type="button" onClick={() => void install()} disabled={busy !== null} className="mt-1.5 inline-flex h-7 items-center gap-1 rounded-md bg-[#5E6AD2] px-2.5 text-[12px] font-medium text-white hover:bg-[#6875E3] disabled:opacity-50">
                <Icon name="add" size={14} /> {busy === "install" ? "Opening GitHub…" : "Install GitHub App"}
              </button>
            </div>
          ) : installations && installations.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <label htmlFor="github-installation" className="text-[11px] text-[#8A8F98]">Installation</label>
              <select
                id="github-installation"
                value={effectiveInstallation ?? ""}
                onChange={(e) => {
                  if (!e.target.value) return;
                  void chooseInstallation(Number(e.target.value));
                }}
                disabled={busy !== null}
                className="h-7 rounded border border-[#2E3038] bg-[#1A1B20] px-1.5 font-mono text-[11px] text-[#ECEEF0] focus:border-[#5E6AD2] focus:outline-none"
              >
                {effectiveInstallation === null && (
                  <option value="" disabled>
                    Select an installation…
                  </option>
                )}
                {installations.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.accountLogin} ({i.accountType}){i.suspended ? " — suspended" : ""}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => void install()} disabled={busy !== null} className="text-[11px] text-[#8A8F98] underline-offset-2 hover:text-[#ECEEF0] hover:underline">
                Manage repositories
              </button>
              {suspended && <span className="text-[11px] text-[#E5484D]">Installation suspended — restore it on GitHub.</span>}
            </div>
          ) : installationsQuery.isLoading ? (
            <p className="mt-2 text-[11px] text-[#8A8F98]">Checking installations…</p>
          ) : null}
        </div>
      ) : configured ? (
        <div className="rounded-lg border border-[#2E3038] bg-[#141518] p-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-[12px] font-medium text-[#ECEEF0]">
                <Icon name="link" size={14} className="text-[#BDC2FF]" /> Connect your GitHub account
              </p>
              <p className="mt-0.5 text-[11px] leading-4 text-[#8A8F98]">
                DNAFix requests read-only access to repository metadata, contents and issues through a GitHub App. Tokens stay on the server, encrypted at rest.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void connect()}
              disabled={busy !== null}
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-[#5E6AD2] px-2.5 text-[12px] font-medium text-white hover:bg-[#6875E3] disabled:opacity-50"
            >
              <Icon name="login" size={14} /> {busy === "connect" ? "Redirecting…" : "Connect GitHub"}
            </button>
          </div>
        </div>
      ) : null}

      {status?.authorizationExpired && (
        <p className="rounded-md border border-[#E5A158]/25 bg-[#E5A158]/5 px-2 py-1.5 text-[11px] text-[#E5A158]">
          GitHub authorization expired. Reconnect to continue browsing private repositories.
        </p>
      )}

      {/* Repository picker */}
      {(connected || !configured) && (!configured || (connected && effectiveInstallation !== null)) && !suspended && (
        <div className="rounded-lg border border-[#2E3038] bg-[#141518]">
          <div className="flex flex-wrap items-center gap-1.5 border-b border-[#26282E] px-2 py-1.5">
            <Icon name="folder_open" size={14} className="text-[#5E626E]" />
            <span className="mr-1 font-mono text-[10px] uppercase tracking-[0.03em] text-[#5E626E]">Repository</span>
            {connected && (
              <>
                <div className="relative min-w-[140px] flex-1">
                  <Icon name="search" size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[#5E626E]" />
                  <input
                    value={repoSearch}
                    onChange={(e) => {
                      setRepoSearch(e.target.value);
                      setRepoPage(1);
                    }}
                    placeholder="Search repositories or owners…"
                    spellCheck={false}
                    className="h-6 w-full rounded border border-[#2E3038] bg-[#1A1B20] pl-7 pr-2 text-[11px] text-[#ECEEF0] placeholder:text-[#5E626E] focus:border-[#5E6AD2] focus:outline-none"
                  />
                </div>
                <select
                  aria-label="Owner filter"
                  value={ownerFilter}
                  onChange={(e) => {
                    setOwnerFilter(e.target.value);
                    setRepoPage(1);
                  }}
                  className="h-6 rounded border border-[#2E3038] bg-[#1A1B20] px-1 font-mono text-[10px] text-[#8A8F98] focus:border-[#5E6AD2] focus:outline-none"
                >
                  <option value="">All owners</option>
                  {(repositoriesQuery.data?.owners ?? []).map((o) => (
                    <option key={o.login} value={o.login}>{o.login}</option>
                  ))}
                </select>
                <select
                  aria-label="Visibility filter"
                  value={visibility}
                  onChange={(e) => {
                    setVisibility(e.target.value as "all" | "public" | "private");
                    setRepoPage(1);
                  }}
                  className="h-6 rounded border border-[#2E3038] bg-[#1A1B20] px-1 font-mono text-[10px] text-[#8A8F98] focus:border-[#5E6AD2] focus:outline-none"
                >
                  <option value="all">All</option>
                  <option value="public">Public</option>
                  <option value="private">Private</option>
                </select>
              </>
            )}
            <button type="button" onClick={() => setManualRepoOpen((v) => !v)} className="ml-auto text-[10px] text-[#8A8F98] underline-offset-2 hover:text-[#ECEEF0] hover:underline">
              Enter repository URL
            </button>
          </div>

          {manualRepoOpen && (
            <div className="flex items-center gap-1.5 border-b border-[#26282E] px-2 py-1.5">
              <input
                value={repositoryPath}
                onChange={(e) => onRepositoryPathChange(e.target.value, null)}
                placeholder="https://github.com/owner/repository or owner/repository"
                spellCheck={false}
                className="h-6 min-w-0 flex-1 rounded border border-[#2E3038] bg-[#1A1B20] px-2 font-mono text-[11px] text-[#ECEEF0] placeholder:text-[#5E626E] focus:border-[#5E6AD2] focus:outline-none"
              />
              <button type="button" onClick={() => void submitManualRepository()} disabled={busy !== null} className="h-6 rounded border border-[#2E3038] bg-[#222329] px-2 text-[11px] text-[#ECEEF0] hover:border-[#424652] disabled:opacity-50">
                {busy === "manual-repo" ? "Verifying…" : "Use"}
              </button>
            </div>
          )}

          {connected && (
            <div className="max-h-64 overflow-y-auto">
              {repositoriesQuery.isLoading ? (
                <p className="px-2 py-3 text-[11px] text-[#8A8F98]">Loading authorized repositories…</p>
              ) : repositoriesQuery.isError ? (
                <p className="px-2 py-3 text-[11px] text-[#E5484D]">
                  {errorMessage(repositoriesQuery.error)}
                  <button type="button" onClick={() => void repositoriesQuery.refetch()} className="ml-1 underline">Retry</button>
                </p>
              ) : (repositoriesQuery.data?.repositories ?? []).length === 0 ? (
                <p className="px-2 py-3 text-[11px] text-[#8A8F98]">
                  No repositories match. {debouncedRepoSearch ? "Clear the search, " : ""}or adjust the App installation's repository selection.
                </p>
              ) : (
                repositoriesQuery.data?.repositories.map((repo) => (
                  <RepoRow
                    key={repo.id}
                    repo={repo}
                    selected={selectedRepository?.id === repo.id}
                    onSelect={() => void selectRepository(repo)}
                    busy={busy !== null}
                  />
                ))
              )}
            </div>
          )}

          <div className="flex items-center justify-between border-t border-[#26282E] px-2 py-1 font-mono text-[10px] text-[#5E626E]">
            <span>
              {repositoriesQuery.data ? `${repositoriesQuery.data.totalCount} repositor${repositoriesQuery.data.totalCount === 1 ? "y" : "ies"}${repositoriesQuery.data.cached ? " · cached 30s" : ""}` : connected ? "Live from GitHub" : "Public repository entry"}
            </span>
            {connected && (
              <span className="flex items-center gap-1">
                <button type="button" disabled={repoPage <= 1} onClick={() => setRepoPage((p) => Math.max(1, p - 1))} className="rounded border border-[#2E3038] px-1 disabled:opacity-40">Prev</button>
                <span>p{repoPage}</span>
                <button type="button" disabled={!repositoriesQuery.data?.hasNext} onClick={() => setRepoPage((p) => p + 1)} className="rounded border border-[#2E3038] px-1 disabled:opacity-40">Next</button>
              </span>
            )}
          </div>
        </div>
      )}

      {/* Issue picker */}
      {connected && selectedRepository && !suspended && (
        <div className="rounded-lg border border-[#2E3038] bg-[#141518]">
          <div className="flex flex-wrap items-center gap-1.5 border-b border-[#26282E] px-2 py-1.5">
            <Icon name="bug_report" size={14} className="text-[#5E626E]" />
            <span className="mr-1 font-mono text-[10px] uppercase tracking-[0.03em] text-[#5E626E]">Issues</span>
            <div className="relative min-w-[150px] flex-1">
              <Icon name="search" size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[#5E626E]" />
              <input
                value={issueSearch}
                onChange={(e) => setIssueSearch(e.target.value)}
                placeholder="Search titles, body text, labels…"
                spellCheck={false}
                className="h-6 w-full rounded border border-[#2E3038] bg-[#1A1B20] pl-7 pr-2 text-[11px] text-[#ECEEF0] placeholder:text-[#5E626E] focus:border-[#5E6AD2] focus:outline-none"
              />
            </div>
            <select
              aria-label="Issue state"
              value={issueState}
              onChange={(e) => setIssueState(e.target.value as "open" | "closed" | "all")}
              className="h-6 rounded border border-[#2E3038] bg-[#1A1B20] px-1 font-mono text-[10px] text-[#8A8F98] focus:border-[#5E6AD2] focus:outline-none"
            >
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="all">All</option>
            </select>
            <button type="button" onClick={() => setManualIssueOpen((v) => !v)} className="text-[10px] text-[#8A8F98] underline-offset-2 hover:text-[#ECEEF0] hover:underline">
              Issue number / URL
            </button>
          </div>

          {manualIssueOpen && (
            <div className="flex items-center gap-1.5 border-b border-[#26282E] px-2 py-1.5">
              <input
                value={manualIssue}
                onChange={(e) => setManualIssue(e.target.value)}
                placeholder="142 or https://github.com/owner/repo/issues/142"
                spellCheck={false}
                className="h-6 min-w-0 flex-1 rounded border border-[#2E3038] bg-[#1A1B20] px-2 font-mono text-[11px] text-[#ECEEF0] placeholder:text-[#5E626E] focus:border-[#5E6AD2] focus:outline-none"
              />
              <button type="button" onClick={() => void submitManualIssue()} disabled={busy !== null} className="h-6 rounded border border-[#2E3038] bg-[#222329] px-2 text-[11px] text-[#ECEEF0] hover:border-[#424652] disabled:opacity-50">
                {busy?.startsWith("issue-") ? "Fetching…" : "Fetch"}
              </button>
            </div>
          )}

          <div className="max-h-56 overflow-y-auto">
            {issuesQuery.isLoading ? (
              <p className="px-2 py-3 text-[11px] text-[#8A8F98]">Loading issues from GitHub…</p>
            ) : issuesQuery.isError ? (
              <p className="px-2 py-3 text-[11px] text-[#E5484D]">
                {errorMessage(issuesQuery.error)}
                <button type="button" onClick={() => void issuesQuery.refetch()} className="ml-1 underline">Retry</button>
              </p>
            ) : (issuesQuery.data?.items ?? []).length === 0 ? (
              <p className="px-2 py-3 text-[11px] text-[#8A8F98]">
                No {issueState === "all" ? "" : `${issueState} `}issues match this search. Pull requests are excluded.
              </p>
            ) : (
              issuesQuery.data?.items.map((issue) => (
                <IssueRow key={issue.number} issue={issue} selected={selectedIssueNumber === issue.number} onSelect={() => void loadIssue(issue.number)} />
              ))
            )}
          </div>

          <div className="flex items-center justify-between border-t border-[#26282E] px-2 py-1 font-mono text-[10px] text-[#5E626E]">
            <span>
              {issuesQuery.data
                ? `${issuesQuery.data.totalCount ?? issuesQuery.data.items.length}${issuesQuery.data.totalCount === null ? "+" : ""} issue${(issuesQuery.data.totalCount ?? 0) === 1 ? "" : "s"} · ${issuesQuery.data.source === "search" ? "GitHub search" : "GitHub issues"}`
                : "Live from GitHub"}
            </span>
            <span className="flex items-center gap-1">
              <button type="button" disabled={issuePage <= 1} onClick={() => setIssuePage((p) => Math.max(1, p - 1))} className="rounded border border-[#2E3038] px-1 disabled:opacity-40">Prev</button>
              <span>p{issuePage}</span>
              <button type="button" disabled={!issuesQuery.data?.hasNext} onClick={() => setIssuePage((p) => p + 1)} className="rounded border border-[#2E3038] px-1 disabled:opacity-40">Next</button>
            </span>
          </div>
        </div>
      )}

      {connected && selectedRepository && (
        <p className="flex items-center gap-1 font-mono text-[10px] text-[#5E626E]">
          <Icon name="verified" size={12} className="text-[#27A567]" />
          {selectedRepository.fullName} · {selectedRepository.defaultBranch} · installation verified
        </p>
      )}
    </div>
  );
}
