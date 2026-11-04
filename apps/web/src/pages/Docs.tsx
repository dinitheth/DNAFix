import { Icon } from "../components/Icon";

const REPO = "https://github.com/dinitheth/DNAFix/blob/main/docs";

const DOCS = [
  { title: "System Guide", file: "SYSTEM_GUIDE.md", desc: "End-to-end workflow, pages, connectors, safety invariants" },
  { title: "Architecture", file: "ARCHITECTURE.md", desc: "Modules, lifecycle, evidence rules" },
  { title: "Security", file: "SECURITY.md", desc: "Trust boundaries and controls" },
  { title: "Model Integration", file: "MODEL_INTEGRATION.md", desc: "Muse Wonder endpoint, transport, tool calling" },
  { title: "Project DNA Integration", file: "INTEGRATION_PROJECT_DNA.md", desc: "Deterministic repository intelligence bridge" },
  { title: "GitHub App Setup", file: "GITHUB_APP_SETUP.md", desc: "App registration, env, token lifecycle" },
  { title: "MCP Connectors", file: "MCP_CONNECTORS.md", desc: "Docker MCP setup, permissions, approvals, API" },
  { title: "AWS Execution", file: "AWS_EXECUTION.md", desc: "Optional CodeBuild remote execution" },
  { title: "Implementation Status", file: "IMPLEMENTATION_STATUS.md", desc: "Verified, blocked, and untested areas" },
  { title: "Build Plan", file: "BUILD_PLAN.md", desc: "Discovery findings and staged plan" },
];

export function Docs() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <h1 className="text-[20px] font-semibold text-white">Docs</h1>
      <div className="mt-4 grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-2">
        {DOCS.map((doc) => (
          <a key={doc.file} href={`${REPO}/${doc.file}`} target="_blank" rel="noreferrer" className="group flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#282A31] text-[#BDC2FF]"><Icon name="menu_book" size={18} /></span>
            <span className="min-w-0">
              <span className="block text-[15px] font-semibold text-white group-hover:underline">{doc.title}</span>
              <span className="block truncate text-[13px] text-[#8A8F98]">{doc.desc}</span>
            </span>
            <Icon name="open_in_new" size={14} className="ml-auto mt-1 shrink-0 text-[#5E626E]" />
          </a>
        ))}
      </div>
      <a href="https://github.com/dinitheth/DNAFix/tree/main/docs/adr" target="_blank" rel="noreferrer" className="mt-6 flex items-center gap-2 text-[13px] text-[#BDC2FF] hover:underline">
        Architecture Decision Records (ADR 0001–0005) <Icon name="open_in_new" size={13} />
      </a>
    </div>
  );
}
