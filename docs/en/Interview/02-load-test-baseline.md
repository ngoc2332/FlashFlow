# Phase 6 Load Test Baseline

- Timestamp (UTC): 2026-03-22T13:50:29Z
- Target URL: http://localhost:3000/orders
- Total requests: 200
- Concurrency: 20

## Result summary

- Successful responses (HTTP 201): 200
- Failed responses: 0
- Total wall time: 65.597 s
- Throughput: 3.05 req/s
- p50 latency: 0.064 s
- p95 latency: 0.188 s

## Notes

- This is a local-machine baseline for interview discussion.
- Compare against project NFR targets in docs/en/BA/02-requirements.md.
- Re-run with higher load and tuned partitions/replicas for better throughput.
