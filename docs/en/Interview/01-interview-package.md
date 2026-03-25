# Interview Package

## 1) What this project proves

- You can design event-driven microservices with Kafka.
- You understand reliability patterns: outbox, retries, DLQ, dedup.
- You can reason about consistency, ordering, and failure recovery.
- You can apply DDD and EDD in a pragmatic production-like architecture.
- You can operate systems with metrics, logs, tracing, and runbooks.

## 2) Key talking points

- Why partition by `orderId` (ordering vs parallelism tradeoff).
- Why at-least-once + dedup is practical for business systems.
- Why outbox is safer than direct DB + Kafka dual write.
- Why compacted `order.status` helps build latest-state consumers.
- How bounded contexts reduce coupling between services.
- How event contracts support independent evolution across teams.

## 3) Five incident playbooks

### Incident A: Duplicate event processed

- Symptom: one order reserved stock twice.
- Cause: at-least-once redelivery after consumer restart.
- Fix: `processed_events` dedup with unique `eventId`.

### Incident B: Rebalance storm

- Symptom: lag increases during scale up/down.
- Cause: frequent consumer restarts / slow shutdown.
- Fix: graceful shutdown and reduce churn in deployments.

### Incident C: Poison message

- Symptom: same partition keeps failing on one record.
- Cause: bad payload or hard business-rule failure.
- Fix: classify non-retryable errors and route to DLQ immediately.

### Incident D: Schema breaking change

- Symptom: consumer deserialization failure after deployment.
- Cause: incompatible event schema update.
- Fix: Schema Registry backward compatibility checks in CI.

### Incident E: Lag spike at peak traffic

- Symptom: end-to-end latency breaches p95 target.
- Cause: under-partitioned topic or slow DB writes.
- Fix: scale consumer replicas, tune partitions, batch writes where safe.

## 4) Suggested 15-minute demo flow

1. Show architecture diagram with bounded contexts and topic map.
2. Create an order and follow events in Kafka UI.
3. Inject a failure and show retry then DLQ.
4. Show metrics dashboard and lag behavior.
5. Explain one incident with DDD/EDD tradeoff decisions.

## 5) Phase 6 assets checklist

- Test strategy and command map: `docs/en/Interview/02-phase6-test-strategy.md`
- System diagrams (context + sequence): `docs/en/Interview/03-system-diagrams.md`
- 15-minute demo script: `docs/en/Interview/04-demo-script-15-min.md`
- Load test baseline report: `docs/en/Interview/02-load-test-baseline.md`

## 6) Quick commands

```bash
make unit-phase6
make smoke-phase6
TOTAL_REQUESTS=200 CONCURRENCY=20 make load-phase6
```
