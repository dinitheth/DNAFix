import type { PatchGenerationOutput, PlanGenerationOutput, VerifierReview } from "@dnafix/contracts";
import type { ModelProvider, PatchInput, PlanInput, ReviewInput, ToolLoopOptions, ToolLoopResult } from "./index.js";

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface BudgetLimits {
  maxCalls: number;
  maxTotalTokens: number;
  maxCostUsd: number;
  maxOutputTokensPerRequest: number;
  pricing: ModelPricing;
}

export interface CallUsage {
  method: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** Charged at the price of the role that made the call, not at the ledger default. */
  costUsd: number;
}

export interface UsageReading {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

const MIN_USEFUL_OUTPUT_TOKENS = 256;

/** Defaults mirror the frozen evaluation budget (docs/evaluation/EXPERIMENT_DESIGN.md); every field is overridable per host. */
export function modelBudgetLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): BudgetLimits {
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    maxCalls: Math.trunc(num("DNAFIX_MODEL_MAX_CALLS", 12)),
    maxTotalTokens: Math.trunc(num("DNAFIX_MODEL_MAX_TOTAL_TOKENS", 250_000)),
    maxCostUsd: num("DNAFIX_MODEL_MAX_COST_USD", 3),
    maxOutputTokensPerRequest: Math.trunc(num("DNAFIX_MODEL_MAX_OUTPUT_TOKENS_PER_REQUEST", 16_384)),
    pricing: {
      inputPerMillion: num("DNAFIX_MODEL_INPUT_COST_PER_MILLION", 4),
      outputPerMillion: num("DNAFIX_MODEL_OUTPUT_COST_PER_MILLION", 20),
    },
  };
}

/**
 * One monetary ceiling. The lead planner and the coding/verification sub-agents share a
 * ledger so a run cannot spend more by splitting its work across two models, while each
 * role is charged at its own price.
 */
export class ModelBudget {
  readonly calls: CallUsage[] = [];
  budgetExceeded = false;

  constructor(private readonly limits: BudgetLimits) {}

  get ceilings(): BudgetLimits {
    return this.limits;
  }

  spent(): { calls: number; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number } {
    const sum = (key: "inputTokens" | "outputTokens" | "totalTokens") => this.calls.reduce((s, c) => s + (c[key] ?? 0), 0);
    return {
      calls: this.calls.length,
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      totalTokens: sum("totalTokens"),
      costUsd: this.calls.reduce((s, c) => s + c.costUsd, 0),
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

  costOf(usage: UsageReading | null, pricing: ModelPricing): number {
    return ((usage?.inputTokens ?? 0) / 1_000_000) * pricing.inputPerMillion + ((usage?.outputTokens ?? 0) / 1_000_000) * pricing.outputPerMillion;
  }

  /** Dynamically allowed output tokens for the next request, or throws before any request is sent. */
  reserve(method: string, inputPayload: unknown, pricing?: ModelPricing): number {
    const price = pricing ?? this.limits.pricing;
    const spent = this.spent();
    const estimatedInputTokens = Math.ceil(JSON.stringify(inputPayload ?? "").length / 3);
    const remainingCost = this.limits.maxCostUsd - spent.costUsd - this.costOf({ inputTokens: estimatedInputTokens }, price);
    const byCost = Math.floor((remainingCost / price.outputPerMillion) * 1_000_000);
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

  commit(method: string, usage: UsageReading | null, pricing?: ModelPricing): void {
    const price = pricing ?? this.limits.pricing;
    this.calls.push({
      method,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
      costUsd: this.costOf(usage, price),
    });
    const spent = this.spent();
    if (spent.calls > this.limits.maxCalls || spent.totalTokens > this.limits.maxTotalTokens || spent.costUsd > this.limits.maxCostUsd) {
      this.budgetExceeded = true;
      throw new BudgetExceededError(
        `Budget exceeded after ${method}: ${spent.totalTokens} tokens, $${spent.costUsd.toFixed(4)} (caps: ${this.limits.maxTotalTokens} tokens, $${this.limits.maxCostUsd})`,
      );
    }
  }
}

/** Providers that report real usage and accept a per-request output cap — i.e. anything that can actually cost money. */
export interface MeterableModel extends ModelProvider {
  lastUsage: UsageReading | null;
  withMaxOutputTokens(maxOutputTokens: number): MeterableModel;
  runToolLoop?(options: ToolLoopOptions): Promise<ToolLoopResult>;
}

export function isMeterableModel(model: ModelProvider): model is MeterableModel {
  const candidate = model as Partial<MeterableModel>;
  return typeof candidate.withMaxOutputTokens === "function" && candidate.lastUsage !== undefined;
}

/** Scripted and fake providers stay untouched; only providers that can incur spend are metered. */
export function meterModel(model: ModelProvider, budget: ModelBudget, pricing?: ModelPricing): ModelProvider {
  return isMeterableModel(model) ? new BudgetedModelProvider(model, budget, pricing) : model;
}

/**
 * Budget-enforcing provider wrapper.
 * Before every request it reserves budget: estimates input tokens (chars/3, conservative),
 * computes the dynamically allowed output-token limit from the *remaining* monetary and
 * token budgets, and refuses the request if that limit is not useful. After every response
 * (including incomplete ones — usage is read from the provider even when it throws) it
 * records actual usage and enforces the ceilings again.
 */
export class BudgetedModelProvider implements ModelProvider {
  readonly name: string;
  readonly modelId: string;

  constructor(
    private readonly inner: MeterableModel,
    private readonly budget: ModelBudget,
    private readonly pricing?: ModelPricing,
  ) {
    this.name = inner.name;
    this.modelId = inner.modelId;
  }

  get calls(): CallUsage[] {
    return this.budget.calls;
  }

  get budgetExceeded(): boolean {
    return this.budget.budgetExceeded;
  }

  spent(): ReturnType<ModelBudget["spent"]> {
    return this.budget.spent();
  }

  estimatedCostUsd(): number {
    return this.budget.estimatedCostUsd();
  }

  totals(): ReturnType<ModelBudget["totals"]> {
    return this.budget.totals();
  }

  private async call<T>(method: string, input: unknown, invoke: (provider: MeterableModel) => Promise<T>, readUsage?: (result: T) => UsageReading | null): Promise<T> {
    const cap = this.budget.reserve(method, input, this.pricing);
    const provider = this.inner.withMaxOutputTokens(cap);
    let out: T;
    try {
      out = await invoke(provider);
    } catch (err) {
      // Usage from incomplete/failed responses is still real spend: record it once.
      if (provider.lastUsage) {
        try {
          this.budget.commit(method, provider.lastUsage, this.pricing);
        } catch {
          this.budget.budgetExceeded = true;
        }
      }
      throw err;
    }
    this.budget.commit(method, readUsage ? readUsage(out) : provider.lastUsage, this.pricing);
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

  /** The MCP tool loop is billable spend too, so it passes through the same ledger. */
  runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
    const loop = this.inner.runToolLoop;
    if (!loop) return Promise.reject(new Error(`${this.inner.name} does not implement the tool loop.`));
    return this.call("runToolLoop", { instructions: options.instructions, input: options.input }, (p) => p.runToolLoop!(options), (result) => result.usage);
  }
}
