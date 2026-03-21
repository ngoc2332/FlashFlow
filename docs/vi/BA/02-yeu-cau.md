# Yêu Cầu

## 1) Business Requirements (BR)

- `BR-01`: Hệ thống xử lý được traffic đặt hàng realtime trong flash sale.
- `BR-02`: Có thể truy vấn trạng thái vòng đời đơn hàng gần realtime.
- `BR-03`: Không được mất các business event quan trọng.
- `BR-04`: Lỗi downstream được cô lập bằng retry và DLQ.

## 2) Functional Requirements (FR)

- `FR-01`: `order-api` publish `order.created`.
- `FR-02`: `payment-worker` consume `order.created` và publish `payment.succeeded` hoặc `payment.failed`.
- `FR-03`: `inventory-worker` consume `payment.succeeded` và publish `inventory.reserved` hoặc `inventory.rejected`.
- `FR-04`: `notification-worker` consume business events và gửi thông báo mock.
- `FR-05`: `order-query-api` trả về trạng thái đơn hàng hiện tại từ read model.
- `FR-06`: Mỗi event bắt buộc có `eventId`, `orderId`, `eventType`, `occurredAt`, `traceId`.

## 3) Kafka Requirements (KR)

- `KR-01`: Partition key bắt buộc là `orderId` để giữ ordering theo từng đơn hàng.
- `KR-02`: Producer bật idempotence.
- `KR-03`: Consumer chạy theo consumer group và scale ngang được.
- `KR-04`: Có retry topics (`retry.5s`, `retry.1m`) và lỗi cuối cùng vào `dlq`.
- `KR-05`: Schema Registry enforce backward compatibility.
- `KR-06`: At-least-once delivery kết hợp consumer-side dedup bằng `eventId`.
- `KR-07`: Manual offset commit chỉ sau khi xử lý thành công.
- `KR-08`: Topic compacted `order.status` lưu latest status theo `orderId`.

## 4) DDD và EDD Requirements (DER)

- `DER-01`: Mỗi tính năng phải map vào đúng bounded context trước khi implement.
- `DER-02`: Business invariants phải được enforce trong aggregate root.
- `DER-03`: Giao tiếp giữa context dùng event, không coupling trực tiếp DB.
- `DER-04`: Tách rõ domain events và integration events.
- `DER-05`: Event contracts phải có version và backward compatible.
- `DER-06`: Trước khi code, task bắt buộc tham chiếu requirement IDs (`FR/KR/DER/TR`).

## 5) Advanced Requirements (AR)

- `AR-01`: Outbox pattern từ DB transaction sang Kafka publish.
- `AR-02`: Consumer an toàn khi rebalance (graceful shutdown + revoke handling).
- `AR-03`: Kafka Streams hoặc aggregator tương đương cho realtime metrics (tùy chọn phase 1).

## 6) Non-functional Requirements (NFR)

- `NFR-01`: Mục tiêu throughput cơ bản: 2,000 events/s.
- `NFR-02`: Mục tiêu p95 latency end-to-end happy path: < 500 ms.
- `NFR-03`: Restart 1 consumer instance không làm mất tiến độ đã commit.
- `NFR-04`: Khôi phục sau khi 1 worker chết trong <= 60 giây.
- `NFR-05`: Quan sát được lag, throughput, error rate và DLQ rate.

## 7) Test Requirements (TR)

- `TR-01`: Integration test cho luồng producer và consumer.
- `TR-02`: Failure test cho luồng retry và DLQ.
- `TR-03`: Compatibility test cho schema evolution (`v1 -> v2`).
- `TR-04`: Load test có báo cáo throughput và latency.
- `TR-05`: Domain rule tests cho từng bounded context (aggregate invariants).

## 8) Acceptance Criteria

- Đặt 1 đơn hàng và quan sát trạng thái cuối qua `order-query-api`.
- Chủ động tiêm lỗi payment/inventory và quan sát retry + DLQ.
- Restart consumer trong lúc có traffic và xác minh hệ thống bắt kịp, không mất completed events.
- Publish schema v2 backward-compatible với v1 consumer, không vỡ runtime.
- Mỗi feature giao xong phải có traceability về requirement IDs trong PR hoặc delivery notes.
