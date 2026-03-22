# FlashFlow

Realtime Commerce Event Platform for Kafka practice.

## Phase 1 slice

`Create Order -> outbox -> publish order.created`

## Phase 2 slice

`Order -> Payment -> Inventory -> Query status`

## Phase 3 slice

`Reliability hardening: dedup + manual commit + retry/DLQ + graceful shutdown`

## Phase 4 slice

`Schema Registry BACKWARD + envelope/versioning governance + v1 -> v2 compatibility`

## Stack

- Node.js + TypeScript (workspaces)
- Kafka (KRaft) + Schema Registry + Kafka UI
- PostgreSQL
- Redis

## Quick start

1. Copy env file:

```bash
cp .env.example .env
```

2. Start infrastructure:

```bash
make up
```

3. Create topics and run migrations:

```bash
make topics
make migrate
```

4. Start phase1 services with Docker (recommended):

```bash
make up-phase1
```

Start phase2 services:

```bash
make up-phase2
```

Start phase3 services:

```bash
make up-phase3
```

Start phase4 services:

```bash
make up-phase4
```

Alternative local mode (requires Node.js + npm):

```bash
make install
make dev-order-api
```

```bash
make dev-outbox
```

```bash
make dev-payment
```

```bash
make dev-inventory
```

```bash
make dev-status-updater
```

```bash
make dev-order-query-api
```

5. Test endpoint:

```bash
curl -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -d '{"userId":"u-1","totalAmount":100.50}'
```

## Project layout

- `apps/order-api`: HTTP API, writes `orders` + `outbox_events` in one transaction
- `apps/order-query-api`: reads `order_status_view` and serves current order status
- `apps/outbox-publisher`: polls outbox and publishes to Kafka
- `apps/payment-worker`: consumes `order.created`, publishes payment outcome events, and handles retry/DLQ routing
- `apps/inventory-worker`: consumes `payment.succeeded`, publishes inventory outcome events
- `apps/order-status-updater`: consumes order/payment/inventory events, updates `order_status_view`, publishes `order.status`
- `packages/common`: shared event envelope/types
- `db/migrations`: SQL migrations
- `scripts`: helper scripts (`migrate`, `create-topics`)

## Smoke test (Phase 1 done criteria)

Run everything end-to-end with one command:

```bash
make smoke-phase1
```

This checks:
- `POST /orders` succeeds
- `outbox_events.published_at` is updated
- topic `order.created` has message(s)

## Smoke test (Phase 2 done criteria)

Run Phase 2 end-to-end:

```bash
make smoke-phase2
```

This checks:
- `payment-worker` consumes `order.created`
- `inventory-worker` consumes `payment.succeeded`
- `order-status-updater` updates `order_status_view`
- `order-query-api` returns correct final statuses
- retry path routes failing messages to `order.dlq`

## Smoke test (Phase 3 done criteria)

Run Phase 3 reliability hardening end-to-end:

```bash
make smoke-phase3
```

This checks:
- consumer dedup with `processed_events` prevents duplicate side effects
- manual offset commit remains post-success/terminal handling
- retry/DLQ flow is standardized across workers
- worker restart still converges to correct order status

## Smoke test (Phase 4 start criteria)

Run schema governance and compatibility smoke:

```bash
make smoke-phase4
```

This checks:
- Schema Registry enforces `BACKWARD` compatibility
- `order.created` schema `v2` is backward-compatible with `v1`
- Current consumers still process a valid `order.created` `schemaVersion=2` event

## Requirement mapping (Phase 1)

- `FR-01`, `KR-01`, `KR-02`, `KR-07`, `DER-01`, `DER-03`, `TR-01`

## Requirement mapping (Phase 2)

- `FR-02`, `FR-03`, `FR-05`, `KR-03`, `KR-04`, `KR-07`, `KR-08`, `DER-03`, `TR-01`, `TR-02`

## Requirement mapping (Phase 3)

- `FR-02`, `FR-03`, `FR-05`, `KR-03`, `KR-04`, `KR-06`, `KR-07`, `DER-03`, `DER-06`, `TR-01`, `TR-02`

## Requirement mapping (Phase 4)

- `FR-06`, `KR-05`, `DER-05`, `TR-03`
