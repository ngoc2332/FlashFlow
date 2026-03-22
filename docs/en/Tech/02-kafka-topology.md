# Kafka Topology

## Cluster assumptions

- Single Kafka cluster in local environment (KRaft mode).
- Replication factor in local can be `1`; in production target `3`.

## Event taxonomy (EDD)

- `Domain events`: internal state transitions inside one bounded context.
- `Integration events`: published for other bounded contexts/services.
- For this project, topics below carry integration events.

## Topic design

| Topic | Purpose | Key | Suggested Partitions | Retention/Cleanup |
|---|---|---|---:|---|
| `order.created` | New order events | `orderId` | 6 | delete, 7d |
| `payment.events` | Payment outcomes | `orderId` | 6 | delete, 7d |
| `inventory.events` | Inventory outcomes | `orderId` | 6 | delete, 7d |
| `notification.events` | Notification jobs | `orderId` | 3 | delete, 3d |
| `order.retry.5s` | Short retry | `orderId` | 3 | delete, 1d |
| `order.retry.1m` | Medium retry | `orderId` | 3 | delete, 1d |
| `order.dlq` | Poison/terminal failures | `orderId` | 3 | delete, 14d |
| `order.status` | Latest status stream | `orderId` | 6 | compact |

## Producer settings (baseline)

- `enable.idempotence=true`
- `acks=all`
- `retries` high enough for transient network issues
- Include headers: `eventId`, `traceId`, `source`, `schemaVersion`, `eventKind`

## Consumer settings (baseline)

- Consumer group per worker type
- `enable.auto.commit=false`
- Manual commit only after business logic + DB writes succeed
- Consumer dedup table: `processed_events(event_id, consumer_group)`
- Dead-letter metadata fields: `errorType`, `errorMessage`, `failedAt`, `retryCount`, `targetWorker`

## Retry and DLQ policy

- Retryable errors: network timeout, temporary dependency errors.
- Non-retryable errors: schema invalid, business rule hard-fail.
- Retry topics are shared; `targetWorker` header routes each retry message to the intended consumer.
- Backoff route example:
  - attempt 1 fail -> `order.retry.5s`
  - attempt 2 fail -> `order.retry.1m`
  - attempt 3 fail -> `order.dlq`

## Schema strategy

- Use Avro or Protobuf with Schema Registry.
- Compatibility mode: `BACKWARD`.
- Required envelope fields:
  - `eventId` (UUID)
  - `eventKind` (`domain` or `integration`)
  - `eventType`
  - `orderId`
  - `occurredAt`
  - `traceId`
  - `payload`
- Versioning rules:
  - `schemaVersion=1` is baseline; consumers must accept `>=1`.
  - `v2+` changes must be additive only (new optional/defaulted fields).
  - Do not remove/rename required fields in-place; use new event type for breaking changes.
- Governance scripts:
  - `make schema-phase4` sets Schema Registry compatibility to `BACKWARD` and validates `order.created` schema evolution.
  - `make smoke-phase4` runs end-to-end `v1 -> v2` compatibility smoke.
