# Danh Mục Dịch Vụ

## Mapping bounded context

- `Order Management`: `order-api`, order-status updater, `order-query-api`
- `Payment Processing`: `payment-worker`
- `Inventory Management`: `inventory-worker`
- `Customer Communication`: `notification-worker`

## 1) order-api

Trách nhiệm:
- Nhận request tạo đơn hàng.
- Ghi dữ liệu aggregate đơn hàng vào Postgres.
- Ghi outbox event trong cùng DB transaction.

Input/Output:
- `POST /orders`
- Phát `order.created`

## 2) payment-worker

Trách nhiệm:
- Consume `order.created`.
- Chạy logic thanh toán mock.
- Phát `payment.succeeded` hoặc `payment.failed`.
- Dedup event đã xử lý qua `processed_events`.
- Manual commit offset chỉ sau khi xử lý thành công hoặc route retry/DLQ terminal.
- Xử lý retry topics (`order.retry.5s`, `order.retry.1m`) và DLQ cuối (`order.dlq`).

Kafka:
- Consumer group: `payment-workers`

## 3) inventory-worker

Trách nhiệm:
- Consume `payment.succeeded`.
- Reserve/reject tồn kho bằng optimistic locking.
- Phát `inventory.reserved` hoặc `inventory.rejected`.
- Dedup event đã xử lý qua `processed_events`.
- Manual commit offset chỉ sau khi xử lý thành công hoặc route retry/DLQ terminal.
- Xử lý retry topics (`order.retry.5s`, `order.retry.1m`) và DLQ cuối (`order.dlq`).

Kafka:
- Consumer group: `inventory-workers`

## 4) notification-worker

Trách nhiệm:
- Consume các event quan trọng/cuối luồng.
- Gửi email/SMS/push mock.
- Lưu kết quả gửi thông báo.

Kafka:
- Consumer group: `notification-workers`

## 5) order-query-api

Trách nhiệm:
- Trả trạng thái đơn hàng nhanh.
- Đọc từ Postgres read model kết hợp Redis cache.

Input/Output:
- `GET /orders/{orderId}/status`

## 6) order-status-updater

Trách nhiệm:
- Consume các event điều khiển trạng thái (`order.created`, `payment.events`, `inventory.events`).
- Cập nhật `order_status_view` và publish snapshot `order.status`.
- Dedup event đã xử lý qua `processed_events`.
- Manual commit offset chỉ sau khi upsert DB + publish snapshot thành công.
- Xử lý retry topics (`order.retry.5s`, `order.retry.1m`) và DLQ cuối (`order.dlq`).

Kafka:
- Consumer group: `order-status-updaters`

## Tóm tắt luồng event

1. `order-api` -> `order.created`
2. `payment-worker` -> `payment.succeeded|failed`
3. `inventory-worker` -> `inventory.reserved|rejected`
4. order-status updater consume status events và cập nhật read model
5. `notification-worker` consume selected events
