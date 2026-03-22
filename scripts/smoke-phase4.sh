#!/usr/bin/env bash
set -euo pipefail

echo "[phase4] starting infra..."
docker compose up -d kafka schema-registry kafka-ui postgres redis

echo "[phase4] creating topics..."
./scripts/create-topics.sh

echo "[phase4] applying migrations..."
./scripts/migrate.sh

echo "[phase4] starting phase4 services..."
DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose --profile phase4 up -d --build order-api order-query-api outbox-publisher payment-worker inventory-worker order-status-updater

wait_for_health() {
  local name="$1"
  local url="$2"

  for _ in {1..60}; do
    if curl -sf "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  echo "[phase4] ${name} is not healthy" >&2
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
    echo "[phase4] create-order failed for ${order_id}, response=${response}" >&2
    return 1
  fi

  echo "[phase4] create-order response: ${response}"
}

wait_for_topic_event_line() {
  local topic="$1"
  local order_id="$2"
  local event_type="$3"
  local matched_line=""

  for _ in {1..40}; do
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

  echo "[phase4] did not find ${event_type} for order ${order_id} in topic ${topic}" >&2
  return 1
}

wait_for_status() {
  local order_id="$1"
  local expected_status="$2"

  for _ in {1..40}; do
    local response
    response="$(curl -sS "http://localhost:3001/orders/${order_id}/status" || true)"

    if echo "${response}" | grep -q "\"status\":\"${expected_status}\""; then
      echo "[phase4] order ${order_id} status is ${expected_status}: ${response}"
      return 0
    fi

    sleep 1
  done

  echo "[phase4] status for order ${order_id} did not reach ${expected_status}" >&2
  return 1
}

produce_message() {
  local topic="$1"
  local key="$2"
  local value="$3"

  printf '%s:%s\n' "${key}" "${value}" | docker compose exec -T kafka kafka-console-producer \
    --bootstrap-server kafka:29092 \
    --topic "${topic}" \
    --property parse.key=true \
    --property key.separator=: >/dev/null
}

echo "[phase4] waiting for APIs health..."
wait_for_health "order-api" "http://localhost:3000/health"
wait_for_health "order-query-api" "http://localhost:3001/health"

echo "[phase4] configuring schema registry governance..."
schema_subject="order-created-phase4-$(date +%s)-$(new_uuid)-value"
SCHEMA_REGISTRY_URL="http://localhost:8081" ORDER_CREATED_SUBJECT="${schema_subject}" ./scripts/schema-registry-phase4.sh

echo "[phase4] case 1: baseline v1 flow from order-api"
v1_order_id="$(new_uuid)"
create_order "${v1_order_id}" "phase4-user-v1" "140.75"
wait_for_topic_event_line "payment.events" "${v1_order_id}" "payment.succeeded" >/dev/null
wait_for_topic_event_line "inventory.events" "${v1_order_id}" "inventory.reserved" >/dev/null
wait_for_status "${v1_order_id}" "INVENTORY_RESERVED"

echo "[phase4] case 2: produce order.created v2 and verify v1 consumers still process"
v2_order_id="$(new_uuid)"
v2_event_id="$(new_uuid)"
v2_occurred_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
v2_trace_id="phase4-v2-${v2_event_id}"

v2_event="$(printf '{"eventId":"%s","eventKind":"integration","eventType":"order.created","orderId":"%s","occurredAt":"%s","traceId":"%s","schemaVersion":2,"payload":{"userId":"phase4-user-v2","totalAmount":91.25,"currency":"USD"}}' "${v2_event_id}" "${v2_order_id}" "${v2_occurred_at}" "${v2_trace_id}")"

produce_message "order.created" "${v2_order_id}" "${v2_event}"
wait_for_topic_event_line "payment.events" "${v2_order_id}" "payment.succeeded" >/dev/null
wait_for_topic_event_line "inventory.events" "${v2_order_id}" "inventory.reserved" >/dev/null
wait_for_status "${v2_order_id}" "INVENTORY_RESERVED"

echo "[phase4] SUCCESS: schema governance + v1->v2 compatibility checks passed"
