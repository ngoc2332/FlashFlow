# FlashFlow

Realtime Commerce Event Platform for Kafka practice.

## Phase 1 slice

`Create Order -> outbox -> publish order.created`

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

Alternative local mode (requires Node.js + npm):

```bash
make install
make dev-order-api
```

```bash
make dev-outbox
```

5. Test endpoint:

```bash
curl -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -d '{"userId":"u-1","totalAmount":100.50}'
```

## Project layout

- `apps/order-api`: HTTP API, writes `orders` + `outbox_events` in one transaction
- `apps/outbox-publisher`: polls outbox and publishes to Kafka
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

## Requirement mapping (Phase 1)

- `FR-01`, `KR-01`, `KR-02`, `KR-07`, `DER-01`, `DER-03`, `TR-01`
