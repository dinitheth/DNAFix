# Model Integration — Muse Wonder

## Verified from Meta documentation (2026-10-31)

- `https://dev.meta.ai/docs/models`: Muse Wonder (`muse-wonder-1.0`) is Meta's model for complex software engineering / long-horizon agentic work; available on Model API pay-as-you-go (Standard mode); endpoints: Responses, Chat Completions, Messages; supports tool calling and structured output; 1,048,576-token context; reasoning effort `minimal`–`max`.
- `https://dev.meta.ai/docs/protocols/responses`: `POST /v1/responses` with `{model, input, instructions, tools, text.format}`; structured output uses `text.format = {type:"json_schema", name, schema, strict:true}` (not OpenAI's `response_format`); function calls arrive as `function_call` output items and are answered with `function_call_output` items; base URL `https://api.meta.ai/v1` with the OpenAI SDK.
- Per the build prompt's warning, Spark support was not assumed to imply Wonder support; the Models page explicitly lists Wonder on the Responses API, so Responses is the primary transport. The transport sits behind `ModelProvider` so Chat Completions can be selected with `MODEL_TRANSPORT=chat-completions` without touching application code.

## Configuration

```env
MODEL_API_KEY=            # required for real runs; never logged or sent anywhere except api.meta.ai
MODEL_API_BASE_URL=https://api.meta.ai/v1
MUSE_WONDER_MODEL=muse-wonder-1.0
MODEL_TRANSPORT=responses # responses | chat-completions
MUSE_REASONING_EFFORT=    # optional: minimal|low|medium|high|xhigh
```

No silent downgrade: the configured model ID is sent verbatim; a provider error fails the step and is recorded. There is no fallback to another model.

## Transport decision (revised 2026-10-31)

The installed OpenAI SDK (4.104.0, per `pnpm-lock.yaml`) was inspected: its `.parse()` helpers are typed around OpenAI's own format objects and produced integration type errors against Meta's `text.format` surface (`AutoParseableTextFormat` mismatch; `chat.completions.parse` unavailable in the installed typings). Rather than upgrade the SDK or suppress errors with unsafe casts, DNAFix uses **one consistent implementation**: plain `POST` create calls over `fetch` with explicitly typed Meta request/response envelopes (Zod-validated), JSON Schema generated from the contract schemas with `zod-to-json-schema`, and **local Zod parsing of every returned result**. The OpenAI SDK dependency was removed. This keeps the Meta protocol explicit, avoids SDK-version coupling, and guarantees validation even if the server is lenient. Covered by mocked-fetch contract tests in `packages/model-provider/src/model-provider.test.ts`.

## What the model does

`MetaModelProvider` (`packages/model-provider/src/index.ts`) implements three Zod-validated operations:

1. `analyzeAndPlan` → `IssueAnalysis` + `ImplementationPlan` (tasks with file scope, dependency IDs, acceptance criteria, retry limits; facts vs hypotheses separated).
2. `generatePatch` → bounded file-patch operations for one task, restricted to that task's scope.
3. `reviewVerification` → independent verifier assessment of diff + test evidence (read-only; the deterministic test runner remains authoritative for pass/fail).

All outputs are parsed through the schemas in `packages/contracts`; invalid output is a recorded failure, not a coerced success. Prompts instruct the model not to reveal chain-of-thought; DNAFix persists decisions, plans, tool calls and evidence only.

## Offline / test behaviour

Without `MODEL_API_KEY`, planning returns a typed `ModelNotConfiguredError`; the run becomes `BLOCKED` and the UI shows the model integration as untested. Tests and `pnpm demo:offline` inject `ScriptedModelProvider`, a scripted test double whose outputs are fixtures; every run record stores `modelProvider: "scripted-test-double"` so it can never be mistaken for a real Muse Wonder run.

## Smoke test

`pnpm model:smoke` (requires `MODEL_API_KEY`) lists models and performs one structured-output planning call against the fixture issue, printing only the validated result and token usage. Status in this environment: **not run — no API key available**.
