import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link, Route, Routes, useNavigate, useParams } from "react-router-dom";

const API = "/api/v1";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { "Content-Type": "application/json" }, ...init });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface Run {
  id: string;
  repositoryId: string;
  issueTitle: string;
  state: string;
  modelProvider: string;
  baseCommitSha: string | null;
  changedPaths: string[];
  diff: string;
  pullRequestUrl: string | null;
  error: string | null;
  repairAttempts: number;
  createdAt: string;
  analysis: { summary: string; requirements: string[]; acceptanceCriteria: string[]; ambiguities: string[]; riskLevel: string } | null;
  plan: {
    tasks: Array<{ id: string; title: string; fileScope: string[]; dependsOn: string[]; acceptanceCriteria: string[] }>;
    predictedAffectedPaths: Array<{ path: string; source: string; reason: string }>;
    unresolvedQuestions: string[];
    requiresHumanClarification: boolean;
  } | null;
  intelligence: {
    architecture: { summary: string; layers: string[] };
    criticalComponents: Array<{ name: string; path: string | null }>;
    risks: Array<{ title: string; severity: string }>;
    complete: boolean;
    warnings: string[];
    targets: Array<{ targetPath: string; directImpacted: string[]; transitiveImpacted: string[]; truncations: string[] }>;
  } | null;
  tasks: Array<{ taskId: string; status: string; changedPaths: string[]; commitSha: string | null; patchSummary: string | null; error: string | null }>;
  verificationChecks: Array<{ kind: string; status: string; result: { argv: string[]; exitCode: number | null } | null }> | null;
  baselineChecks: Array<{ kind: string; status: string }>;
  verifierReview: { verdict: string; summary: string; unintendedChanges: string[]; missingTests: string[] } | null;
}

interface ConfigStatus {
  model: { provider: string; modelId: string; configured: boolean };
  projectDna: { configured: boolean };
  github: { configured: boolean };
  sandboxMode: string;
  workflowEngine: string;
}

function StatusBanner() {
  const { data } = useQuery({ queryKey: ["status"], queryFn: () => api<ConfigStatus>("/config/status") });
  if (!data) return null;
  const warn = (ok: boolean, label: string) => (
    <span className={`rounded px-2 py-0.5 text-xs ${ok ? "bg-emerald-900 text-emerald-200" : "bg-amber-900 text-amber-200"}`}>{label}</span>
  );
  return (
    <div className="flex flex-wrap gap-2" role="status" aria-label="Integration status">
      {warn(data.model.configured, data.model.configured ? `${data.model.modelId} configured` : "Muse Wonder: no MODEL_API_KEY (untested)")}
      {warn(data.projectDna.configured, data.projectDna.configured ? "Project DNA configured" : "Project DNA: PROJECT_DNA_PATH not set")}
      {warn(data.github.configured, data.github.configured ? "GitHub App configured" : "GitHub App not configured")}
      {warn(data.sandboxMode === "docker", `Sandbox: ${data.sandboxMode}`)}
      <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-200">Workflow: {data.workflowEngine}</span>
    </div>
  );
}

function Dashboard() {
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs") });
  const repos = useQuery({ queryKey: ["repos"], queryFn: () => api<Array<{ id: string; localPath: string | null; githubOwner: string | null; githubRepo: string | null }>>("/repositories") });
  return (
    <section aria-labelledby="runs-heading">
      <div className="mb-4 flex items-center justify-between">
        <h2 id="runs-heading" className="text-xl font-semibold">Issue-to-PR runs</h2>
        <Link className="rounded bg-indigo-600 px-3 py-2 text-sm text-white" to="/new">New run</Link>
      </div>
      {runs.isLoading && <p>Loading runs…</p>}
      {runs.isError && <p className="text-red-400">Failed to load runs: {(runs.error as Error).message}</p>}
      {runs.data?.length === 0 && <p className="text-slate-400">No runs yet. Create one from a local repository path or a GitHub repository.</p>}
      <ul className="space-y-2">
        {runs.data?.map((r) => (
          <li key={r.id} className="rounded border border-slate-700 bg-slate-900 p-3">
            <Link className="font-medium text-indigo-300" to={`/runs/${r.id}`}>{r.issueTitle}</Link>
            <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-400">
              <span>State: <strong className="text-slate-200">{r.state}</strong></span>
              <span>Model: {r.modelProvider}</span>
              <span>Base: {r.baseCommitSha?.slice(0, 10) ?? "—"}</span>
              <span>Started: {new Date(r.createdAt).toLocaleString()}</span>
              {r.pullRequestUrl && <a className="text-emerald-300" href={r.pullRequestUrl}>Draft PR</a>}
            </div>
            {r.error && <p className="mt-1 text-xs text-red-400">{r.error}</p>}
          </li>
        ))}
      </ul>
      <h3 className="mb-2 mt-6 text-lg font-semibold">Connected repositories</h3>
      {repos.data?.length === 0 && <p className="text-slate-400">None yet.</p>}
      <ul className="space-y-1 text-sm text-slate-300">
        {repos.data?.map((r) => (
          <li key={r.id} className="rounded border border-slate-800 bg-slate-900 px-3 py-2">{r.githubOwner ? `${r.githubOwner}/${r.githubRepo}` : r.localPath} <span className="text-slate-500">({r.id})</span></li>
        ))}
      </ul>
    </section>
  );
}

function NewRun() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(null);
    try {
      const run = await api<Run>("/runs", {
        method: "POST",
        body: JSON.stringify({
          repositoryPath: (fd.get("repositoryPath") as string) || undefined,
          githubOwner: (fd.get("githubOwner") as string) || undefined,
          githubRepo: (fd.get("githubRepo") as string) || undefined,
          issueTitle: fd.get("issueTitle"),
          issueBody: fd.get("issueBody"),
          issueNumber: fd.get("issueNumber") ? Number(fd.get("issueNumber")) : undefined,
        }),
      });
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <section aria-labelledby="new-heading" className="max-w-2xl">
      <h2 id="new-heading" className="mb-4 text-xl font-semibold">Submit an issue</h2>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-sm">Local repository path<input name="repositoryPath" className="mt-1 w-full rounded bg-slate-900 p-2" placeholder="G:\path\to\repo" /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">GitHub owner<input name="githubOwner" className="mt-1 w-full rounded bg-slate-900 p-2" /></label>
          <label className="block text-sm">GitHub repo<input name="githubRepo" className="mt-1 w-full rounded bg-slate-900 p-2" /></label>
        </div>
        <label className="block text-sm">Issue number (optional)<input name="issueNumber" type="number" className="mt-1 w-full rounded bg-slate-900 p-2" /></label>
        <label className="block text-sm">Issue title<input required name="issueTitle" className="mt-1 w-full rounded bg-slate-900 p-2" /></label>
        <label className="block text-sm">Issue description<textarea required name="issueBody" rows={8} className="mt-1 w-full rounded bg-slate-900 p-2" /></label>
        {error && <p className="text-red-400" role="alert">{error}</p>}
        <button className="rounded bg-indigo-600 px-4 py-2 text-white" type="submit">Start analysis run</button>
      </form>
    </section>
  );
}

function RunDetail() {
  const { id } = useParams();
  const run = useQuery({ queryKey: ["run", id], queryFn: () => api<Run>(`/runs/${id}`) });
  const audit = useQuery({ queryKey: ["audit", id], queryFn: () => api<Array<{ id: string; actor: string; action: string; result: string; evidence: string | null; createdAt: string }>>(`/audit?runId=${id}`) });
  const [clarification, setClarification] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const source = new EventSource(`${API}/runs/${id}/events`);
    source.addEventListener("state", () => void run.refetch());
    return () => source.close();
  }, [id]);

  async function act(path: string, body?: unknown) {
    setActionError(null);
    try {
      await api(`/runs/${id}${path}`, { method: "POST", body: body ? JSON.stringify(body) : undefined });
      await run.refetch();
    } catch (err) {
      setActionError((err as Error).message);
    }
  }

  if (run.isLoading) return <p>Loading run…</p>;
  if (run.isError) return <p className="text-red-400">Failed: {(run.error as Error).message}</p>;
  const r = run.data!;
  return (
    <section aria-labelledby="run-heading" className="space-y-6">
      <div>
        <h2 id="run-heading" className="text-xl font-semibold">{r.issueTitle}</h2>
        <p className="text-sm text-slate-400">State: <strong className="text-slate-100">{r.state}</strong> · Model provider: {r.modelProvider} · Base commit: {r.baseCommitSha ?? "—"} · Repair attempts: {r.repairAttempts}</p>
        {r.error && <p className="mt-2 rounded bg-red-950 p-2 text-sm text-red-200" role="alert">{r.error}</p>}
        {actionError && <p className="mt-2 rounded bg-red-950 p-2 text-sm text-red-200" role="alert">{actionError}</p>}
        <div className="mt-2 flex gap-2">
          {!["COMPLETED", "FAILED", "CANCELLED"].includes(r.state) && <button onClick={() => act("/cancel")} className="rounded bg-slate-700 px-3 py-1.5 text-sm">Cancel run</button>}
        </div>
      </div>

      {r.state === "NEEDS_CLARIFICATION" && (
        <div className="rounded border border-amber-700 bg-amber-950 p-3">
          <h3 className="font-semibold">Clarification needed</h3>
          <ul className="list-disc pl-5 text-sm">{r.plan?.unresolvedQuestions.map((q) => <li key={q}>{q}</li>)}</ul>
          <label className="mt-2 block text-sm">Your answer<textarea value={clarification} onChange={(e) => setClarification(e.target.value)} rows={3} className="mt-1 w-full rounded bg-slate-900 p-2" /></label>
          <button onClick={() => act("/clarification", { answer: clarification })} className="mt-2 rounded bg-amber-600 px-3 py-1.5 text-sm text-white">Submit clarification</button>
        </div>
      )}

      {r.intelligence && (
        <div className="rounded border border-slate-700 bg-slate-900 p-3">
          <h3 className="mb-2 font-semibold">Project DNA evidence</h3>
          <p className="text-sm text-slate-300">{r.intelligence.architecture.summary} · Layers: {r.intelligence.architecture.layers.join(", ") || "—"}</p>
          <p className="text-sm">Analysis complete: <strong>{String(r.intelligence.complete)}</strong>{r.intelligence.warnings.length > 0 && <> · Warnings: {r.intelligence.warnings.join("; ")}</>}</p>
          {r.intelligence.targets.map((t) => (
            <div key={t.targetPath} className="mt-2 text-sm">
              <code>{t.targetPath}</code> — direct: {t.directImpacted.join(", ") || "none"}; transitive: {t.transitiveImpacted.join(", ") || "none"}
              {t.truncations.length > 0 && <span className="text-amber-300"> (truncated: {t.truncations.join(", ")})</span>}
            </div>
          ))}
          {r.intelligence.criticalComponents.length > 0 && <p className="mt-2 text-sm text-slate-400">Critical: {r.intelligence.criticalComponents.map((c) => c.name).join(", ")}</p>}
        </div>
      )}

      {r.analysis && (
        <div className="rounded border border-slate-700 bg-slate-900 p-3">
          <h3 className="mb-2 font-semibold">Issue analysis</h3>
          <p className="text-sm">{r.analysis.summary} (risk: {r.analysis.riskLevel})</p>
          <h4 className="mt-2 text-sm font-medium">Acceptance criteria</h4>
          <ul className="list-disc pl-5 text-sm">{r.analysis.acceptanceCriteria.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      )}

      {r.plan && (
        <div className="rounded border border-slate-700 bg-slate-900 p-3">
          <h3 className="mb-2 font-semibold">Implementation plan</h3>
          <ul className="space-y-2">
            {r.plan.tasks.map((t) => (
              <li key={t.id} className="rounded bg-slate-800 p-2 text-sm">
                <strong>{t.id}: {t.title}</strong> · scope: {t.fileScope.join(", ")}{t.dependsOn.length > 0 && <> · depends on: {t.dependsOn.join(", ")}</>}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm text-slate-400">Predicted affected: {r.plan.predictedAffectedPaths.map((p) => `${p.path} (${p.source})`).join(", ") || "—"}</p>
          {r.state === "AWAITING_PLAN_APPROVAL" && <button onClick={() => act("/approve-plan")} className="mt-3 rounded bg-emerald-600 px-3 py-1.5 text-sm text-white">Approve plan and execute</button>}
        </div>
      )}

      {r.tasks.length > 0 && (
        <div className="rounded border border-slate-700 bg-slate-900 p-3">
          <h3 className="mb-2 font-semibold">Agent execution</h3>
          <ul className="space-y-1 text-sm">
            {r.tasks.map((t) => <li key={t.taskId}><strong>{t.taskId}</strong>: {t.status} — {t.patchSummary ?? t.error ?? ""} {t.commitSha && <span className="text-slate-400">commit {t.commitSha.slice(0, 10)}</span>}</li>)}
          </ul>
        </div>
      )}

      {(r.verificationChecks || r.diff) && (
        <div className="rounded border border-slate-700 bg-slate-900 p-3">
          <h3 className="mb-2 font-semibold">Verification</h3>
          <p className="text-sm text-slate-400">Baseline: {r.baselineChecks.map((c) => `${c.kind}:${c.status}`).join(", ") || "—"}</p>
          <ul className="text-sm">
            {r.verificationChecks?.map((c) => <li key={c.kind}>{c.kind}: <strong>{c.status}</strong>{c.result && <> — <code>{c.result.argv.join(" ")}</code> exit {c.result.exitCode}</>}</li>)}
          </ul>
          {r.verifierReview && <p className="mt-2 text-sm">Verifier: <strong>{r.verifierReview.verdict}</strong> — {r.verifierReview.summary}</p>}
          <h4 className="mt-3 text-sm font-medium">Changed files</h4>
          <p className="text-sm">{r.changedPaths.join(", ") || "none"}</p>
          {r.diff && <pre className="mt-2 max-h-96 overflow-auto rounded bg-black p-2 text-xs" aria-label="Diff">{r.diff}</pre>}
          {r.state === "AWAITING_PR_APPROVAL" && <button onClick={() => act("/approve-pr")} className="mt-3 rounded bg-emerald-600 px-3 py-1.5 text-sm text-white">Approve and create draft PR{r.pullRequestUrl ? "" : ""}</button>}
          {r.pullRequestUrl && <p className="mt-2 text-sm">Draft PR: <a className="text-emerald-300" href={r.pullRequestUrl}>{r.pullRequestUrl}</a></p>}
        </div>
      )}

      <div className="rounded border border-slate-700 bg-slate-900 p-3">
        <h3 className="mb-2 font-semibold">Audit history</h3>
        <ul className="space-y-1 text-xs text-slate-300">
          {audit.data?.map((e) => <li key={e.id}>{new Date(e.createdAt).toLocaleTimeString()} · {e.actor} · {e.action} · {e.result}{e.evidence ? ` · ${e.evidence}` : ""}</li>)}
          {audit.data?.length === 0 && <li>No events yet.</li>}
        </ul>
      </div>
    </section>
  );
}

export function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 p-4">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold"><Link to="/">DNAFix</Link></h1>
            <p className="text-xs text-slate-400">Understand the software before changing the software.</p>
          </div>
          <StatusBanner />
        </div>
      </header>
      <main className="mx-auto max-w-6xl p-4">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/new" element={<NewRun />} />
          <Route path="/runs/:id" element={<RunDetail />} />
        </Routes>
      </main>
    </div>
  );
}
