# Data, DB, and Cache Design

## Database choice

- Primary DB: `PostgreSQL`
- Why: ACID transactions, constraints, indexing, strong tooling.

## Cache choice

- Cache: `Redis`
- Why: low-latency reads, simple dedup/idempotency keys, TTL control.

## DDD persistence rules

- Keep one aggregate consistency boundary per transaction.
- Avoid cross-bounded-context joins in domain logic.
- Persist business data + outbox in the same transaction.
- Keep read model updates asynchronous through events.

## Core Postgres tables

### `orders`

- `order_id` (PK)
- `user_id`
- `status`
- `total_amount`
- `created_at`, `updated_at`

Indexes:
- `idx_orders_status`
- `idx_orders_created_at`

### `outbox_events`

- `id` (PK)
- `event_id` (unique)
- `aggregate_id` (`order_id`)
- `event_type`
- `payload` (jsonb)
- `published_at` (nullable)
- `created_at`

Pattern:
- write business row + outbox row in same transaction
- separate publisher process sends to Kafka and marks `published_at`

### `processed_events`

- `event_id` (PK)
- `consumer_group`
- `processed_at`

Purpose:
- consumer dedup for at-least-once delivery
- insert first, handle unique-violation as duplicate skip

### `inventory`

- `sku` (PK)
- `available_qty`
- `reserved_qty`
- `version`

Technique:
- optimistic locking via `version`
- prevent oversell under concurrent updates

### `order_status_view`

- `order_id` (PK)
- `current_status`
- `last_event_id`
- `last_updated_at`

Purpose:
- fast query model for `order-query-api`

## Redis key design

- `order:status:{orderId}` -> serialized current status, TTL 60-300s
- `idem:{consumerGroup}:{eventId}` -> processed marker, TTL 1-7d

## DB/Cache rules

- Postgres is source of truth.
- Redis is acceleration layer only.
- On status update event:
  - update `order_status_view`
  - invalidate or refresh Redis key
