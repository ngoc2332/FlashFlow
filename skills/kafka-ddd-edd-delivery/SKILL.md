---
name: kafka-ddd-edd-delivery
description: Enforce docs-first feature delivery for the kafka-practice repository using DDD and EDD. Use when planning, implementing, refactoring, or reviewing any feature that touches services, Kafka topics, event schemas, DB/cache, retries/DLQ, or tests in this project.
---

# Kafka DDD EDD Delivery

## Workflow

### 1) Select docs language and source of truth

- Use English docs under `docs/en` or Vietnamese docs under `docs/vi`.
- Keep one language set as the active source of truth for the current task.

### 2) Map requirements before coding

- Read `BA/02-requirements`, `Tech/04-*`, and `Tech/05-*` in the selected language.
- Record at least one `FR`, one `KR`, one `DER`, and one `TR` before implementation.
- If no requirement fits, update docs first, then implement.

### 3) Define DDD boundaries

- Pick the bounded context and owning service.
- Identify aggregate root and invariants.
- Keep one aggregate consistency boundary per transaction.

### 4) Define EDD contracts

- Classify event as domain or integration.
- Define topic, key, required headers, schema version, and compatibility rule.
- Define retryable/non-retryable failure handling and DLQ routing.

### 5) Apply reliability patterns

- Use outbox for DB-to-Kafka publish paths.
- Use dedup by `eventId` on consumers.
- Commit offsets only after successful business processing.

### 6) Implement and validate

- Keep domain rules in domain layer and infrastructure in adapters.
- Add unit tests for aggregate invariants.
- Add integration and failure tests for produce/consume, retry, DLQ, and restart recovery.

### 7) Close with traceability

- Update docs when boundaries or contracts change.
- Provide a short delivery note with requirement IDs, tradeoffs, and risks.

## Required response template for feature tasks

Use this template before coding:

- Requirement mapping: `FR-..`, `KR-..`, `DER-..`, `TR-..`
- Bounded context and aggregate:
- Event contract changes:
- Reliability impact (outbox/dedup/retry/DLQ):
- Test plan:

## References

- Read `references/doc-map.md` for exact file mapping.
- Read `references/feature-checklist.md` for definition of done.
