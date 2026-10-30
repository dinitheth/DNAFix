# ADR-0004: Durable workflow — Temporal definitions, in-process durable engine for local dev

Status: Accepted (2026-10-31)

## Context
The brief requires Temporal durable workflows. This environment has no Docker daemon and no Temporal server, and single-user local development must stay operationally simple.

## Decision
The lifecycle state machine lives in `packages/domain` and is the single source of truth. Two executors implement the same `WorkflowEngine` port:
1. `InProcessDurableEngine` (default): persists every transition + audit event through the `Store` port before advancing, supports cancellation, approval pauses, idempotency keys and restart resume. Labelled `workflowEngine: "in-process-durable"` in API responses.
2. Temporal: `apps/worker/src/temporal/` contains a deterministic workflow that mirrors the state machine and calls the same application services from activities; docker-compose provides Temporal + PostgreSQL. Enabled with `WORKFLOW_ENGINE=temporal` and `TEMPORAL_ADDRESS`.

## Consequences
Local demo is honest and resumable without infrastructure; production durability upgrades by configuration. External side effects (branch/PR creation) use idempotency keys in both engines since Temporal gives at-least-once activity execution.
