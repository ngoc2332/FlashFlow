# Requirements

## 1) Business Requirements (BR)

- `BR-01`: System handles realtime flash-sale order traffic.
- `BR-02`: Order lifecycle status is queryable in near realtime.
- `BR-03`: Critical business events are not lost.
- `BR-04`: Downstream failures are isolated with retry and DLQ.

## 2) Functional Requirements (FR)

- `FR-01`: `order-api` publishes `order.created`.
- `FR-02`: `payment-worker` consumes `order.created` and publishes `payment.succeeded` or `payment.failed`.
- `FR-03`: `inventory-worker` consumes `payment.succeeded` and publishes `inventory.reserved` or `inventory.rejected`.
- `FR-04`: `notification-worker` consumes business events and sends mock notifications.
- `FR-05`: `order-query-api` returns current order status from read model.
- `FR-06`: All events include `eventId`, `orderId`, `eventType`, `occurredAt`, `traceId`.

## 3) Kafka Requirements (KR)

- `KR-01`: Partition key must be `orderId` to preserve per-order ordering.
- `KR-02`: Producer enables idempotence.
- `KR-03`: Consumers run in consumer groups and scale horizontally.
- `KR-04`: Retry topics exist (`retry.5s`, `retry.1m`) and terminal failures go to `dlq`.
- `KR-05`: Schema Registry enforces backward compatibility.
- `KR-06`: At-least-once delivery with consumer-side dedup by `eventId`.
- `KR-07`: Manual offset commit happens only after successful processing.
- `KR-08`: `order.status` compacted topic stores latest status by `orderId`.

## 4) DDD and EDD Requirements (DER)

- `DER-01`: Every feature maps to one bounded context before implementation.
- `DER-02`: Business invariants are enforced inside aggregate roots.
- `DER-03`: Cross-context communication uses events, not direct DB coupling.
- `DER-04`: Distinguish domain events and integration events explicitly.
- `DER-05`: Event contracts are versioned and backward compatible.
- `DER-06`: Every implementation task references requirement IDs (e.g. `FR-02`, `KR-04`, `DER-03`) before coding.

## 5) Advanced Requirements (AR)

- `AR-01`: Outbox pattern from DB transaction to Kafka publish.
- `AR-02`: Rebalance-safe consumers (graceful shutdown + revoke handling).
- `AR-03`: Kafka Streams or equivalent aggregator for realtime metrics (optional for phase 1).

## 6) Non-functional Requirements (NFR)

- `NFR-01`: Baseline throughput target: 2,000 events/s.
- `NFR-02`: Happy path p95 end-to-end latency target: < 500 ms.
- `NFR-03`: Restarting one consumer instance does not lose committed progress.
- `NFR-04`: Recovery from single worker crash within 60 seconds.
- `NFR-05`: Lag, throughput, error rate, and DLQ rate are observable.

## 7) Test Requirements (TR)

- `TR-01`: Integration test for producer and consumer flow.
- `TR-02`: Failure test for retry and DLQ path.
- `TR-03`: Schema evolution compatibility test (`v1 -> v2`).
- `TR-04`: Basic load test with report for throughput and latency.
- `TR-05`: Domain rule tests per bounded context (aggregate invariants).

## 8) Acceptance Criteria

- Place an order and observe final status through `order-query-api`.
- Inject payment/inventory failure and observe retry + DLQ behavior.
- Restart consumer during traffic and verify system catches up with no missing completed events.
- Publish schema v2 compatible with v1 consumers without runtime break.
- For each delivered feature, provide requirement traceability (`FR/KR/DER/TR`) in PR or delivery notes.
