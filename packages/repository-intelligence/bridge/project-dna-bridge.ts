/**
 * Project DNA bridge — runs OUT OF PROCESS against a Project DNA checkout.
 * Imports only Project DNA's public service surface (IProjectDNAService and its
 * composition, mirroring Project DNA's own apps/vscode-extension/src/container.ts).
 * DNAFix never reimplements Project DNA graph or impact logic. See ADR-0002.
 * Input:  stdin JSON { rootPath, baseCommitSha, targetPaths, changedPaths?, projectDnaPath }
 * Output: stdout JSON matching @dnafix/contracts RepositoryIntelligenceReportSchema
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function fail(message: string): never {
  process.stderr.write(`project-dna-bridge: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const input = JSON.parse(await readStdin()) as {
    rootPath: string;
    baseCommitSha: string;
    targetPaths?: string[];
    changedPaths?: string[];
    projectDnaPath: string;
  };
  const dnaRoot = input.projectDnaPath;
  const imp = async (pkg: string) => import(pathToFileURL(path.join(dnaRoot, "packages", pkg, "src", "index.ts")).href);

  const shared: any = await imp("shared");
  const core: any = await imp("dna-core");
  const scannerPkg: any = await imp("repository-scanner");
  const astPkg: any = await imp("ast-engine");
  const depPkg: any = await imp("dependency-engine");
  const archPkg: any = await imp("architecture-engine");
  const knowledgePkg: any = await imp("knowledge-engine");
  const dnaEnginePkg: any = await imp("dna-engine");
  const intelligencePkg: any = await imp("software-intelligence-engine");
  const evolutionPkg: any = await imp("evolution-engine");
  const impactPkg: any = await imp("impact-engine");

  const logger = shared.createSilentLogger ? shared.createSilentLogger() : shared.createLogger({ name: "dnafix-bridge" });
  const eventBus = new shared.EventBus();
  let storage: unknown;
  try {
    const storagePkg: any = await imp("storage");
    storage = new storagePkg.SqliteStorage(":memory:", logger, {});
  } catch {
    storage = undefined; // In-memory-only analysis; persistence-backed queries may be limited and will surface as errors below.
  }

  const orchestrator = new core.DNAOrchestrator({
    scanner: new scannerPkg.RepositoryScanner({ logger }),
    astEngine: new astPkg.AstEngine(logger),
    dependencyEngine: new depPkg.DependencyEngine(logger),
    architectureEngine: new archPkg.ArchitectureEngine(logger),
    knowledgeEngine: new knowledgePkg.KnowledgeEngine(logger),
    eventBus,
    logger,
  });
  const service: any = new core.ProjectDNAService({
    orchestrator,
    dnaEngine: new dnaEnginePkg.DNAEngine(logger),
    intelligenceEngine: new intelligencePkg.SoftwareIntelligenceEngine(logger),
    impactEngine: new impactPkg.ImpactEngine(),
    evolutionEngine: new evolutionPkg.EvolutionEngine(logger),
    eventBus,
    logger,
    storage,
    workingTreeProvider: new core.GitChangeSetProvider(),
  });

  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: input.rootPath, encoding: "utf8" }).trim();
  if (headSha.toLowerCase() !== input.baseCommitSha.toLowerCase()) {
    fail(`HEAD ${headSha} does not match requested base commit ${input.baseCommitSha}`);
  }

  const analyzed: any = await service.analyze(input.rootPath);
  if (!analyzed || analyzed.ok === false || analyzed.error) {
    fail(`Project DNA analyze() failed: ${JSON.stringify(analyzed?.error ?? analyzed).slice(0, 1000)}`);
  }
  const dna = analyzed.value ?? analyzed;
  const architecture = service.getArchitecture();
  const critical = service.getCriticalComponents() as any[];
  const risks = service.getRisks();
  const entitiesResult: any = await service.getEntities({ limit: 5000 }).catch((e: Error) => ({ error: e }));
  const entities: any[] = entitiesResult?.value ?? [];
  const files = [
    ...new Set(
      entities
        .map((e) => e?.path ?? e?.filePath ?? null)
        .filter((p): p is string => typeof p === "string")
        .map((p) => p.replaceAll("\\", "/")),
    ),
  ].sort();

  const targets = [];
  let complete = true;
  const warnings: string[] = [];
  for (const targetPath of input.targetPaths ?? []) {
    const result: any = await service.getImpact({ kind: "file", path: targetPath });
    if (!result || result.ok === false || result.error) {
      warnings.push(`getImpact failed for ${targetPath}: ${JSON.stringify(result?.error ?? result).slice(0, 300)}`);
      continue;
    }
    const v = result.value ?? result;
    if (!v.complete) complete = false;
    warnings.push(...(v.warnings ?? []));
    targets.push({
      targetPath,
      directImpacted: (v.directImpactedEntities ?? []).map((n: any) => n.path ?? n.id),
      transitiveImpacted: (v.transitiveImpactedEntities ?? []).map((n: any) => n.path ?? n.id),
      evidenceReasons: [...new Set((v.evidence ?? []).map((e: any) => String(e.reason)))],
      truncations: (v.truncations ?? []).map((t: any) => `${t.kind}:${t.limit}`),
    });
  }

  let workingTree = null;
  if ((input.changedPaths ?? []).length > 0) {
    const wt: any = await service.getWorkingTreeImpact({});
    if (wt && wt.ok !== false && !wt.error) {
      const v = wt.value ?? wt;
      workingTree = {
        changedPaths: (v.changedPaths ?? []).map((c: any) => c.path),
        impactedEntityIds: v.impactedEntityIds ?? [],
        unresolvedPaths: (v.unresolvedPaths ?? []).map((u: any) => `${u.path}:${u.reason}`),
        complete: Boolean(v.complete),
        warnings: v.warnings ?? [],
      };
      if (!v.complete) complete = false;
      warnings.push(...(v.warnings ?? []));
    } else {
      warnings.push(`getWorkingTreeImpact failed: ${JSON.stringify(wt?.error ?? wt).slice(0, 300)}`);
    }
  }

  const report = {
    repositoryId: String(dna.id ?? "unknown"),
    baseCommitSha: headSha,
    analysisVersion: typeof dna.version === "number" ? dna.version : null,
    analyzedAt: new Date(typeof dna.analyzedAt === "number" ? dna.analyzedAt : Date.now()).toISOString(),
    architecture: {
      layers: (architecture?.layers ?? []).map((l: any) => String(l.name)),
      patterns: (architecture?.detectedPatterns ?? []).map((p: any) => `${p.pattern}:${p.confidence}`),
      summary: `pattern=${architecture?.pattern ?? "unknown"} confidence=${architecture?.confidence ?? "n/a"}`,
    },
    criticalComponents: (critical ?? []).slice(0, 50).map((c: any) => ({
      name: String(c.name ?? c.entityId ?? "unknown"),
      path: c.path ?? null,
      reason: String(c.reason ?? c.criticality ?? ""),
    })),
    risks: (risks?.topRisks ?? []).slice(0, 50).map((r: any) => ({
      title: String(r.description ?? r.type ?? "risk"),
      severity: String(r.severity ?? "unknown"),
      path: null,
    })),
    languages: (dna.profile?.primaryLanguages ?? []).map((l: any) => String(l.language)),
    files,
    targets,
    workingTree,
    complete,
    warnings,
  };
  process.stdout.write(JSON.stringify(report));
  await service.dispose?.().catch(() => undefined);
}

main().catch((err: Error) => fail(err.stack ?? err.message));
