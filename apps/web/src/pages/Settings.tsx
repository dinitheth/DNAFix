import type { ReactNode } from "react";
import { useConfigStatus, ReadinessPanel } from "../components/ReadinessPanel";
import { Icon } from "../components/Icon";
import { SectionLabel, Skeleton } from "../components/ui";
import type { ConfigStatus } from "../lib/api";

function Row({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[#26282E]/50 py-1.5 last:border-0">
      <dt className="shrink-0 text-[12px] leading-4 text-[#8A8F98]">{label}</dt>
      <dd className={`min-w-0 truncate text-right text-[12px] leading-[18px] text-[#ECEEF0] ${mono ? "font-mono" : ""}`} title={value}>
        {value}
      </dd>
    </div>
  );
}

function Section({ id, index, title, icon, children }: { id?: string; index: string; title: string; icon: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-16 rounded-xl border border-[#26282E] bg-[#1A1B20] p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <SectionLabel index={index}>{title}</SectionLabel>
        <Icon name={icon} size={15} className="text-[#5E626E]" />
      </div>
      <dl>{children}</dl>
    </section>
  );
}

export function Settings() {
  const config = useConfigStatus();
  const data: ConfigStatus | undefined = config.data;

  return (
    <div>
      <header className="mb-3 flex flex-col gap-1 border-b border-[#26282E] pb-3">
        <h1 className="text-[20px] font-semibold leading-[26px] tracking-[-0.02em] text-[#ECEEF0]">Settings</h1>
        <p className="mt-0.5 max-w-2xl text-[13px] leading-[18px] text-[#8A8F98]">
          Read-only view of the live API configuration. Values are resolved from the API host environment; secrets are never sent to the browser.
        </p>
      </header>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
        <div className="flex flex-col gap-3 lg:col-span-8">
          {!data ? (
            <>
              <Skeleton className="h-[210px] w-full" />
              <Skeleton className="h-[130px] w-full" />
            </>
          ) : (
            <>
              <Section id="model" index="01" title="Model Provider" icon="memory">
                <Row label="Planner model" value={data.model.modelId} />
                <Row label="Sub-agent model" value={data.model.subAgentModelId} />
                <Row label="Provider" value={data.model.provider} />
                <Row label="Transport" value={data.model.transport} />
                <Row label="Endpoint" value={data.model.baseUrl} />
                <Row label="API key" value={data.model.configured ? "Configured" : "Not configured"} mono={false} />
                <p className="pt-2 text-[12px] leading-4 text-[#5E626E]">
                  Read from <span className="font-mono text-[#8A8F98]">MODEL_API_KEY</span> when the API process starts. Restart the API after changing it.
                </p>
              </Section>

              <Section id="dna" index="02" title="Repository Intelligence" icon="account_tree">
                <Row label="Project DNA" value={data.projectDna.configured ? "Available" : "Not configured"} mono={false} />
                <Row label="Path" value={data.projectDna.path ?? "—"} />
                <p className="pt-2 text-[12px] leading-4 text-[#5E626E]">
                  Resolved from <span className="font-mono text-[#8A8F98]">PROJECT_DNA_PATH</span> or the pinned{" "}
                  <span className="font-mono text-[#8A8F98]">vendor/Project-DNA</span> submodule. Deterministic analysis only.
                </p>
              </Section>

              <Section id="execution" index="03" title="Execution" icon="terminal">
                <Row label="Provider" value={data.execution.provider} />
                <Row label="Sandbox mode" value={data.sandboxMode} />
                <Row label="Region" value={data.execution.region} />
                <Row label="CodeBuild project" value={data.execution.project ?? "—"} />
                <Row label="Artifact bucket" value={data.execution.bucket ?? "—"} />
                <Row label="Remote configured" value={data.execution.remoteConfigured ? "Yes" : "No"} mono={false} />
                <p className="pt-2 text-[12px] leading-4 text-[#5E626E]">
                  Host mode runs directly on this machine with no OS isolation. Trusted repositories and fixtures only; use Docker or AWS CodeBuild for untrusted code.
                </p>
              </Section>

              <Section id="github" index="04" title="GitHub Integration" icon="source_environment">
                <Row label="GitHub App" value={data.github.configured ? "Configured" : "Not configured"} mono={false} />
                <Row label="Pull requests" value={data.github.configured ? "Draft PR after approval" : "Local patches only"} mono={false} />
                <p className="pt-2 text-[12px] leading-4 text-[#5E626E]">
                  Requires <span className="font-mono text-[#8A8F98]">GITHUB_APP_ID</span>,{" "}
                  <span className="font-mono text-[#8A8F98]">GITHUB_APP_PRIVATE_KEY</span> and{" "}
                  <span className="font-mono text-[#8A8F98]">GITHUB_INSTALLATION_ID</span> on the API host.
                </p>
              </Section>

              <Section id="workflow" index="05" title="Workflow Persistence" icon="history">
                <Row label="Engine" value={data.workflowEngine} />
                <Row label="Temporal address" value={data.temporalAddress ?? "—"} />
                <p className="pt-2 text-[12px] leading-4 text-[#5E626E]">
                  The local durable engine journals every transition to SQLite and resumes after restart. Set{" "}
                  <span className="font-mono text-[#8A8F98]">WORKFLOW_ENGINE=temporal</span> for production durability.
                </p>
              </Section>
            </>
          )}
        </div>

        <aside className="flex flex-col gap-2 lg:col-span-4">
          <ReadinessPanel config={data} />
          <div className="rounded-xl border border-[#26282E] bg-[#1A1B20] p-3">
            <div className="mb-1 flex items-center gap-1.5">
              <Icon name="menu_book" size={15} className="text-[#5E626E]" />
              <h2 className="text-[13px] font-medium leading-[18px] tracking-[-0.01em] text-[#ECEEF0]">Documentation</h2>
            </div>
            <p className="text-[12px] leading-4 text-[#8A8F98]">Architecture decisions, security posture and evaluation records live in the repository docs.</p>
            <a
              href="https://github.com/dinitheth/DNAFix/tree/main/docs"
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-[12px] leading-4 text-[#BDC2FF] hover:text-white hover:underline"
            >
              Open documentation
              <Icon name="arrow_forward" size={13} />
            </a>
          </div>
        </aside>
      </div>
    </div>
  );
}
