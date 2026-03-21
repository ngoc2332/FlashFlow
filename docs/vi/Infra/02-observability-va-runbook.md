# Observability và Runbook

## Metrics cần expose

Application:
- request count / duration
- processed events count
- processing failure count
- retry count
- DLQ publish count

Kafka:
- consumer lag theo group/topic/partition
- messages in/out theo topic
- rebalance count

## Chuẩn logging

- JSON logs
- bao gồm `traceId`, `eventId`, `orderId`, `service`, `consumerGroup`
- log rõ business transition và nhóm lỗi

## Tracing

- OpenTelemetry instrumentation cho API và worker pipelines
- propagate `traceId` qua Kafka headers

## Mức cảnh báo cơ bản

- consumer lag cao > 5 phút
- DLQ rate tăng vọt so với baseline
- error rate của service vượt ngưỡng

## Runbook vận hành

1. Kiểm tra Kafka UI để xem lag và partition bị kẹt.
2. Kiểm tra logs theo `traceId` để tìm event type đang lỗi.
3. Xác minh tiến độ consume của retry topics.
4. Nếu DLQ tăng, lấy mẫu payload để phân loại root cause.
5. Sửa lỗi và replay DLQ an toàn (dùng replay tool/script có throttling).
