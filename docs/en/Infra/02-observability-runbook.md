# Observability and Runbook

## What is instrumented in Phase 5

### Metrics

Application and worker metrics are exposed in Prometheus format:

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

### Logging standard

All services log JSON lines with shared keys:

- `timestamp`
- `level`
- `service`
- `message`
- `traceId` (when available)
- `eventId` (when available)
- `orderId` (when available)
- `consumerGroup` (for workers)

### Tracing headers across Kafka

Produced Kafka messages now include:

- `traceId` and `x-trace-id`
- `eventId` and `x-event-id`
- `orderId` and `x-order-id`
- `traceparent` (when traceId is UUID-compatible)

## Access points

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

## Incident runbooks

## 1. High consumer lag (> 5 minutes)

1. Confirm lag in Grafana panel `Kafka Consumer Lag`.
2. Identify service + topic pair with growth trend.
3. Inspect worker logs by service:

```bash
docker compose logs --tail=200 payment-worker inventory-worker order-status-updater
```

4. Check if lag is tied to retries or DLQ:

```bash
curl -s http://localhost:9401/metrics | grep flashflow_worker_retry_publishes_total
curl -s http://localhost:9401/metrics | grep flashflow_worker_dlq_publishes_total
```

5. If consumer is unhealthy, restart the affected worker only:

```bash
docker compose --profile phase5 restart payment-worker
```

6. Re-check lag slope; it should flatten and decrease.

## 2. Poison message loop

Symptoms:

- repeated identical `errorType/errorMessage` in JSON logs
- retry counters increase quickly
- same `orderId` appears in retry topics

Actions:

1. Find a failing trace/order in logs.
2. Verify payload sample from retry or DLQ topic:

```bash
docker compose exec -T kafka kafka-console-consumer \
  --bootstrap-server kafka:29092 \
  --topic order.dlq \
  --from-beginning \
  --timeout-ms 5000
```

3. Classify root cause:
- contract error -> fix producer/schema/payload mapping
- business rule rejection -> expected terminal flow
- transient dependency timeout -> keep retry path, do not replay yet

4. Deploy fix, then replay only impacted events.

## 3. DLQ spike

1. Validate spike in panel `DLQ Publish Rate (events/s)`.
2. Break down by service using Prometheus query:

```promql
sum by (service) (rate(flashflow_worker_dlq_publishes_total[5m]))
```

3. For top offender service, inspect latest errors:

```bash
docker compose logs --tail=300 payment-worker | grep errorMessage
```

4. If issue is ongoing and harmful, reduce input pressure temporarily by pausing producer side.
5. Fix, then replay DLQ with throttling.

## Safe DLQ replay checklist

1. Replay only after root cause is fixed.
2. Replay in small batches (for example 50-100 records).
3. Preserve original `traceId/eventId/orderId` headers when republishing.
4. Monitor lag + error + DLQ panels during replay.
5. Stop replay immediately if DLQ slope increases again.
