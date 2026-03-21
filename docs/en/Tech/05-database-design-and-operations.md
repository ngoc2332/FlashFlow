# Database Design and Operations

This document defines the production-like database standards for this project.
Use it together with:
- `Tech/03-data-db-cache.md`
- `Tech/04-ddd-edd-playbook.md`
- `BA/02-requirements.md`

## 1) DB ownership by bounded context

- `Order Management` owns:
  - `orders`
  - `outbox_events`
  - `order_status_view` (read model updater ownership)
- `Payment Processing` owns:
  - `payment_attempts`
- `Inventory Management` owns:
  - `inventory`
  - `inventory_reservations`
- Shared reliability ownership:
  - `processed_events` (consumer dedup store)

Rule:
- One service owns writes for its tables.
- Other services consume events, not foreign writes.

## 2) Logical ERD (text)

- `orders (order_id)` 1 --- n `outbox_events (aggregate_id)`
- `orders (order_id)` 1 --- 1 `order_status_view (order_id)`
- `inventory (sku)` 1 --- n `inventory_reservations (sku)`
- `processed_events (event_id, consumer_group)` tracks consumed integration events

## 3) Schema conventions

- Primary key naming:
  - `*_id` for UUID/business identifiers
  - natural key only when domain requires it (`sku`)
- Timestamps:
  - use `timestamptz`
  - minimum fields: `created_at`, `updated_at`
- Status columns:
  - `text` + check constraint or enum type
- Monetary values:
  - `numeric(18,2)` for currency amounts

## 4) Required constraints and indexes

### Orders and outbox

- `orders.order_id` primary key
- `orders.status` index
- `orders.created_at` index
- `outbox_events.event_id` unique
- `outbox_events.aggregate_id, outbox_events.created_at` index
- `outbox_events.published_at` index (publisher polling)

### Dedup and idempotency

- `processed_events` unique composite key:
  - `(event_id, consumer_group)`
- optional index:
  - `processed_at` for cleanup jobs

### Inventory correctness

- `inventory.sku` primary key
- `inventory.available_qty >= 0` check
- `inventory.reserved_qty >= 0` check
- `inventory.version` not null
- `inventory_reservations (order_id, sku)` unique

## 5) Core SQL patterns

### 5.1 Outbox transaction (single write boundary)

```sql
BEGIN;

INSERT INTO orders (order_id, user_id, status, total_amount, created_at, updated_at)
VALUES ($1, $2, 'PENDING_PAYMENT', $3, now(), now());

INSERT INTO outbox_events (id, event_id, aggregate_id, event_type, payload, created_at)
VALUES (gen_random_uuid(), $4, $1, 'order.created', $5::jsonb, now());

COMMIT;
```

### 5.2 Consumer dedup gate

```sql
INSERT INTO processed_events (event_id, consumer_group, processed_at)
VALUES ($1, $2, now())
ON CONFLICT (event_id, consumer_group) DO NOTHING;
```

If zero rows inserted:
- treat as duplicate
- skip business side effects
- commit offset safely

### 5.3 Optimistic locking for inventory

```sql
UPDATE inventory
SET available_qty = available_qty - $1,
    reserved_qty = reserved_qty + $1,
    version = version + 1,
    updated_at = now()
WHERE sku = $2
  AND available_qty >= $1
  AND version = $3;
```

If affected rows = 0:
- stock is stale or insufficient
- emit rejection event

## 6) Migration standards

- Keep migrations forward-only and ordered by timestamp.
- Every migration must include:
  - `up` SQL
  - `down` SQL or explicit rollback note
- Never edit an applied migration in shared environments.
- For breaking changes:
  - apply expand-contract strategy
  - keep backward-compatible reads/writes until all consumers are upgraded

## 7) Data lifecycle and maintenance

- `outbox_events`:
  - publish then mark `published_at`
  - archive or purge by retention window
- `processed_events`:
  - apply TTL cleanup job (for example 7-30 days)
- `order_status_view`:
  - rebuild script supported from canonical events when needed

## 8) Performance checklist

- Verify indexes exist for all high-frequency query predicates.
- Run `EXPLAIN (ANALYZE, BUFFERS)` for critical queries.
- Avoid cross-context joins in online paths.
- Batch read/write where domain-safe.
- Set slow query threshold and capture query plans.

## 9) DB review checklist (Definition of Done)

- Requirement mapping includes `FR/KR/DER/TR`.
- Aggregate transaction boundary is respected.
- Required constraints and indexes exist.
- Outbox and dedup behavior is tested.
- Retry/DLQ path is tested for DB error scenarios.
- Migration is reversible or has a documented rollback path.
