# Kế Hoạch Xây Dựng (Vài Ngày)

## Ngày 0 (2-3 giờ)

- Làm mini event-storming.
- Chốt bounded context, aggregate và ubiquitous language.
- Map feature đầu tiên với requirement IDs (`FR`, `KR`, `DER`, `TR`).

## Ngày 1

- Dựng infra: Kafka, Schema Registry, Kafka UI, Postgres, Redis.
- Implement `order-api` + outbox table + outbox publisher worker.
- Publish `order.created` và xác minh luồng topic.

## Ngày 2

- Implement `payment-worker` và `inventory-worker`.
- Thêm dedup `processed_events`, manual commit, retry/DLQ chuẩn hóa, và graceful shutdown/rebalance-safe.
- Implement cập nhật read model cho `order-query-api`.

## Ngày 3

- Implement `notification-worker`.
- Thêm metrics, logs có `traceId`, và dashboard cơ bản.
- Chạy load/failure tests và lưu screenshot + ghi chú cho phỏng vấn.

## Ngày 4 tùy chọn (buffer)

- Thêm consumer cho compacted topic `order.status`.
- Thêm 1 Kafka Streams aggregation cho `orders/min`.
- Hoàn thiện architecture diagram, incident playbooks, và checklist giao feature.
