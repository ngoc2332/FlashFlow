# Kiến Trúc Tham Chiếu DDD (Mức Code)

Tài liệu này định nghĩa cấu trúc tactical DDD áp dụng ở code runtime.

## 1) Hợp đồng phân lớp

Mỗi service nên theo cấu trúc trong `src/`:

- `domain/`
  - Business rules thuần, invariant, decision policy, parse value object.
  - Không gọi trực tiếp DB/Kafka/HTTP.
- `application/`
  - Use case điều phối domain + infrastructure.
  - Chứa transaction boundary và trình tự workflow.
- `infrastructure/`
  - Adapter Postgres/Kafka, repository, câu lệnh persistence.
  - Không chứa quyết định nghiệp vụ.
- `interfaces/` hoặc file entrypoint (`server.ts`, `worker.ts`, `publisher.ts`, `updater.ts`)
  - Chỉ xử lý transport: HTTP/Kafka handler, metrics/logging, lifecycle process.

Hướng phụ thuộc:

`interfaces -> application -> domain`
`application -> infrastructure`

`domain` không được phụ thuộc ngược vào `application`, `infrastructure`, hay framework interface.

## 2) Mapping hiện tại trong code

### Order Management

- `apps/order-api`
  - `domain/order.ts`
  - `application/create-order.use-case.ts`
  - `infrastructure/order-write-repository.ts`
  - `server.ts` (HTTP + metrics)
- `apps/order-query-api`
  - `domain/order-id.ts`
  - `application/query-order-status.use-case.ts`
  - `infrastructure/order-query-repository.ts`
  - `server.ts`

### Event Publishing và Workers

- `apps/outbox-publisher`
  - `domain/outbox-event.ts`
  - `application/publish-outbox-batch.use-case.ts`
  - `infrastructure/outbox-repository.ts`
  - `infrastructure/outbox-kafka-producer.ts`
  - `publisher.ts`
- `apps/payment-worker`
  - `domain/order-created-event.ts`
  - `domain/payment-policy.ts`
  - `application/process-payment-message.use-case.ts`
  - `infrastructure/processed-events-repository.ts`
  - `infrastructure/payment-outcome-publisher.ts`
  - `infrastructure/offset-committer.ts`
  - `infrastructure/order-key.ts`
  - `worker.ts`
- `apps/inventory-worker`
  - `domain/payment-succeeded-event.ts`
  - `domain/inventory-policy.ts`
  - `application/process-inventory-message.use-case.ts`
  - `infrastructure/processed-events-repository.ts`
  - `infrastructure/inventory-outcome-publisher.ts`
  - `infrastructure/offset-committer.ts`
  - `infrastructure/order-key.ts`
  - `worker.ts`
- `apps/order-status-updater`
  - `domain/order-status-policy.ts`
  - `application/process-status-message.use-case.ts`
  - `infrastructure/order-status-view-repository.ts`
  - `infrastructure/order-status-snapshot-publisher.ts`
  - `infrastructure/processed-events-repository.ts`
  - `infrastructure/retry-router.ts`
  - `infrastructure/offset-committer.ts`
  - `infrastructure/order-key.ts`
  - `updater.ts`

## 3) Quy tắc đặt code

- Parse/validation mang semantics nghiệp vụ đặt trong `domain/`.
- Workflow nhiều bước và transaction boundary đặt trong `application/`.
- SQL và call external client đặt trong `infrastructure/`.
- Entrypoint phải mỏng, không lặp lại business rule.

## 4) Reliability trong ngữ cảnh DDD

- Outbox thuộc write boundary của use case `Order`.
- Dedup consumer (`processed_events`) là concern của infrastructure.
- Retry/DLQ là orchestration ở interface/infrastructure; policy retryability nằm ở domain error types.

## 5) Ghi chú phạm vi

Refactor này thiết lập phân lớp tactical DDD cho toàn bộ runtime service mà không đổi behavior nghiệp vụ và Kafka topology.
