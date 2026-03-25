# DDD + EDD Feature Playbook

Use this playbook for every new feature.

## Step 1: Map requirements before coding

- Select requirement IDs from `BA/02-requirements.md`.
- Minimum mapping: one `FR`, one `KR`, one `DER`, one `TR`.
- Write this mapping in task notes or PR description.
- If feature touches persistence, read `Tech/05-database-design-and-operations.md` first.

## Step 2: Define bounded context and aggregate

- Identify the bounded context impacted.
- Identify aggregate root and invariants.
- Confirm ownership: one service owns one aggregate transaction boundary.

## Step 3: Design events first (EDD)

- Decide if the event is domain or integration.
- Define event name, key (`orderId`), required headers, and schema version.
- Define retryability and DLQ behavior for failure.

## Step 4: Design data consistency and reliability

- Use outbox for DB-to-Kafka publishing.
- Use consumer dedup (`eventId`) for at-least-once handling.
- Use manual commit after successful business processing.

## Step 5: Implement

- Keep domain logic in domain layer.
- Keep Kafka, DB, Redis operations in infrastructure adapters.
- Keep handlers thin; call domain services for core rules.

## Default service skeleton

Use this folder layout for every runtime service:

```text
src/
  domain/
  application/
  infrastructure/
  interfaces/ (optional)
  server.ts | worker.ts | publisher.ts | updater.ts
```

Rules:

- `domain` has zero direct DB/Kafka/HTTP calls.
- `application` owns orchestration and transaction boundaries.
- `infrastructure` owns adapters and SQL/client calls.
- entrypoint files stay thin (wiring + transport + metrics/logging).

## Step 6: Validate

- Run unit tests for aggregate invariants.
- Run integration tests for produce/consume flows.
- Run failure tests for retry/DLQ and restart recovery.

## Step 7: Update docs and interview notes

- Update affected docs if contracts or boundaries changed.
- Add one short delivery note: requirement mapping, tradeoffs, risks.
