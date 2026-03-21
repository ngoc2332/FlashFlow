# Observability and Runbook

## Metrics to expose

Application:
- request count / duration
- processed events count
- processing failure count
- retry count
- DLQ publish count

Kafka:
- consumer lag by group/topic/partition
- messages in/out per topic
- rebalance count

## Logging standards

- JSON logs
- include `traceId`, `eventId`, `orderId`, `service`, `consumerGroup`
- log business transition and error category

## Tracing

- OpenTelemetry instrumentation for APIs and worker pipelines
- propagate `traceId` via Kafka headers

## Alert baseline

- high consumer lag for > 5 minutes
- DLQ rate spike over baseline
- error rate > threshold for a service

## Operational runbook

1. Check Kafka UI for lag and stuck partitions.
2. Check service logs for correlated `traceId` and failing event type.
3. Verify retry topic consumption progress.
4. If events in DLQ grow, inspect one sample payload and classify root cause.
5. Apply fix and replay DLQ safely (replay tool/script with throttling).
