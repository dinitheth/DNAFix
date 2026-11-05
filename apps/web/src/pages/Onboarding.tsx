import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { SectionLabel, Skeleton, StatusPill } from "../components/ui";
import { api, type GitHubStatus, type RepositoryRecord, type Run } from "../lib/api";
import { useConfigStatus } from "../lib/config-status";
import { onboardingSteps } from "../lib/onboarding";

export function Onboarding() {
  const config = useConfigStatus();
  const github = useQuery({ queryKey: ["github-status"], queryFn: () => api<GitHubStatus>("/integrations/github/status"), retry: false });
  const repos = useQuery({ queryKey: ["repos"], queryFn: () => api<RepositoryRecord[]>("/repositories") });
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs") });

  const steps = onboardingSteps(config.data ?? null, github.data ?? null, repos.data ?? [], runs.data ?? []);
  const blockers = steps.filter((step) => step.blocking);
  const done = steps.filter((step) => step.tone === "success").length;
  const loading = config.isLoading || github.isLoading || repos.isLoading || runs.isLoading;

  return (
    <div>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-[#26282E] pb-3">
        <div className="flex items-center gap-2">
          <h1 className="text-[20px] font-semibold text-[#ECEEF0]">Setup</h1>
          <span className="font-mono text-[11px] text-[#5E626E]">{done}/{steps.length} resolved</span>
        </div>
        <Link to="/new" className="flex h-8 items-center gap-1.5 rounded-md bg-[#5E6AD2] px-3 text-[13px] font-medium text-white hover:bg-[#6875E3]">
          <Icon name="add" size={15} /> New Analysis
        </Link>
      </header>

      {blockers.length > 0 ? (
        <p className="mb-3 rounded-xl border border-[#E5484D]/30 bg-[#E5484D]/5 px-3 py-2 text-[12px] text-[#ECEEF0]">
          {blockers.length === 1 ? "One step blocks" : `${blockers.length} steps block`} the first analysis:{" "}
          {blockers.map((step, index) => (
            <span key={step.id}>
              {index > 0 && ", "}
              <Link to={step.href} className="text-[#BDC2FF] hover:underline">{step.title.toLowerCase()}</Link>
            </span>
          ))}
          .
        </p>
      ) : (
        <p className="mb-3 rounded-xl border border-[#26282E] bg-[#1A1B20] px-3 py-2 text-[12px] text-[#8A8F98]">
          Nothing blocks an analysis on this host.{" "}
          <Link to="/new" className="text-[#BDC2FF] hover:underline">Describe a defect or a change →</Link>
        </p>
      )}

      <SectionLabel index="01">What DNAFix resolved here</SectionLabel>
      {loading ? (
        <Skeleton className="mt-2 h-56 rounded-xl" />
      ) : (
        <ul className="mt-2 divide-y divide-[#26282E]/60 overflow-hidden rounded-xl border border-[#26282E] bg-[#1A1B20]">
          {steps.map((step, index) => (
            <li key={step.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
              <span className="w-5 shrink-0 font-mono text-[10px] text-[#5E626E]">{String(index + 1).padStart(2, "0")}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-[#ECEEF0]">{step.title}</span>
                <span className="block text-[11px] leading-4 text-[#8A8F98]">{step.detail}</span>
              </span>
              <StatusPill tone={step.tone}>{step.label}</StatusPill>
              <Link to={step.href} className="shrink-0 font-mono text-[10px] text-[#BDC2FF] hover:underline">
                {step.cta}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-[#5E626E]">
        <Icon name="info" size={13} />
        Every value is read from the running API.
        <Link to="/settings" className="text-[#BDC2FF] hover:underline">Full configuration →</Link>
        <Link to="/docs" className="text-[#BDC2FF] hover:underline">Docs →</Link>
      </p>
    </div>
  );
}
