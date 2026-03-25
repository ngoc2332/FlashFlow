# Kịch Bản Demo 15 Phút

## 0:00 - 2:00: Giới thiệu kiến trúc

1. Mở sơ đồ trong `03-so-do-he-thong.md`.
2. Giải thích vì sao partition key là `orderId` và vì sao dùng at-least-once + dedup.

## 2:00 - 5:00: Happy path end-to-end

1. Chạy:

```bash
make smoke-phase4
```

2. Nhấn mạnh chuỗi event:
- `order.created`
- `payment.succeeded`
- `inventory.reserved`
- query read model status

## 5:00 - 8:00: Reliability behavior

1. Chạy:

```bash
make smoke-phase6
```

2. Trình bày:
- retry vào `order.retry.5s` và `order.retry.1m`
- vào `order.dlq` khi terminal
- restart worker vẫn không tạo side effect trùng

## 8:00 - 11:00: Observability và vận hành

1. Mở Grafana (`http://localhost:3002`) và show:
- throughput
- error rate
- DLQ rate
- consumer lag

2. Mở logs JSON và trace 1 order theo `traceId`.

## 11:00 - 13:00: Baseline performance

1. Chạy:

```bash
TOTAL_REQUESTS=200 CONCURRENCY=20 make load-phase6
```

2. Mở report: `docs/en/Interview/02-load-test-baseline.md`.

## 13:00 - 15:00: Q&A tradeoff và incident

1. Chọn 1 incident trong `docs/en/Infra/02-observability-runbook.md`.
2. Giải thích root cause, tín hiệu phát hiện, và cách xử lý an toàn.
3. Kết thúc bằng hướng scale tiếp theo (partition, replica, DB tuning).
