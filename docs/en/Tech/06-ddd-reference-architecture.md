# DDD Reference Architecture (Code-Level)

This document defines the tactical DDD code structure used in runtime services.

## 1) Layering contract

Each service should follow this structure under `src/`:

- `domain/`
  - Pure business rules, invariants, decision policies, value object parsing.
  - No direct DB/Kafka/HTTP calls.
- `application/`
  - Use cases orchestrating domain + infrastructure operations.
  - Transaction and workflow sequencing live here.
- `infrastructure/`
  - Postgres/Kafka adapters, repositories, persistence queries.
  - No business decisions.
- `interfaces/` or entrypoint (`server.ts`, `worker.ts`, `publisher.ts`, `updater.ts`)
  - Transport concerns only: HTTP/Kafka handlers, metrics/logging, process lifecycle.

Dependency direction:

`interfaces -> application -> domain`
`application -> infrastructure`

`domain` must not depend on `application`, `infrastructure`, or interface frameworks.

## 2) Current implementation mapping

### Order Management

- `apps/order-api`
  - `domain/order.ts`
  - `application/create-order.use-case.ts`
  - `infrastructure/order-write-repository.ts`
  - `server.ts` (HTTP + metrics)
- `apps/order-query-api`
  - `domain/order-id.ts`
  - `application/query-order-status.use-case.ts`
  - `infrastructure/order-query-repository.ts`
  - `server.ts`

### Event Publishing and Workers

- `apps/outbox-publisher`
  - `domain/outbox-event.ts`
  - `application/publish-outbox-batch.use-case.ts`
  - `infrastructure/outbox-repository.ts`
  - `infrastructure/outbox-kafka-producer.ts`
  - `publisher.ts`
- `apps/payment-worker`
  - `domain/order-created-event.ts`
  - `domain/payment-policy.ts`
  - `application/process-payment-message.use-case.ts`
  - `infrastructure/processed-events-repository.ts`
  - `infrastructure/payment-outcome-publisher.ts`
  - `infrastructure/offset-committer.ts`
  - `infrastructure/order-key.ts`
  - `worker.ts`
- `apps/inventory-worker`
  - `domain/payment-succeeded-event.ts`
  - `domain/inventory-policy.ts`
  - `application/process-inventory-message.use-case.ts`
  - `infrastructure/processed-events-repository.ts`
  - `infrastructure/inventory-outcome-publisher.ts`
  - `infrastructure/offset-committer.ts`
  - `infrastructure/order-key.ts`
  - `worker.ts`
- `apps/order-status-updater`
  - `domain/order-status-policy.ts`
  - `application/process-status-message.use-case.ts`
  - `infrastructure/order-status-view-repository.ts`
  - `infrastructure/order-status-snapshot-publisher.ts`
  - `infrastructure/processed-events-repository.ts`
  - `infrastructure/retry-router.ts`
  - `infrastructure/offset-committer.ts`
  - `infrastructure/order-key.ts`
  - `updater.ts`

## 3) Placement rules

- Put parsing/validation that encodes domain semantics into `domain/`.
- Put multi-step workflow and transaction boundaries into `application/`.
- Put SQL statements and external client calls into `infrastructure/`.
- Keep entrypoints thin; do not re-implement domain rules there.

## 4) Reliability in DDD context

- Outbox is part of `Order` write use case boundary.
- Consumer dedup (`processed_events`) remains an infrastructure concern.
- Retry/DLQ routing remains interface/infrastructure orchestration, while retryability policy stays in domain error types.

## 5) Scope note

This refactor establishes tactical DDD layering across runtime services without changing business behavior or Kafka topology.
