# Thiết Kế Kafka Topology

## Giả định cụm

- Một Kafka cluster cho môi trường local (KRaft mode).
- Replication factor local có thể để `1`; mục tiêu production là `3`.

## Phân loại event (EDD)

- `Domain events`: thay đổi trạng thái bên trong một bounded context.
- `Integration events`: event public cho context/service khác consume.
- Các topic bên dưới dùng cho integration events.

## Thiết kế topic

| Topic | Mục đích | Key | Số partition gợi ý | Retention/Cleanup |
|---|---|---|---:|---|
| `order.created` | Sự kiện tạo đơn mới | `orderId` | 6 | delete, 7d |
| `payment.events` | Kết quả thanh toán | `orderId` | 6 | delete, 7d |
| `inventory.events` | Kết quả tồn kho | `orderId` | 6 | delete, 7d |
| `notification.events` | Nhiệm vụ thông báo | `orderId` | 3 | delete, 3d |
| `order.retry.5s` | Retry ngắn | `orderId` | 3 | delete, 1d |
| `order.retry.1m` | Retry trung bình | `orderId` | 3 | delete, 1d |
| `order.dlq` | Lỗi terminal/poison | `orderId` | 3 | delete, 14d |
| `order.status` | Dòng trạng thái mới nhất | `orderId` | 6 | compact |

## Producer settings (baseline)

- `enable.idempotence=true`
- `acks=all`
- `retries` đủ lớn để qua lỗi network tạm thời
- Header cần có: `eventId`, `traceId`, `source`, `schemaVersion`, `eventKind`

## Consumer settings (baseline)

- Mỗi loại worker có consumer group riêng
- `enable.auto.commit=false`
- Manual commit chỉ sau khi business logic + DB writes thành công
- Bảng dedup consumer: `processed_events(event_id, consumer_group)`
- Metadata cho dead-letter: `errorType`, `errorMessage`, `failedAt`, `retryCount`, `targetWorker`

## Chính sách retry và DLQ

- Retryable errors: network timeout, dependency tạm thời lỗi.
- Non-retryable errors: schema sai, hard-fail business rule.
- Retry topics dùng chung; header `targetWorker` định tuyến retry về đúng consumer.
- Ví dụ route backoff:
  - lần 1 lỗi -> `order.retry.5s`
  - lần 2 lỗi -> `order.retry.1m`
  - lần 3 lỗi -> `order.dlq`

## Chiến lược schema

- Dùng Avro hoặc Protobuf với Schema Registry.
- Compatibility mode: `BACKWARD`.
- Các field envelope bắt buộc:
  - `eventId` (UUID)
  - `eventKind` (`domain` hoặc `integration`)
  - `eventType`
  - `orderId`
  - `occurredAt`
  - `traceId`
  - `payload`
- Quy tắc versioning:
  - `schemaVersion=1` là baseline; consumer phải đọc được version `>=1`.
  - Thay đổi từ `v2+` chỉ theo hướng additive (thêm field optional/default).
  - Không đổi tên/xóa required field tại chỗ; breaking change phải dùng event type mới.
- Script governance:
  - `make schema-phase4` set Schema Registry về `BACKWARD` và validate evolution cho schema `order.created`.
  - `make smoke-phase4` chạy smoke end-to-end cho tương thích `v1 -> v2`.
