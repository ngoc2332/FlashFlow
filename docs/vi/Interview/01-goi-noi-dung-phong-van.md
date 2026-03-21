# Gói Nội Dung Phỏng Vấn

## 1) Dự án này chứng minh được gì

- Bạn thiết kế được event-driven microservices với Kafka.
- Bạn nắm được reliability patterns: outbox, retries, DLQ, dedup.
- Bạn lý giải được bài toán consistency, ordering và failure recovery.
- Bạn áp dụng được DDD và EDD theo hướng thực dụng, gần production.
- Bạn vận hành được hệ thống bằng metrics, logs, tracing, runbook.

## 2) Các talking points quan trọng

- Vì sao partition theo `orderId` (tradeoff giữa ordering và parallelism).
- Vì sao at-least-once + dedup là lựa chọn thực dụng.
- Vì sao outbox an toàn hơn dual write DB + Kafka trực tiếp.
- Vì sao compacted `order.status` hữu ích cho latest-state consumers.
- Vì sao bounded context giúp giảm coupling giữa service.
- Vì sao event contract giúp team evolve độc lập.

## 3) Năm incident playbook

### Incident A: Xử lý trùng event

- Dấu hiệu: một đơn hàng bị trừ tồn hai lần.
- Nguyên nhân: redelivery trong cơ chế at-least-once sau restart consumer.
- Cách xử lý: dedup bằng `processed_events` với unique `eventId`.

### Incident B: Rebalance storm

- Dấu hiệu: lag tăng mạnh khi scale up/down.
- Nguyên nhân: consumer restart thường xuyên / shutdown chậm.
- Cách xử lý: graceful shutdown và giảm churn khi deploy.

### Incident C: Poison message

- Dấu hiệu: cùng một record trên partition bị fail lặp lại.
- Nguyên nhân: payload lỗi hoặc business rule hard-fail.
- Cách xử lý: classify non-retryable errors và đẩy thẳng vào DLQ.

### Incident D: Schema breaking change

- Dấu hiệu: consumer deserialization fail sau deploy.
- Nguyên nhân: cập nhật schema không tương thích.
- Cách xử lý: enforce backward compatibility check trong CI.

### Incident E: Lag tăng đột biến lúc cao điểm

- Dấu hiệu: end-to-end latency vượt mức p95.
- Nguyên nhân: thiếu partition hoặc DB writes chậm.
- Cách xử lý: scale consumer replicas, tune partitions, batch writes khi an toàn.

## 4) Luồng demo 15 phút để đi phỏng vấn

1. Trình bày architecture diagram kèm bounded contexts và topic map.
2. Tạo order và theo dõi event trên Kafka UI.
3. Tiêm lỗi và trình bày retry sau đó vào DLQ.
4. Mở dashboard metrics và giải thích hành vi lag.
5. Kết bài bằng một incident và tradeoff quyết định theo DDD/EDD.
