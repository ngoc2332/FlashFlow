# Project Roadmap by Phase

Goal: deliver quickly in a few days while keeping DDD + EDD + Kafka reliability standards.

Status update (2026-03-22):
1. Phase 4 done and smoke passed: `make smoke-phase4`.
2. Completed contract-governance points: Schema Registry `BACKWARD`, standardized envelope, and compatibility checks (`v1 -> v2`).
3. Phase 5 implementation is started in current branch: app metrics, Kafka lag metrics, JSON logs, tracing headers, Prometheus/Grafana dashboard, and runbook updates.
4. Main changed scope in Phase 5: `apps/*`, `packages/common`, `docker-compose.yml`, `ops/*`, `docs/*`.

## Phase 0: Setup and design alignment

1. Finalize scope and requirement IDs in `BA/02-requirements.md`.
2. Finalize bounded contexts, aggregate roots, and ubiquitous language.
3. Finalize event taxonomy (domain/integration) and topic naming.
4. Finalize technical stack and project folder skeleton.

Exit criteria:
1. Shared docs exist for domain, event contracts, and service boundaries.
2. Team/agent can map every feature to `FR/KR/DER/TR` before coding.

## Phase 1: First vertical slice

Feature: `Create Order -> outbox -> publish order.created`.

1. Bring up local infra: Kafka, Schema Registry, Kafka UI, Postgres, Redis.
2. Create DB migration v1: `orders`, `outbox_events`, `processed_events`, `order_status_view`.
3. Implement `order-api` with order write + outbox write in one transaction.
4. Implement `outbox publisher` to push event to `order.created`.
5. Mark `published_at` after successful publish.
6. Add one end-to-end smoke test for this slice.

Exit criteria:
1. `POST /orders` creates orders successfully.
2. `order.created` appears in Kafka.
3. `outbox_events.published_at` is updated.

## Phase 2: Core business flow

1. Implement `payment-worker` consuming `order.created`.
2. Publish `payment.succeeded|payment.failed`.
3. Implement `inventory-worker` consuming payment success.
4. Publish `inventory.reserved|inventory.rejected`.
5. Implement updater for `order_status_view`.
6. Implement `order-query-api` for order status.

Exit criteria:
1. End-to-end flow works: Order -> Payment -> Inventory -> Query status.
2. Order status transitions are correct and queryable.

## Phase 3: Reliability hardening

1. Enable idempotent producer and key by `orderId`.
2. Add consumer dedup using `processed_events`.
3. Use manual offset commit only after successful processing.
4. Implement retry topics (`retry.5s`, `retry.1m`) + `DLQ`.
5. Implement graceful shutdown and rebalance-safe behavior.

Exit criteria:
1. Redelivery does not create duplicate side effects.
2. Retryable errors go through retry, terminal errors go to DLQ.

Requirement mapping:
1. `FR-02`, `FR-03`, `FR-05`
2. `KR-03`, `KR-04`, `KR-06`, `KR-07`
3. `DER-03`, `DER-06`
4. `TR-01`, `TR-02`

## Phase 4: Schema and contract governance

1. Enable Schema Registry with `BACKWARD` compatibility.
2. Standardize event envelope: `eventId`, `eventKind`, `eventType`, `orderId`, `occurredAt`, `traceId`, `payload`.
3. Define event schema versioning rules.
4. Add schema compatibility tests (`v1 -> v2`).

Exit criteria:
1. v1 consumers still process valid v2 events.
2. Breaking changes are blocked by checks/tests.

## Phase 5: Observability and operations

1. Expose app metrics and Kafka lag metrics.
2. Standardize JSON logs with `traceId`, `eventId`, `orderId`.
3. Propagate tracing through Kafka headers.
4. Build Prometheus/Grafana dashboards.
5. Write runbooks for lag, poison message, and DLQ spikes.

Exit criteria:
1. Lag, throughput, errors, and DLQ rate are observable.
2. Runbook is available for debug and safe DLQ replay.

## Phase 6: Testing, performance, and interview package

1. Add unit tests for aggregate invariants.
2. Add integration tests for produce/consume flows.
3. Add failure tests for retry/DLQ and restart recovery.
4. Run load test and capture throughput/latency.
5. Finalize diagrams, incident playbooks, and a 15-minute demo script.

Exit criteria:
1. Baseline NFR targets are met (2,000 events/s and p95 latency target).
2. Interview package is ready end-to-end.
