# Service Catalog

## Bounded context mapping

- `Order Management`: `order-api`, order-status updater, `order-query-api`
- `Payment Processing`: `payment-worker`
- `Inventory Management`: `inventory-worker`
- `Customer Communication`: `notification-worker` (planned)

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
- Deduplicate handled events with `processed_events`.
- Commit offsets manually only after success/terminal retry-DLQ routing.
- Handle retry topics (`order.retry.5s`, `order.retry.1m`) and terminal DLQ (`order.dlq`).

Kafka:
- Consumer group: `payment-workers`

## 3) inventory-worker

Responsibilities:
- Consume `payment.succeeded`.
- Reserve/reject stock with optimistic locking.
- Emit `inventory.reserved` or `inventory.rejected`.
- Deduplicate handled events with `processed_events`.
- Commit offsets manually only after success/terminal retry-DLQ routing.
- Handle retry topics (`order.retry.5s`, `order.retry.1m`) and terminal DLQ (`order.dlq`).

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
- Read from Postgres read model (`order_status_view`) with fallback to `orders`.

Input/Output:
- `GET /orders/{orderId}/status`

## 6) order-status-updater

Responsibilities:
- Consume status-driving events (`order.created`, `payment.events`, `inventory.events`).
- Update `order_status_view` and publish `order.status` snapshots.
- Deduplicate handled events with `processed_events`.
- Commit offsets manually only after DB upsert and snapshot publish succeed.
- Handle retry topics (`order.retry.5s`, `order.retry.1m`) and terminal DLQ (`order.dlq`).

Kafka:
- Consumer group: `order-status-updaters`

## Tactical DDD code layout

Each runtime service follows this baseline:

- `domain/`: business rules and invariant-aware parsing
- `application/`: use-case orchestration and transaction flow
- `infrastructure/`: DB/Kafka adapters and persistence operations
- entrypoint file (`server.ts` / `worker.ts` / `publisher.ts` / `updater.ts`): transport and process lifecycle

Implemented examples:

- `order-api`: `domain/order.ts`, `application/create-order.use-case.ts`, `infrastructure/order-write-repository.ts`
- `order-query-api`: `domain/order-id.ts`, `application/query-order-status.use-case.ts`, `infrastructure/order-query-repository.ts`
- `payment-worker`: `domain/order-created-event.ts`, `domain/payment-policy.ts`, `application/process-payment-message.use-case.ts`, `infrastructure/payment-outcome-publisher.ts`, `infrastructure/processed-events-repository.ts`
- `inventory-worker`: `domain/payment-succeeded-event.ts`, `domain/inventory-policy.ts`, `application/process-inventory-message.use-case.ts`, `infrastructure/inventory-outcome-publisher.ts`, `infrastructure/processed-events-repository.ts`
- `order-status-updater`: `domain/order-status-policy.ts`, `application/process-status-message.use-case.ts`, `infrastructure/order-status-view-repository.ts`, `infrastructure/order-status-snapshot-publisher.ts`
- `outbox-publisher`: `domain/outbox-event.ts`, `application/publish-outbox-batch.use-case.ts`, `infrastructure/outbox-repository.ts`, `infrastructure/outbox-kafka-producer.ts`

## Event flow summary

1. `order-api` -> `order.created`
2. `payment-worker` -> `payment.succeeded|failed`
3. `inventory-worker` -> `inventory.reserved|rejected`
4. order-status updater consumes status events and updates read model
5. `notification-worker` consumes selected events
