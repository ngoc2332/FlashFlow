# Thiết Kế và Vận Hành Database

Tài liệu này định nghĩa tiêu chuẩn DB theo hướng production-like cho dự án.
Dùng cùng với:
- `Tech/03-thiet-ke-du-lieu-db-cache.md`
- `Tech/04-huong-dan-ddd-edd.md`
- `BA/02-yeu-cau.md`

## 1) Ownership DB theo bounded context

- `Order Management` sở hữu:
  - `orders`
  - `outbox_events`
  - `order_status_view` (service updater chịu trách nhiệm ghi)
- `Payment Processing` sở hữu:
  - `payment_attempts`
- `Inventory Management` sở hữu:
  - `inventory`
  - `inventory_reservations`
- Shared reliability ownership:
  - `processed_events` (lưu dấu dedup cho consumer)

Quy tắc:
- Một service sở hữu ghi dữ liệu cho bảng của nó.
- Service khác giao tiếp bằng event, không ghi chéo DB.

## 2) ERD logic (dạng text)

- `orders (order_id)` 1 --- n `outbox_events (aggregate_id)`
- `orders (order_id)` 1 --- 1 `order_status_view (order_id)`
- `inventory (sku)` 1 --- n `inventory_reservations (sku)`
- `processed_events (event_id, consumer_group)` theo dõi integration events đã xử lý

## 3) Quy ước schema

- Quy ước khóa chính:
  - `*_id` cho UUID/business identifiers
  - natural key chỉ dùng khi domain bắt buộc (`sku`)
- Timestamp:
  - dùng `timestamptz`
  - tối thiểu có `created_at`, `updated_at`
- Cột trạng thái:
  - dùng `text` + check constraint hoặc enum type
- Giá trị tiền:
  - dùng `numeric(18,2)`

## 4) Constraint và index bắt buộc

### Orders và outbox

- `orders.order_id` primary key
- `orders.status` index
- `orders.created_at` index
- `outbox_events.event_id` unique
- `outbox_events.aggregate_id, outbox_events.created_at` index
- `outbox_events.published_at` index (phục vụ polling publisher)

### Dedup và idempotency

- `processed_events` unique composite key:
  - `(event_id, consumer_group)`
- index tùy chọn:
  - `processed_at` cho cleanup jobs

### Tính đúng đắn tồn kho

- `inventory.sku` primary key
- `inventory.available_qty >= 0` check
- `inventory.reserved_qty >= 0` check
- `inventory.version` not null
- `inventory_reservations (order_id, sku)` unique

## 5) SQL patterns cốt lõi

### 5.1 Outbox transaction (một write boundary)

```sql
BEGIN;

INSERT INTO orders (order_id, user_id, status, total_amount, created_at, updated_at)
VALUES ($1, $2, 'PENDING_PAYMENT', $3, now(), now());

INSERT INTO outbox_events (id, event_id, aggregate_id, event_type, payload, created_at)
VALUES (gen_random_uuid(), $4, $1, 'order.created', $5::jsonb, now());

COMMIT;
```

### 5.2 Dedup gate cho consumer

```sql
INSERT INTO processed_events (event_id, consumer_group, processed_at)
VALUES ($1, $2, now())
ON CONFLICT (event_id, consumer_group) DO NOTHING;
```

Nếu số dòng insert = 0:
- xem là event trùng
- bỏ qua side effects
- commit offset an toàn

### 5.3 Optimistic locking cho inventory

```sql
UPDATE inventory
SET available_qty = available_qty - $1,
    reserved_qty = reserved_qty + $1,
    version = version + 1,
    updated_at = now()
WHERE sku = $2
  AND available_qty >= $1
  AND version = $3;
```

Nếu affected rows = 0:
- dữ liệu stale hoặc không đủ tồn
- phát rejection event

## 6) Tiêu chuẩn migration

- Dùng migration forward-only theo thứ tự timestamp.
- Mỗi migration phải có:
  - `up` SQL
  - `down` SQL hoặc ghi chú rollback rõ ràng
- Không sửa migration đã apply ở môi trường dùng chung.
- Với thay đổi breaking:
  - áp dụng chiến lược expand-contract
  - giữ read/write backward-compatible cho tới khi consumer nâng cấp xong

## 7) Vòng đời dữ liệu và bảo trì

- `outbox_events`:
  - publish xong thì mark `published_at`
  - archive hoặc purge theo retention window
- `processed_events`:
  - có cleanup job theo TTL (ví dụ 7-30 ngày)
- `order_status_view`:
  - có script rebuild từ canonical events khi cần

## 8) Checklist performance

- Xác minh index cho mọi query predicate tần suất cao.
- Chạy `EXPLAIN (ANALYZE, BUFFERS)` cho truy vấn quan trọng.
- Tránh join chéo bounded context ở online path.
- Batch read/write khi domain cho phép.
- Đặt ngưỡng slow query và lưu query plans.

## 9) Checklist review DB (Definition of Done)

- Có requirement mapping `FR/KR/DER/TR`.
- Tôn trọng aggregate transaction boundary.
- Có đủ constraint và index bắt buộc.
- Đã test outbox và dedup behavior.
- Đã test retry/DLQ path với kịch bản DB error.
- Migration có thể rollback hoặc có rollback note rõ ràng.
