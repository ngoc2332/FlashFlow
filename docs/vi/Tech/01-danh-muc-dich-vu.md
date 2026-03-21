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

Kafka:
- Consumer group: `payment-workers`

## 3) inventory-worker

Trách nhiệm:
- Consume `payment.succeeded`.
- Reserve/reject tồn kho bằng optimistic locking.
- Phát `inventory.reserved` hoặc `inventory.rejected`.

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

## Tóm tắt luồng event

1. `order-api` -> `order.created`
2. `payment-worker` -> `payment.succeeded|failed`
3. `inventory-worker` -> `inventory.reserved|rejected`
4. order-status updater consume status events và cập nhật read model
5. `notification-worker` consume selected events
