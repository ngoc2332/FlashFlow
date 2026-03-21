# Service Catalog

## Bounded context mapping

- `Order Management`: `order-api`, order-status updater, `order-query-api`
- `Payment Processing`: `payment-worker`
- `Inventory Management`: `inventory-worker`
- `Customer Communication`: `notification-worker`

## 1) order-api

Responsibilities:
- Receive create-order requests.
- Write order aggregate data in Postgres.
- Write outbox event in the same DB transaction.

Input/Output:
- `POST /orders`
- Emits `order.created`

## 2) payment-worker

Responsibilities:
- Consume `order.created`.
- Execute mock payment logic.
- Emit `payment.succeeded` or `payment.failed`.

Kafka:
- Consumer group: `payment-workers`

## 3) inventory-worker

Responsibilities:
- Consume `payment.succeeded`.
- Reserve/reject stock with optimistic locking.
- Emit `inventory.reserved` or `inventory.rejected`.

Kafka:
- Consumer group: `inventory-workers`

## 4) notification-worker

Responsibilities:
- Consume final or important events.
- Send mock email/SMS/push.
- Record notification result.

Kafka:
- Consumer group: `notification-workers`

## 5) order-query-api

Responsibilities:
- Serve current order status quickly.
- Read from Postgres read model with Redis cache.

Input/Output:
- `GET /orders/{orderId}/status`

## Event flow summary

1. `order-api` -> `order.created`
2. `payment-worker` -> `payment.succeeded|failed`
3. `inventory-worker` -> `inventory.reserved|rejected`
4. order-status updater consumes status events and updates read model
5. `notification-worker` consumes selected events
