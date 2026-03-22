# Build Plan (Few Days)

## Day 0 (2-3 hours)

- Run a mini event-storming session.
- Define bounded contexts, aggregates, and ubiquitous language.
- Map first feature to requirement IDs (`FR`, `KR`, `DER`, `TR`).

## Day 1

- Bring up infra: Kafka, Schema Registry, Kafka UI, Postgres, Redis.
- Implement `order-api` + outbox table + outbox publisher worker.
- Produce `order.created` and verify topic flow.

## Day 2

- Implement `payment-worker` and `inventory-worker`.
- Add `processed_events` dedup, manual commit, standardized retry/DLQ, and graceful shutdown/rebalance-safe handling.
- Implement `order-query-api` read model updates.

## Day 3

- Implement `notification-worker`.
- Add metrics, logs with `traceId`, and dashboard basics.
- Run load/failure tests and capture interview screenshots + notes.

## Optional Day 4 (buffer)

- Add compacted `order.status` topic consumer.
- Add one Kafka Streams aggregation for `orders/min`.
- Polish architecture diagram, incident playbooks, and delivery checklists.
