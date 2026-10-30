# ADR-0001: Modular monolith with ports and adapters

Status: Accepted (2026-10-31)

## Decision
DNAFix is a TypeScript modular monolith: Fastify API, React web, and a worker process share versioned packages (`contracts`, `domain`, `application`) and integrate externals (Meta API, GitHub, Project DNA, Docker, git, PostgreSQL) only through ports. No microservices, no Redis/Kafka/Kubernetes.

## Consequences
Single deployable unit, independently testable modules, clear upgrade path to split the worker or execution service later if load ever justifies it.
