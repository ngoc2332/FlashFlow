# Báo Cáo Baseline Load Test Phase 6

- Thời điểm (UTC): 2026-03-22T13:50:29Z
- Target URL: http://localhost:3000/orders
- Tổng request: 200
- Concurrency: 20

## Tóm tắt kết quả

- Request thành công (HTTP 201): 200
- Request lỗi: 0
- Tổng thời gian chạy: 65.597 s
- Throughput: 3.05 req/s
- p50 latency: 0.064 s
- p95 latency: 0.188 s

## Ghi chú

- Đây là baseline local để thảo luận trong interview.
- So sánh với NFR trong `docs/en/BA/02-requirements.md`.
- Cần tối ưu thêm (partition, replicas, batch, DB tuning) để tiến gần mục tiêu throughput cao hơn.
