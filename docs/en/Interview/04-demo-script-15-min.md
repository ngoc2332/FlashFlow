# 15-Minute Demo Script

## 0:00 - 2:00: Architecture framing

1. Show bounded contexts and topic topology in `03-system-diagrams.md`.
2. Explain why partition key is `orderId` and why this system uses at-least-once + dedup.

## 2:00 - 5:00: Happy path end-to-end

1. Run:

```bash
make smoke-phase4
```

2. Call out event chain:
- `order.created`
- `payment.succeeded`
- `inventory.reserved`
- read model status query

## 5:00 - 8:00: Reliability behavior

1. Run:

```bash
make smoke-phase6
```

2. Highlight:
- retry to `order.retry.5s` and `order.retry.1m`
- terminal to `order.dlq`
- restart recovery without duplicated side effects

## 8:00 - 11:00: Observability and operations

1. Open Grafana (`http://localhost:3002`) and show:
- throughput
- error rate
- DLQ rate
- consumer lag

2. Open JSON logs and trace one order by `traceId`.

## 11:00 - 13:00: Performance baseline

1. Run:

```bash
TOTAL_REQUESTS=200 CONCURRENCY=20 make load-phase6
```

2. Show generated report: `docs/en/Interview/02-load-test-baseline.md`.

## 13:00 - 15:00: Tradeoff and incident Q&A

1. Pick one incident from `docs/en/Infra/02-observability-runbook.md`.
2. Explain root cause, detection signal, and safe mitigation path.
3. Conclude with next scaling levers (partitions, replicas, DB tuning).
