import { z } from "zod";

/** Validated execution manifest submitted with every cloud build. Generated only by DNAFix from approved verification commands. */
export const ExecutionCommandSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-_]{0,63}$/),
  kind: z.enum(["install", "build", "test", "typecheck", "lint", "format", "custom"]),
  argv: z.array(z.string().min(1).max(2000)).min(1).max(32),
});
export type ExecutionCommand = z.infer<typeof ExecutionCommandSchema>;

export const ExecutionManifestSchema = z.object({
  version: z.literal(1),
  runId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-_]{0,127}$/),
  baseCommitSha: z.string().regex(/^[0-9a-f]{7,64}$/i),
  createdAt: z.string().min(1),
  timeoutMinutes: z.number().int().min(1).max(20),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  commands: z.array(ExecutionCommandSchema).min(1).max(16),
});
export type ExecutionManifest = z.infer<typeof ExecutionManifestSchema>;

export function validateManifest(value: unknown): ExecutionManifest {
  return ExecutionManifestSchema.parse(value);
}

/** Deterministic idempotency token for a run + source bundle. Re-submitting the identical job is safe. */
export function idempotencyTokenFor(runId: string, sourceSha256: string): string {
  return `${runId}-${sourceSha256.slice(0, 32)}`.slice(0, 64);
}
