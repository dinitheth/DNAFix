import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Button, StatusPill } from "../components/ui";
import { useConfigStatus } from "../lib/config-status";
import type { ConfigStatus } from "../lib/api";

function Row({ label, value, tone }: { label: string; value: string; tone?: "ok" | "bad" | "warn" }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <dt className="text-[12px] text-[#8A8F98]">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-[11px] text-white" title={value}>{value}</span>
        {tone && <span className={`h-2 w-2 shrink-0 rounded-full ${tone === "ok" ? "bg-[#27A567]" : tone === "warn" ? "bg-[#E5A158]" : "bg-[#E5484D]"}`} aria-hidden />}
      </dd>
    </div>
  );
}

function Group({ id, title, children, action }: { id: string; title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-16 rounded-xl border border-[#26282E] bg-[#1A1B20] p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-medium text-white">{title}</h2>
        {action}
      </div>
      <dl className="mt-1 divide-y divide-[#26282E]/60">{children}</dl>
    </section>
  );
}

export function Settings() {
  const config = useConfigStatus();
  const data: ConfigStatus | undefined = config.data;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <header className="flex items-center justify-between">
        <h1 className="text-[20px] font-semibold text-white">Settings</h1>
        <Button variant="secondary" loading={config.isFetching} onClick={() => void config.refetch()}><Icon name="refresh" size={14} /> Refresh</Button>
      </header>

      {!data && <div className="mt-4 h-64 animate-pulse rounded-xl bg-[#1A1B20]" />}

      {data && (
        <div className="mt-4 flex flex-col gap-3">
          <Group id="model" title="Model" action={<StatusPill tone={data.model.configured ? "success" : "danger"}>{data.model.configured ? "Configured" : "Missing key"}</StatusPill>}>
            <Row label="Planner" value={data.model.modelId} tone={data.model.configured ? "ok" : "bad"} />
            <Row label="Sub-agent" value={data.model.subAgentModelId} />
            <Row label="Transport" value={data.model.transport} />
            <Row label="Endpoint" value={data.model.baseUrl} />
          </Group>

          <Group id="dna" title="Project DNA" action={<StatusPill tone={data.projectDna.configured ? "success" : "danger"}>{data.projectDna.configured ? "Available" : "Not configured"}</StatusPill>}>
            <Row label="Path" value={data.projectDna.path ?? "—"} tone={data.projectDna.configured ? "ok" : "bad"} />
          </Group>

          <Group id="execution" title="Execution">
            <Row label="Provider" value={data.execution.provider} />
            <Row label="Sandbox" value={data.sandboxMode} tone={data.sandboxMode === "docker" ? "ok" : "warn"} />
            {data.execution.provider === "codebuild" && (
              <>
                <Row label="Region" value={data.execution.region} />
                <Row label="CodeBuild" value={data.execution.project ?? "—"} tone={data.execution.remoteConfigured ? "ok" : "bad"} />
                <Row label="Artifacts" value={data.execution.bucket ?? "—"} />
              </>
            )}
          </Group>

          <Group id="workflow" title="Workflow">
            <Row label="Engine" value={data.workflowEngine} tone="ok" />
            <Row label="Store" value={data.store?.location ?? "—"} tone={data.store?.kind === "sqlite" ? "ok" : "warn"} />
            <Row label="Temporal" value={data.temporalAddress ?? "—"} />
          </Group>

          <Group id="github" title="Integrations" action={<Link to="/connectors" className="text-[12px] text-[#BDC2FF] hover:underline">Open Connectors</Link>}>
            <Row label="GitHub" value={(data.github.userIntegrationConfigured ?? data.github.configured) ? "configured" : "not configured"} tone={(data.github.userIntegrationConfigured ?? data.github.configured) ? "ok" : "warn"} />
            <Row label="Docker MCP" value="manage in Connectors" />
          </Group>

          <Link to="/docs" className="flex items-center gap-2 rounded-xl border border-[#26282E] bg-[#1A1B20] p-3 text-[13px] text-white hover:border-[#424652]">
            <Icon name="menu_book" size={16} className="text-[#BDC2FF]" /> Documentation
            <Icon name="chevron_right" size={15} className="ml-auto text-[#5E626E]" />
          </Link>
        </div>
      )}
    </div>
  );
}
