import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { SectionLabel, StatusPill } from "../components/ui";
import { useConfigStatus } from "../lib/config-status";
import { api, type GitHubStatus, type McpConnectorView } from "../lib/api";
import { blockingReasons, configurationSummary, formatAgo, readinessItems, type ReadinessItem } from "../lib/status";

type Tone = "ok" | "warn" | "bad";

const DOT: Record<Tone, string> = { ok: "bg-[#27A567]", warn: "bg-[#E5A158]", bad: "bg-[#E5484D]" };

function Row({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: Tone }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-[12px] text-[#8A8F98]">{label}</dt>
      <dd className="flex min-w-0 items-center justify-end gap-2">
        <span className="truncate font-mono text-[11px] text-[#ECEEF0]" title={hint ? `${value} — ${hint}` : value}>
          {value}
        </span>
        {tone && <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[tone]}`} aria-hidden />}
      </dd>
    </div>
  );
}

function Group({ id, index, title, pill, children, action }: { id: string; index: string; title: string; pill: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-16 flex flex-col rounded-xl border border-[#26282E] bg-[#1A1B20] p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <SectionLabel index={index}>{title}</SectionLabel>
        {pill}
      </div>
      <dl className="divide-y divide-[#26282E]/60">{children}</dl>
      {action && <div className="mt-2 border-t border-[#26282E]/60 pt-2">{action}</div>}
    </section>
  );
}

function ConnectorLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="flex items-center gap-1 text-[12px] text-[#BDC2FF] hover:underline">
      {label}
      <Icon name="chevron_right" size={14} />
    </Link>
  );
}

function toneOf(item: ReadinessItem | undefined): { pill: "success" | "warning" | "danger" | "neutral"; label: string } {
  if (!item) return { pill: "neutral", label: "—" };
  if (item.tone === "ready") return { pill: "success", label: item.state };
  if (item.tone === "blocked") return { pill: "danger", label: item.state };
  if (item.tone === "attention") return { pill: "warning", label: item.state };
  return { pill: "neutral", label: item.state };
}

function mcpTone(state: McpConnectorView["state"] | undefined): "success" | "warning" | "danger" | "neutral" {
  if (!state) return "neutral";
  if (state === "connected") return "success";
  if (state === "connection-error" || state === "authentication-required") return "danger";
  if (state === "disabled" || state === "not-configured") return "neutral";
  return "warning";
}

export function Settings() {
  const config = useConfigStatus();
  const github = useQuery({ queryKey: ["github-status"], queryFn: ({ signal }) => api<GitHubStatus>("/integrations/github/status", { signal }), retry: false });
  const mcp = useQuery({ queryKey: ["mcp-status"], queryFn: ({ signal }) => api<McpConnectorView>("/mcp/status", { signal }), retry: false });
  const [copy, setCopy] = useState<{ state: "idle" | "done" | "error"; message?: string }>({ state: "idle" });
  const [summary, setSummary] = useState<string | null>(null);

  const data = config.data;
  const blockers = data ? blockingReasons(data) : [];
  const items = data ? readinessItems(data) : [];
  const toneFor = (id: string) => toneOf(items.find((i) => i.id === id));
  const dnaItem = items.find((i) => i.id === "dna");
  const security = data?.security;
  const detection = mcp.data?.detection;
  const pendingApprovals = (mcp.data?.approvals ?? []).filter((a) => a.status === "pending").length;

  function refresh() {
    setCopy({ state: "idle" });
    void Promise.all([config.refetch(), github.refetch(), mcp.refetch()]);
  }

  async function copySummary() {
    if (!data) return;
    const text = configurationSummary(data, github.data ?? null, mcp.data ?? null);
    setSummary(text);
    try {
      await navigator.clipboard.writeText(text);
      setCopy({ state: "done" });
    } catch (err) {
      setCopy({ state: "error", message: (err as Error).message });
    }
  }

  return (
    <div>
      <header className="mb-3 flex items-center justify-between gap-2 border-b border-[#26282E] pb-3">
        <h1 className="text-[20px] font-semibold leading-[26px] tracking-[-0.02em] text-[#ECEEF0]">Settings</h1>
        <div className="flex items-center gap-2">
          {copy.state === "done" && <span className="font-mono text-[11px] text-[#34D399]">summary copied</span>}
          {copy.state === "error" && <span className="font-mono text-[11px] text-[#E5484D]" title={copy.message}>clipboard blocked</span>}
          <button
            type="button"
            onClick={() => void copySummary()}
            disabled={!data}
            className="flex h-8 items-center gap-1.5 rounded-md border border-[#2E3038] bg-[#222329] px-2.5 text-[12px] text-[#ECEEF0] transition-colors hover:border-[#424652] hover:bg-[#282A31] disabled:opacity-50"
          >
            <Icon name="content_copy" size={14} className="text-[#8A8F98]" />
            Copy summary
          </button>
          <button
            type="button"
            onClick={refresh}
            className="flex h-8 items-center gap-1.5 rounded-md border border-[#2E3038] bg-[#222329] px-2.5 text-[12px] text-[#ECEEF0] transition-colors hover:border-[#424652] hover:bg-[#282A31]"
          >
            <Icon name={config.isFetching || github.isFetching || mcp.isFetching ? "progress_activity" : "refresh"} size={14} className="text-[#8A8F98]" />
            Refresh
          </button>
        </div>
      </header>

      {copy.state === "error" && summary && (
        <div className="mb-3 rounded-lg border border-[#2E3038] bg-[#141518] p-2.5">
          <p className="mb-1 text-[11px] text-[#8A8F98]" title={copy.message}>
            The browser refused clipboard access. Select the text to copy it.
          </p>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-4 text-[#ECEEF0]">{summary}</pre>
        </div>
      )}

      {blockers.length > 0 && (
        <div className="mb-3 rounded-lg border border-[#E5484D]/25 bg-[#E5484D]/5 px-2.5 py-2">
          <ul className="flex flex-col gap-1">
            {blockers.map((reason) => (
              <li key={reason} className="flex items-center gap-2 text-[12px] leading-4 text-[#E5484D]">
                <Icon name="block" size={13} className="shrink-0" />
                <span className="min-w-0 truncate" title={reason}>{reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!data && <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="h-40 animate-pulse rounded-xl bg-[#1A1B20]" />)}</div>}

      {data && (
        <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
          <Group
            id="model"
            index="01"
            title="Model"
            pill={<StatusPill tone={data.model.configured ? "success" : "danger"}>{data.model.configured ? "Connected" : "No key"}</StatusPill>}
          >
            <Row label="Lead planner" value={data.model.modelId} tone={data.model.configured ? "ok" : "bad"} />
            <Row label="Sub-agents" value={data.model.subAgentModelId} />
            <Row label="Provider" value={data.model.provider} />
            <Row label="Transport" value={data.model.transport} />
            <Row label="Endpoint" value={data.model.baseUrl} />
            <Row label="API key" value={data.model.configured ? "present" : "missing"} hint="MODEL_API_KEY, read from the environment. DNAFix never sends the value to the browser." tone={data.model.configured ? "ok" : "bad"} />
          </Group>

          <Group
            id="dna"
            index="02"
            title="Project DNA"
            pill={<StatusPill tone={data.projectDna.configured ? "success" : "danger"}>{data.projectDna.configured ? "Resolved" : "Not resolved"}</StatusPill>}
          >
            <Row label="Checkout" value={data.projectDna.path ?? "not resolved"} tone={data.projectDna.configured ? "ok" : "bad"} />
            <Row label="Runtime" value={data.projectDna.runtime ?? "—"} hint="PROJECT_DNA_NODE_PATH, or the Node binary that started the process." />
            {!data.projectDna.configured && <p className="pt-1.5 text-[11px] leading-4 text-[#E5484D]">{dnaItem?.explanation}</p>}
          </Group>

          <Group id="execution" index="03" title="Execution" pill={<StatusPill tone={toneFor("execution").pill}>{toneFor("execution").label}</StatusPill>}>
            <Row label="Provider" value={data.execution.provider} />
            <Row label="Sandbox" value={data.sandboxMode} tone={data.sandboxMode === "docker" ? "ok" : "warn"} />
            {data.execution.provider === "codebuild" && (
              <>
                <Row label="Region" value={data.execution.region} />
                <Row label="CodeBuild project" value={data.execution.project ?? "not set"} tone={data.execution.remoteConfigured ? "ok" : "bad"} />
                <Row label="Artifacts bucket" value={data.execution.bucket ?? "not set"} />
                <Row label="Remote ready" value={data.execution.remoteConfigured ? "yes" : "no"} tone={data.execution.remoteConfigured ? "ok" : "bad"} />
              </>
            )}
            {detection && (
              <>
                <Row label="Docker CLI" value={detection.cli.available ? detection.cli.version ?? detection.cli.path ?? "available" : "not found"} tone={detection.cli.available ? "ok" : "warn"} hint="Reported by the Docker MCP connector's read-only detection." />
                <Row
                  label="Docker daemon"
                  value={detection.desktop.running === true ? "running" : detection.desktop.running === false ? "not running" : "not reported"}
                  tone={detection.desktop.running === true ? "ok" : "warn"}
                  hint={detection.desktop.statusDetail}
                />
                {data.sandboxMode === "docker" && detection.desktop.running === false && (
                  <p className="pt-1.5 text-[11px] leading-4 text-[#E5A158]">Sandbox mode is docker but the daemon is not running, so verification commands will fail until it starts.</p>
                )}
              </>
            )}
          </Group>

          <Group id="workflow" index="04" title="Workflow & persistence" pill={<StatusPill tone={toneFor("workflow").pill}>{toneFor("workflow").label}</StatusPill>}>
            <Row label="Engine" value={data.workflowEngine} />
            <Row label="Store" value={data.store?.kind ?? "—"} tone={data.store?.kind === "sqlite" ? "ok" : "warn"} />
            <Row label="Location" value={data.store?.location ?? "—"} />
            {data.workflowEngine === "temporal" && <Row label="Temporal" value={data.temporalAddress ?? "not set"} />}
          </Group>

          <Group
            id="security"
            index="05"
            title="Security"
            pill={
              <StatusPill tone={security?.remoteBind ? (security.sessionTokenRequired && security.repositoryRoots.length > 0 ? "success" : "danger") : "neutral"}>
                {security?.remoteBind ? "Exposed" : "Loopback"}
              </StatusPill>
            }
          >
            <Row label="Bind" value={security?.bind ?? "—"} />
            <Row label="Auth" value={security?.sessionTokenRequired ? "bearer token" : "loopback only"} hint="DNAFIX_SESSION_TOKEN. Without it the API refuses a non-loopback bind." tone={security?.sessionTokenRequired ? "ok" : "warn"} />
            <Row
              label="Repository roots"
              value={security && security.repositoryRoots.length > 0 ? `${security.repositoryRoots.length} allowed` : "unrestricted"}
              hint={security?.repositoryRoots.join("\n") ?? ""}
              tone={security && security.repositoryRoots.length > 0 ? "ok" : "warn"}
            />
            <Row label="Webhook signing" value={security?.webhookSecretConfigured ? "key present" : "no key"} hint="GITHUB_WEBHOOK_SECRET. Deliveries are rejected without it." tone={security?.webhookSecretConfigured ? "ok" : "warn"} />
            <Row label="Token encryption" value={security?.tokenEncryptionKeyConfigured ? "key present" : "no key"} hint="GITHUB_TOKEN_ENCRYPTION_KEY — AES-256-GCM for stored GitHub tokens." tone={security?.tokenEncryptionKeyConfigured ? "ok" : "warn"} />
            <Row label="Browser origin" value={security?.corsOrigin ?? "—"} />
          </Group>

          <Group
            id="github"
            index="06"
            title="GitHub"
            pill={
              github.data?.connected
                ? <StatusPill tone="success">Connected</StatusPill>
                : toneFor("github").pill === "neutral"
                  ? <StatusPill tone="neutral">{toneFor("github").label}</StatusPill>
                  : <StatusPill tone={toneFor("github").pill}>{toneFor("github").label}</StatusPill>
            }
            action={<ConnectorLink to="/connectors/github" label="GitHub connector" />}
          >
            {github.isError && <Row label="Status" value="not reported by the API" tone="bad" />}
            {github.data && (
              <>
                <Row label="App" value={github.data.configured ? "configured" : "not configured"} tone={github.data.configured ? "ok" : "warn"} />
                <Row label="Account" value={github.data.account?.login ?? "not connected"} tone={github.data.connected ? "ok" : "warn"} />
                <Row label="Installation" value={github.data.installation ? `${github.data.installation.accountLogin} · ${github.data.installation.id}` : "none selected"} />
                <Row label="Token expires" value={github.data.tokenExpiresAt ? `${formatAgo(github.data.tokenExpiresAt)} · ${new Date(github.data.tokenExpiresAt).toLocaleString()}` : "—"} tone={github.data.authorizationExpired ? "bad" : "ok"} />
                <Row label="Last verified" value={github.data.lastVerifiedAt ? formatAgo(github.data.lastVerifiedAt) : "never"} />
                {github.data.missing.length > 0 && <Row label="Missing config" value={github.data.missing.join(", ")} tone="warn" />}
              </>
            )}
          </Group>

          <Group
            id="docker-mcp"
            index="07"
            title="Docker MCP"
            pill={<StatusPill tone={mcpTone(mcp.data?.state)}>{mcp.data?.state ?? "unknown"}</StatusPill>}
            action={<ConnectorLink to="/connectors/docker" label="Docker MCP connector" />}
          >
            {mcp.isError && <Row label="Status" value="connector unavailable" tone="warn" />}
            {mcp.data && (
              <>
                <Row label="Enabled" value={mcp.data.enabled ? "yes" : "no"} tone={mcp.data.enabled ? "ok" : "warn"} />
                <Row label="Profile" value={mcp.data.selectedProfile?.name ?? mcp.data.profileId ?? "none"} />
                <Row label="Servers" value={`${mcp.data.serverCount}`} />
                <Row label="Tools" value={`${mcp.data.enabledToolCount}/${mcp.data.toolCount}`} />
                <Row label="Gateway" value={mcp.data.gateway ? `${mcp.data.gateway.serverInfo.name} ${mcp.data.gateway.serverInfo.version}` : "no handshake"} tone={mcp.data.gateway ? "ok" : "warn"} />
                <Row label="Approvals" value={pendingApprovals > 0 ? `${pendingApprovals} pending` : "none pending"} tone={pendingApprovals > 0 ? "warn" : "ok"} />
                <Row label="Detected" value={mcp.data.detection?.summary ?? "—"} hint={mcp.data.checkedAt} />
                {mcp.data.lastError && <Row label="Last error" value={mcp.data.lastError} tone="bad" />}
              </>
            )}
          </Group>

          <Link to="/docs" className="flex items-center gap-2 rounded-xl border border-[#26282E] bg-[#1A1B20] p-3 text-[13px] text-[#ECEEF0] hover:border-[#424652] lg:col-span-2">
            <Icon name="menu_book" size={16} className="text-[#BDC2FF]" />
            Environment variables and setup documentation
            <Icon name="chevron_right" size={15} className="ml-auto text-[#5E626E]" />
          </Link>
        </div>
      )}
    </div>
  );
}
