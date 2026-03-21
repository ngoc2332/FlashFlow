# Project Scope

## Product idea
Build a realtime e-commerce event platform for flash-sale traffic.

Main business flow:
`Order -> Payment -> Inventory -> Notification`

## Goals

- Practice Kafka with realistic failure scenarios.
- Build a local stack close to production architecture.
- Demonstrate interview-ready system design and troubleshooting depth.

## Architecture style

- Use `DDD` to split business domains into bounded contexts.
- Use `EDD` to propagate state changes across contexts via events.
- Keep domain rules in domain layer; keep infrastructure concerns in adapters.
- Enforce docs-first delivery: feature work starts from requirement IDs.

## Success criteria

- End-to-end order flow works with async events.
- Retry and DLQ handle transient and poison failures.
- No critical event loss in normal restart scenarios.
- Monitoring shows lag, throughput, errors, and DLQ rate.
- Feature delivery notes can trace implementation back to docs requirements.

## In scope (phase 1 - few days)

- 5 microservices:
  - `order-api`
  - `payment-worker`
  - `inventory-worker`
  - `notification-worker`
  - `order-query-api`
- Kafka core patterns: partition key, consumer group, retry/DLQ, idempotency, manual commit.
- Schema Registry with backward-compatible schema evolution.
- Postgres + Redis for data and query speed.
- DDD + EDD coding workflow and checklists.

## Out of scope (phase 2)

- multi-region replication
- exactly-once end-to-end across all services
- full CI/CD and production deployment
- real external payment gateway integration
