import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Button, StatusPill } from "../components/ui";
import { api, type GitHubStatus } from "../lib/api";

export function ConnectorGithub() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const github = useQuery({ queryKey: ["github-status"], queryFn: () => api<GitHubStatus>("/integrations/github/status"), retry: false });
  const data = github.data;

  async function connect() {
    setBusy(true); setError(null);
    try {
      const res = await api<{ authorizeUrl: string }>("/integrations/github/connect", { method: "POST", body: JSON.stringify({ returnTo: "/connectors/github" }) });
      window.location.assign(res.authorizeUrl);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); setBusy(false); }
  }
  async function disconnect() {
    setBusy(true); setError(null);
    try {
      await api("/integrations/github/disconnect", { method: "POST" });
      await queryClient.invalidateQueries({ queryKey: ["github-status"] });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <Link to="/connectors" className="flex items-center gap-1 text-[12px] text-[#8A8F98] hover:text-white"><Icon name="arrow_back" size={14} /> Connectors</Link>
      <header className="mt-3 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#24292f] text-white"><Icon name="code" size={22} /></span>
        <div>
          <h1 className="text-[18px] font-semibold text-white">Github</h1>
          <p className="font-mono text-[11px] text-[#8A8F98]">{data?.connected ? `connected as ${data.account?.login ?? ""}` : data?.configured ? "not connected" : "not configured"}</p>
        </div>
        <span className="ml-auto"><StatusPill tone={data?.connected ? "success" : data?.configured ? "warning" : "neutral"}>{data?.connected ? "Connected" : data?.configured ? "Not connected" : "Not configured"}</StatusPill></span>
      </header>

      {error && <div role="alert" className="mt-3 rounded-lg border border-[#E5484D]/30 bg-[#E5484D]/10 px-3 py-2 text-[12px] text-[#E5484D]">{error}</div>}

      <section className="mt-4 rounded-xl border border-[#26282E] bg-[#1A1B20] p-3">
        <dl className="divide-y divide-[#26282E]/60 text-[12px]">
          <Row label="Account" value={data?.account ? `${data.account.login}${data.account.name ? ` (${data.account.name})` : ""}` : "—"} />
          <Row label="Installation" value={data?.installation ? `${data.installation.accountLogin} · #${data.installation.id}` : "—"} mono />
          <Row label="Token expires" value={data?.tokenExpiresAt ? new Date(data.tokenExpiresAt).toLocaleString() : "—"} mono />
          <Row label="App slug" value={data?.appSlug ?? "—"} mono />
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          {!data?.connected && <Button variant="primary" loading={busy} disabled={!data?.configured} onClick={() => void connect()}>Connect Github</Button>}
          {data?.connected && <Button variant="danger-ghost" loading={busy} onClick={() => void disconnect()}>Disconnect</Button>}
          {data?.appSlug && <a className="inline-flex h-8 items-center rounded-md border border-[#2E3038] bg-[#222329] px-3 text-[13px] text-white hover:border-[#424652]" href={`https://github.com/apps/${data.appSlug}/installations/new`} target="_blank" rel="noreferrer">Install App</a>}
          <Link to="/new" className="inline-flex h-8 items-center rounded-md border border-[#2E3038] bg-[#222329] px-3 text-[13px] text-white hover:border-[#424652]">Browse repositories</Link>
          <Button variant="secondary" loading={github.isFetching} onClick={() => void github.refetch()}>Refresh</Button>
        </div>
        {!data?.configured && data && data.missing.length > 0 && <p className="mt-2 font-mono text-[11px] text-[#E5A158]">Missing: {data.missing.join(", ")}</p>}
      </section>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <dt className="text-[#8A8F98]">{label}</dt>
      <dd className={`truncate text-right text-white ${mono ? "font-mono text-[11px]" : ""}`}>{value}</dd>
    </div>
  );
}
