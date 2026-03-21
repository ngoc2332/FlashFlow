# Thiết Kế Dữ Liệu, DB và Cache

## Lựa chọn database

- Database chính: `PostgreSQL`
- Lý do: ACID transactions, constraint, indexing, hệ sinh thái tooling mạnh.

## Lựa chọn cache

- Cache: `Redis`
- Lý do: đọc nhanh, dedup/idempotency key đơn giản, TTL linh hoạt.

## Quy tắc persistence theo DDD

- Một transaction chỉ bảo toàn nhất quán trong phạm vi một aggregate.
- Không join chéo bounded context trong domain logic.
- Ghi business data + outbox trong cùng transaction.
- Cập nhật read model theo hướng bất đồng bộ bằng event.

## Các bảng Postgres cốt lõi

### `orders`

- `order_id` (PK)
- `user_id`
- `status`
- `total_amount`
- `created_at`, `updated_at`

Indexes:
- `idx_orders_status`
- `idx_orders_created_at`

### `outbox_events`

- `id` (PK)
- `event_id` (unique)
- `aggregate_id` (`order_id`)
- `event_type`
- `payload` (jsonb)
- `published_at` (nullable)
- `created_at`

Pattern:
- ghi business row + outbox row trong cùng transaction
- process publisher riêng send sang Kafka và đánh dấu `published_at`

### `processed_events`

- `event_id` (PK)
- `consumer_group`
- `processed_at`

Mục đích:
- consumer dedup cho at-least-once delivery
- insert trước, nếu unique-violation thì bỏ qua vì trùng lặp

### `inventory`

- `sku` (PK)
- `available_qty`
- `reserved_qty`
- `version`

Kỹ thuật:
- optimistic locking qua `version`
- tránh oversell khi cập nhật đồng thời

### `order_status_view`

- `order_id` (PK)
- `current_status`
- `last_event_id`
- `last_updated_at`

Mục đích:
- read model query nhanh cho `order-query-api`

## Thiết kế Redis key

- `order:status:{orderId}` -> trạng thái hiện tại đã serialize, TTL 60-300s
- `idem:{consumerGroup}:{eventId}` -> marker đã xử lý, TTL 1-7d

## Nguyên tắc DB/Cache

- Postgres là source of truth.
- Redis chỉ là lớp tăng tốc.
- Khi có status update event:
  - cập nhật `order_status_view`
  - invalidation hoặc refresh Redis key
