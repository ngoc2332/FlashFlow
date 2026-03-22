# Observability và Runbook

## Những gì đã có ở Phase 5

### Metrics

Các service expose metrics theo Prometheus format:

- `flashflow_http_requests_total`
- `flashflow_http_request_duration_seconds`
- `flashflow_orders_created_total`
- `flashflow_order_create_failures_total`
- `flashflow_order_query_results_total`
- `flashflow_outbox_published_events_total`
- `flashflow_outbox_publish_failures_total`
- `flashflow_outbox_unpublished_events`
- `flashflow_worker_processed_events_total`
- `flashflow_worker_processing_failures_total`
- `flashflow_worker_retry_publishes_total`
- `flashflow_worker_dlq_publishes_total`
- `flashflow_worker_rebalances_total`
- `flashflow_worker_processing_duration_seconds`
- `flashflow_kafka_consumer_lag`

### Chuẩn logging

Tất cả service log JSON line với các key chung:

- `timestamp`
- `level`
- `service`
- `message`
- `traceId` (nếu có)
- `eventId` (nếu có)
- `orderId` (nếu có)
- `consumerGroup` (cho worker)

### Tracing headers qua Kafka

Message Kafka được publish kèm:

- `traceId` và `x-trace-id`
- `eventId` và `x-event-id`
- `orderId` và `x-order-id`
- `traceparent` (nếu traceId hợp lệ dạng UUID)

## Điểm truy cập

- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3002` (`admin/admin`)
- Dashboard: `FlashFlow Phase 5 Overview`
- Metrics endpoints:
  - `http://localhost:3000/metrics`
  - `http://localhost:3001/metrics`
  - `http://localhost:9400/metrics`
  - `http://localhost:9401/metrics`
  - `http://localhost:9402/metrics`
  - `http://localhost:9403/metrics`

## Runbook sự cố

## 1. Consumer lag cao (> 5 phút)

1. Xác nhận lag trong Grafana panel `Kafka Consumer Lag`.
2. Xác định cặp service + topic đang tăng.
3. Xem logs worker tương ứng:

```bash
docker compose logs --tail=200 payment-worker inventory-worker order-status-updater
```

4. Kiểm tra lag có đi kèm retry hoặc DLQ không:

```bash
curl -s http://localhost:9401/metrics | grep flashflow_worker_retry_publishes_total
curl -s http://localhost:9401/metrics | grep flashflow_worker_dlq_publishes_total
```

5. Nếu worker lỗi trạng thái, restart đúng service đó:

```bash
docker compose --profile phase5 restart payment-worker
```

6. Theo dõi lại đồ thị lag, cần thấy xu hướng giảm.

## 2. Poison message lặp lại

Dấu hiệu:

- log JSON lặp `errorType/errorMessage`
- retry counter tăng nhanh
- cùng `orderId` xuất hiện nhiều ở retry topic

Các bước xử lý:

1. Lấy `traceId/orderId` bị lỗi từ logs.
2. Kiểm tra mẫu payload từ retry hoặc DLQ topic:

```bash
docker compose exec -T kafka kafka-console-consumer \
  --bootstrap-server kafka:29092 \
  --topic order.dlq \
  --from-beginning \
  --timeout-ms 5000
```

3. Phân loại nguyên nhân:
- lỗi contract/schema/payload -> sửa producer hoặc mapping
- reject theo business rule -> flow terminal hợp lệ
- lỗi phụ thuộc tạm thời -> giữ retry, chưa replay ngay

4. Deploy fix trước khi replay.

## 3. DLQ spike

1. Xác nhận spike ở panel `DLQ Publish Rate (events/s)`.
2. Tách theo service bằng query Prometheus:

```promql
sum by (service) (rate(flashflow_worker_dlq_publishes_total[5m]))
```

3. Xem lỗi gần nhất của service gây spike:

```bash
docker compose logs --tail=300 payment-worker | grep errorMessage
```

4. Nếu sự cố đang diễn ra mạnh, giảm tốc input tạm thời.
5. Sửa lỗi xong mới replay DLQ có throttling.

## Checklist replay DLQ an toàn

1. Chỉ replay sau khi đã fix root cause.
2. Replay theo batch nhỏ (50-100 event/lần).
3. Giữ nguyên `traceId/eventId/orderId` khi republish.
4. Theo dõi lag + error + DLQ khi replay.
5. Dừng ngay nếu DLQ tiếp tục tăng.
