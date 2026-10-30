import type { PatchGenerationOutput, PlanGenerationOutput, VerifierReview } from "@dnafix/contracts";
import type { MetaModelProvider, ModelProvider, PatchInput, PlanInput, ReviewInput } from "./index.js";

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export interface BudgetLimits {
  maxCalls: number;
  maxTotalTokens: number;
  maxCostUsd: number;
  maxOutputTokensPerRequest: number;
  pricing: { inputPerMillion: number; outputPerMillion: number };
}

export interface CallUsage {
  method: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

const MIN_USEFUL_OUTPUT_TOKENS = 256;

/**
 * Budget-enforcing provider wrapper.
 * Before every request it: estimates input tokens (chars/3, conservative),
 * computes the dynamically allowed output-token limit from the *remaining*
 * monetary and token budgets, refuses the request if that limit is not
 * useful, and sends the request with that dynamic cap. After every response
 * (including incomplete ones — usage is read from the provider even when it
 * throws) it records actual usage and enforces the ceilings again.
 */
export class BudgetedModelProvider implements ModelProvider {
  readonly name: string;
  readonly modelId: string;
  readonly calls: CallUsage[] = [];
  budgetExceeded = false;

  constructor(
    private readonly inner: MetaModelProvider,
    private readonly limits: BudgetLimits,
  ) {
    this.name = inner.name;
    this.modelId = inner.modelId;
  }

  spent(): { calls: number; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number } {
    const sum = (key: "inputTokens" | "outputTokens" | "totalTokens") => this.calls.reduce((s, c) => s + (c[key] ?? 0), 0);
    const inputTokens = sum("inputTokens");
    const outputTokens = sum("outputTokens");
    return {
      calls: this.calls.length,
      inputTokens,
      outputTokens,
      totalTokens: sum("totalTokens"),
      costUsd: (inputTokens / 1_000_000) * this.limits.pricing.inputPerMillion + (outputTokens / 1_000_000) * this.limits.pricing.outputPerMillion,
    };
  }

  estimatedCostUsd(): number {
    return Math.round(this.spent().costUsd * 10_000) / 10_000;
  }

  totals(): { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } {
    if (this.calls.length === 0) return { inputTokens: null, outputTokens: null, totalTokens: null };
    const s = this.spent();
    return { inputTokens: s.inputTokens, outputTokens: s.outputTokens, totalTokens: s.totalTokens };
  }

  /** Dynamically allowed output tokens for the next request, or throws BudgetExceededError before any request is sent. */
  private dynamicOutputCap(method: string, inputPayload: unknown): number {
    const spent = this.spent();
    const estimatedInputTokens = Math.ceil(JSON.stringify(inputPayload ?? "").length / 3);
    const estimatedInputCost = (estimatedInputTokens / 1_000_000) * this.limits.pricing.inputPerMillion;
    const remainingCost = this.limits.maxCostUsd - spent.costUsd - estimatedInputCost;
    const byCost = Math.floor((remainingCost / this.limits.pricing.outputPerMillion) * 1_000_000);
    const byTokens = this.limits.maxTotalTokens - spent.totalTokens - estimatedInputTokens;
    const cap = Math.min(this.limits.maxOutputTokensPerRequest, byCost, byTokens);
    if (spent.calls + 1 > this.limits.maxCalls || cap < MIN_USEFUL_OUTPUT_TOKENS) {
      this.budgetExceeded = true;
      throw new BudgetExceededError(
        `Budget refused ${method} before request: spent ${spent.totalTokens} tokens / $${spent.costUsd.toFixed(4)} in ${spent.calls} calls; dynamic output cap would be ${cap} tokens (caps: ${this.limits.maxCalls} calls, ${this.limits.maxTotalTokens} tokens, $${this.limits.maxCostUsd}, ${this.limits.maxOutputTokensPerRequest}/request)`,
      );
    }
    return cap;
  }

  private record(method: string, provider: MetaModelProvider): void {
    const u = provider.lastUsage;
    this.calls.push({ method, inputTokens: u?.inputTokens ?? null, outputTokens: u?.outputTokens ?? null, totalTokens: u?.totalTokens ?? null });
    const spent = this.spent();
    if (spent.calls > this.limits.maxCalls || spent.totalTokens > this.limits.maxTotalTokens || spent.costUsd > this.limits.maxCostUsd) {
      this.budgetExceeded = true;
      throw new BudgetExceededError(
        `Budget exceeded after ${method}: ${spent.totalTokens} tokens, $${spent.costUsd.toFixed(4)} (caps: ${this.limits.maxTotalTokens} tokens, $${this.limits.maxCostUsd})`,
      );
    }
  }

  private async call<T>(method: string, input: unknown, invoke: (provider: MetaModelProvider) => Promise<T>): Promise<T> {
    const cap = this.dynamicOutputCap(method, input);
    const provider = this.inner.withMaxOutputTokens(cap);
    let out: T;
    try {
      out = await invoke(provider);
    } catch (err) {
      // Usage from incomplete/failed responses is still real spend: record it once.
      if (provider.lastUsage) {
        try {
          this.record(method, provider);
        } catch {
          this.budgetExceeded = true;
        }
      }
      throw err;
    }
    this.record(method, provider);
    return out;
  }

  analyzeAndPlan(input: PlanInput): Promise<PlanGenerationOutput> {
    return this.call("analyzeAndPlan", input, (p) => p.analyzeAndPlan(input));
  }
  generatePatch(input: PatchInput): Promise<PatchGenerationOutput> {
    return this.call("generatePatch", input, (p) => p.generatePatch(input));
  }
  reviewVerification(input: ReviewInput): Promise<VerifierReview> {
    return this.call("reviewVerification", input, (p) => p.reviewVerification(input));
  }
}
