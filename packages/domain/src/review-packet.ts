/**
 * Blind-review packets (replication-v1.3). A packet is everything the
 * independent reviewer may see for one anonymized patch — and nothing else.
 * Completeness is validated before review: a packet without executed check
 * results or complete acceptance results must not be reviewed.
 */
export interface ReviewPacket {
  label: "A" | "B";
  diff: string;
  changedFiles: string[];
  repositoryContext: Array<{ path: string; content: string }>;
  executedChecks: Array<{ kind: string; status: string; exitCode: number | null }>;
  acceptance: Array<{ id: string; passed: boolean; evidence: string }>;
}

export class ReviewPacketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewPacketError";
  }
}

const FORBIDDEN_PATTERNS = [/run_[a-z0-9-]{6,}/i, /dnafix\//i, /\bbaseline\b/i, /\bdna-aware\b/i, /project[ -]?dna/i, /\bscripted\b/i];

export function assertPacketAnonymized(packet: ReviewPacket): void {
  const haystack = [packet.diff, ...packet.repositoryContext.map((f) => f.content), ...packet.changedFiles].join("\n");
  for (const pattern of FORBIDDEN_PATTERNS) {
    const match = haystack.match(pattern);
    if (match) throw new ReviewPacketError(`Review packet ${packet.label} contains identifying metadata matching ${pattern}: "${match[0]}"`);
  }
}

export function assertPacketComplete(packet: ReviewPacket, expectedAcceptanceIds: readonly string[]): void {
  if (packet.acceptance.length !== expectedAcceptanceIds.length) {
    throw new ReviewPacketError(
      `Review packet ${packet.label} is incomplete: ${packet.acceptance.length}/${expectedAcceptanceIds.length} acceptance results present. Review must not proceed on missing evidence.`,
    );
  }
  for (const id of expectedAcceptanceIds) {
    if (!packet.acceptance.some((a) => a.id === id)) {
      throw new ReviewPacketError(`Review packet ${packet.label} is missing acceptance result ${id}`);
    }
  }
  if (packet.executedChecks.length === 0) {
    throw new ReviewPacketError(`Review packet ${packet.label} contains no executed check results`);
  }
}

/** Deterministic execution order derived from a recorded seed (bit 0 = order, bit 1 = patch assignment). */
export function executionOrderFromSeed(seed: number): Array<"baseline" | "dna-aware"> {
  return seed % 2 === 0 ? ["dna-aware", "baseline"] : ["baseline", "dna-aware"];
}

export function patchAssignmentFromSeed(seed: number): { a: "baseline" | "dna-aware"; b: "baseline" | "dna-aware" } {
  return Math.floor(seed / 2) % 2 === 0 ? { a: "baseline", b: "dna-aware" } : { a: "dna-aware", b: "baseline" };
}
