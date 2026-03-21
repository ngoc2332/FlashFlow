# Lộ Trình Dự Án Theo Phase

Mục tiêu: triển khai nhanh trong vài ngày nhưng vẫn giữ chuẩn DDD + EDD + Kafka reliability.

## Phase 0: Khởi tạo và chốt thiết kế

1. Chốt scope và requirement IDs trong `BA/02-yeu-cau.md`.
2. Chốt bounded contexts, aggregate roots, và ubiquitous language.
3. Chốt event taxonomy (domain/integration) và topic naming.
4. Chốt stack kỹ thuật và skeleton thư mục code.

Điều kiện hoàn thành:
1. Có tài liệu thống nhất cho domain + event + service boundary.
2. Team/code agent map được feature vào `FR/KR/DER/TR` trước khi code.

## Phase 1: Vertical Slice đầu tiên

Feature: `Create Order -> outbox -> publish order.created`.

1. Dựng infra local: Kafka, Schema Registry, Kafka UI, Postgres, Redis.
2. Tạo migration DB v1: `orders`, `outbox_events`, `processed_events`, `order_status_view`.
3. Implement `order-api` tạo order + ghi outbox trong cùng transaction.
4. Implement `outbox publisher` đẩy event lên topic `order.created`.
5. Đánh dấu `published_at` sau khi publish thành công.
6. Viết smoke test end-to-end cho luồng này.

Điều kiện hoàn thành:
1. Gọi `POST /orders` tạo được order.
2. Event `order.created` xuất hiện trên Kafka.
3. `outbox_events.published_at` được cập nhật.

## Phase 2: Luồng nghiệp vụ cốt lõi

1. Implement `payment-worker` consume `order.created`.
2. Publish `payment.succeeded|payment.failed`.
3. Implement `inventory-worker` consume payment success.
4. Publish `inventory.reserved|inventory.rejected`.
5. Implement updater cho `order_status_view`.
6. Implement `order-query-api` trả trạng thái đơn hàng.

Điều kiện hoàn thành:
1. Chạy được luồng Order -> Payment -> Inventory -> Query status.
2. Trạng thái đơn hàng cập nhật đúng theo event.

## Phase 3: Reliability hardening

1. Bật idempotent producer + key theo `orderId`.
2. Thêm dedup consumer bằng `processed_events`.
3. Bật manual offset commit sau xử lý thành công.
4. Triển khai retry topics (`retry.5s`, `retry.1m`) + `DLQ`.
5. Xử lý graceful shutdown và rebalance-safe behavior.

Điều kiện hoàn thành:
1. Không xử lý trùng side effects khi có redelivery.
2. Lỗi tạm thời đi qua retry, lỗi cứng vào DLQ.

## Phase 4: Schema và contract governance

1. Bật Schema Registry với compatibility `BACKWARD`.
2. Chuẩn hóa event envelope: `eventId`, `eventKind`, `eventType`, `orderId`, `occurredAt`, `traceId`, `payload`.
3. Thiết lập versioning rule cho event schema.
4. Viết test `v1 -> v2` backward compatible.

Điều kiện hoàn thành:
1. Consumer v1 vẫn đọc được event v2 hợp lệ.
2. Thay đổi breaking bị chặn bởi rule/test.

## Phase 5: Observability và vận hành

1. Expose app metrics + Kafka lag metrics.
2. Chuẩn hóa JSON logging có `traceId`, `eventId`, `orderId`.
3. Bật tracing xuyên service qua Kafka headers.
4. Dựng dashboard Prometheus/Grafana.
5. Viết runbook xử lý lag, poison message, DLQ spike.

Điều kiện hoàn thành:
1. Theo dõi được lag, throughput, error, DLQ rate.
2. Có runbook để debug và replay DLQ an toàn.

## Phase 6: Test, performance, và interview package

1. Viết unit tests cho aggregate invariants.
2. Viết integration tests cho produce/consume flows.
3. Viết failure tests cho retry/DLQ và restart recovery.
4. Chạy load test và đo throughput/latency.
5. Hoàn thiện diagram + incident playbooks + demo script 15 phút.

Điều kiện hoàn thành:
1. Đạt baseline NFR (2,000 events/s và p95 latency mục tiêu).
2. Có bộ tài liệu/demo sẵn sàng cho phỏng vấn.
