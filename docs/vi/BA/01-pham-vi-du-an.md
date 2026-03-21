# Phạm Vi Dự Án

## Ý tưởng sản phẩm
Xây dựng nền tảng sự kiện e-commerce realtime cho tải cao điểm flash sale.

Luồng nghiệp vụ chính:
`Order -> Payment -> Inventory -> Notification`

## Mục tiêu

- Luyện Kafka với các tình huống lỗi gần thực tế.
- Dựng local stack gần với kiến trúc production.
- Trình bày được system design và troubleshooting ở mức phỏng vấn.

## Phong cách kiến trúc

- Dùng `DDD` để chia domain thành các bounded context rõ ràng.
- Dùng `EDD` để lan truyền thay đổi trạng thái giữa các context qua event.
- Giữ business rule trong domain layer, hạ tầng để ở adapter layer.
- Bắt buộc docs-first delivery: bắt đầu từ requirement IDs trước khi code.

## Tiêu chí thành công

- Luồng đơn hàng end-to-end chạy đúng bằng async events.
- Retry và DLQ xử lý được lỗi tạm thời và poison message.
- Không mất sự kiện quan trọng trong các tình huống restart thông thường.
- Monitoring hiển thị được lag, throughput, error và DLQ rate.
- Mọi tính năng truy vết được về requirement trong docs.

## Trong phạm vi (phase 1 - vài ngày)

- 5 microservices:
  - `order-api`
  - `payment-worker`
  - `inventory-worker`
  - `notification-worker`
  - `order-query-api`
- Kafka core patterns: partition key, consumer group, retry/DLQ, idempotency, manual commit.
- Schema Registry với backward-compatible schema evolution.
- Postgres + Redis cho dữ liệu và tốc độ query.
- Quy trình code theo DDD + EDD với checklist triển khai.

## Ngoài phạm vi (phase 2)

- replication đa vùng (multi-region)
- exactly-once end-to-end cho toàn bộ service
- CI/CD đầy đủ và production deployment
- tích hợp cổng thanh toán bên ngoài thật
