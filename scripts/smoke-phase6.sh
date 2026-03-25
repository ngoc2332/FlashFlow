#!/usr/bin/env bash
set -euo pipefail

echo "[phase6] starting infra..."
docker compose up -d kafka schema-registry kafka-ui postgres redis

echo "[phase6] creating topics..."
./scripts/create-topics.sh

echo "[phase6] applying migrations..."
./scripts/migrate.sh

echo "[phase6] starting phase5/phase6 services..."
DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose --profile phase5 up -d --build order-api order-query-api outbox-publisher payment-worker inventory-worker order-status-updater prometheus grafana

wait_for_health() {
  local name="$1"
  local url="$2"

  for _ in {1..80}; do
    if curl -sf "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  echo "[phase6] ${name} is not healthy: ${url}" >&2
  return 1
}

wait_for_metric_line() {
  local name="$1"
  local url="$2"
  local pattern="$3"

  for _ in {1..60}; do
    if curl -sS "${url}" | grep -q "${pattern}"; then
      echo "[phase6] metric check passed: ${name} (${pattern})"
      return 0
    fi
    sleep 1
  done

  echo "[phase6] metric check failed: ${name} (${pattern})" >&2
  return 1
}

wait_for_prom_query() {
  local query="$1"

  for _ in {1..40}; do
    local response
    response="$(curl -sG --data-urlencode "query=${query}" http://localhost:9090/api/v1/query || true)"

    if echo "${response}" | grep -q '"status":"success"'; then
      echo "[phase6] prometheus query succeeded: ${query}"
      return 0
    fi

    sleep 1
  done

  echo "[phase6] prometheus query failed: ${query}" >&2
  return 1
}

new_uuid() {
  uuidgen | tr '[:upper:]' '[:lower:]'
}

create_order() {
  local order_id="$1"
  local user_id="$2"
  local total_amount="$3"

  local response
  response="$(curl -sS -X POST http://localhost:3000/orders \
    -H 'Content-Type: application/json' \
    -d "{\"orderId\":\"${order_id}\",\"userId\":\"${user_id}\",\"totalAmount\":${total_amount}}")"

  if ! echo "${response}" | grep -q "\"orderId\":\"${order_id}\""; then
    echo "[phase6] create-order failed for ${order_id}, response=${response}" >&2
    return 1
  fi

  echo "[phase6] create-order response: ${response}"
}

wait_for_topic_event_line() {
  local topic="$1"
  local order_id="$2"
  local event_type="$3"
  local matched_line=""

  for _ in {1..50}; do
    local messages
    messages="$(docker compose exec -T kafka kafka-console-consumer \
      --bootstrap-server kafka:29092 \
      --topic "${topic}" \
      --from-beginning \
      --timeout-ms 5000 2>/dev/null || true)"

    matched_line="$(echo "${messages}" | awk -v oid="${order_id}" -v et="${event_type}" '\
      index($0, "\"orderId\":\"" oid "\"") && index($0, "\"eventType\":\"" et "\"") { print; exit }')"

    if [[ -n "${matched_line}" ]]; then
      echo "${matched_line}"
      return 0
    fi

    sleep 1
  done

  echo "[phase6] did not find ${event_type} for order ${order_id} in topic ${topic}" >&2
  return 1
}

wait_for_status() {
  local order_id="$1"
  local expected_status="$2"

  for _ in {1..50}; do
    local response
    response="$(curl -sS "http://localhost:3001/orders/${order_id}/status" || true)"

    if echo "${response}" | grep -q "\"status\":\"${expected_status}\""; then
      echo "[phase6] order ${order_id} status is ${expected_status}: ${response}"
      return 0
    fi

    sleep 1
  done

  echo "[phase6] status for order ${order_id} did not reach ${expected_status}" >&2
  return 1
}

wait_for_dlq() {
  local order_id="$1"
  local matched_line=""

  for _ in {1..60}; do
    local messages
    messages="$(docker compose exec -T kafka kafka-console-consumer \
      --bootstrap-server kafka:29092 \
      --topic order.dlq \
      --from-beginning \
      --timeout-ms 5000 2>/dev/null || true)"

    matched_line="$(echo "${messages}" | awk -v oid="${order_id}" '\
      index($0, "\"orderId\":\"" oid "\"") { print; exit }')"

    if [[ -n "${matched_line}" ]]; then
      echo "[phase6] found dlq event: ${matched_line}"
      return 0
    fi

    sleep 1
  done

  echo "[phase6] did not find order ${order_id} in order.dlq" >&2
  return 1
}

echo "[phase6] waiting for core APIs and metrics endpoints..."
wait_for_health "order-api" "http://localhost:3000/health"
wait_for_health "order-query-api" "http://localhost:3001/health"
wait_for_health "outbox-publisher metrics" "http://localhost:9400/health"
wait_for_health "payment-worker metrics" "http://localhost:9401/health"
wait_for_health "inventory-worker metrics" "http://localhost:9402/health"
wait_for_health "order-status-updater metrics" "http://localhost:9403/health"
wait_for_health "prometheus" "http://localhost:9090/-/ready"
wait_for_health "grafana" "http://localhost:3002/api/health"

echo "[phase6] running unit tests for aggregate invariants..."
./scripts/unit-phase6.sh

echo "[phase6] case 1: integration test for produce/consume happy flow"
integration_order_id="$(new_uuid)"
create_order "${integration_order_id}" "phase6-user-success" "120.50"
wait_for_topic_event_line "payment.events" "${integration_order_id}" "payment.succeeded" >/dev/null
wait_for_topic_event_line "inventory.events" "${integration_order_id}" "inventory.reserved" >/dev/null
wait_for_status "${integration_order_id}" "INVENTORY_RESERVED"

echo "[phase6] case 2: failure test for retry -> DLQ path"
failure_order_id="$(new_uuid)"
create_order "${failure_order_id}" "fail-inventory-phase6" "90.00"
wait_for_topic_event_line "payment.events" "${failure_order_id}" "payment.succeeded" >/dev/null
wait_for_dlq "${failure_order_id}"
wait_for_status "${failure_order_id}" "PAYMENT_SUCCEEDED"
wait_for_metric_line "inventory dlq counter" "http://localhost:9402/metrics" "flashflow_worker_dlq_publishes_total{service=\"inventory-worker\""

echo "[phase6] case 3: restart recovery test"
docker compose --profile phase5 restart payment-worker inventory-worker order-status-updater
restart_order_id="$(new_uuid)"
create_order "${restart_order_id}" "phase6-user-restart" "99.95"
wait_for_topic_event_line "payment.events" "${restart_order_id}" "payment.succeeded" >/dev/null
wait_for_topic_event_line "inventory.events" "${restart_order_id}" "inventory.reserved" >/dev/null
wait_for_status "${restart_order_id}" "INVENTORY_RESERVED"

echo "[phase6] case 4: observability checks (metrics + prometheus scrape)"
wait_for_metric_line "order-api requests" "http://localhost:3000/metrics" "flashflow_http_requests_total"
wait_for_metric_line "payment processed events" "http://localhost:9401/metrics" "flashflow_worker_processed_events_total{service=\"payment-worker\""
wait_for_metric_line "status-updater lag" "http://localhost:9403/metrics" "flashflow_kafka_consumer_lag{service=\"order-status-updater\""
wait_for_prom_query "sum(flashflow_worker_processed_events_total)"

echo "[phase6] SUCCESS: unit + integration + failure + recovery + observability checks passed"
