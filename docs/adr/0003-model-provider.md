# ADR-0003: Muse Wonder via Meta Responses API behind a provider port

Status: Accepted (2026-10-31)

## Context
Meta's Models documentation (fetched 2026-10-31) lists `muse-wonder-1.0` on the Responses, Chat Completions and Messages endpoints with tool calling and structured output. The Responses protocol uses `text.format` JSON-schema structured output and `function_call`/`function_call_output` items.

## Decision
Primary transport: Responses API (`POST https://api.meta.ai/v1/responses`), model ID from `MUSE_WONDER_MODEL` (default `muse-wonder-1.0`, sent verbatim, never silently downgraded). All model I/O is Zod-validated in `packages/contracts`. `MODEL_TRANSPORT=chat-completions` is an explicitly configured alternative behind the same `ModelProvider` port.

Amendment (2026-10-31, user decision): the OpenAI SDK was dropped after inspecting the installed 4.104.0 — plain typed `fetch` create calls plus local Zod parsing proved more reliable against Meta's `text.format` surface, with no unsafe casts. The endpoint is verified live (`pnpm model:smoke`, exit 0) and through a full pipeline run.

Amendment (2026-10-31, user decision): cost split by role. Muse Wonder remains the lead planner. Coding and Verification sub-agents use Muse Spark (`MUSE_SPARK_MODEL`, default `muse-spark-1.3`) through the same provider port — an explicit, recorded configuration, not a silent downgrade. Run records store both model IDs.
