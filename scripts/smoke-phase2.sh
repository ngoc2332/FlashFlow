#!/usr/bin/env bash
set -euo pipefail

echo "[phase2] starting infra..."
docker compose up -d kafka schema-registry kafka-ui postgres redis

echo "[phase2] creating topics..."
./scripts/create-topics.sh

echo "[phase2] applying migrations..."
./scripts/migrate.sh

echo "[phase2] starting phase2 services..."
DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose --profile phase2 up -d --build order-api order-query-api outbox-publisher payment-worker inventory-worker order-status-updater

wait_for_health() {
  local name="$1"
  local url="$2"

  for _ in {1..60}; do
    if curl -sf "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  echo "[phase2] ${name} is not healthy"
  exit 1
}

echo "[phase2] waiting for APIs health..."
wait_for_health "order-api" "http://localhost:3000/health"
wait_for_health "order-query-api" "http://localhost:3001/health"

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
    echo "[phase2] create-order failed for ${order_id}, response=${response}"
    exit 1
  fi

  echo "[phase2] create-order response: ${response}"
}

wait_for_topic_event() {
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
      echo "[phase2] found ${event_type} in ${topic}: ${matched_line}"
      return 0
    fi

    sleep 1
  done

  echo "[phase2] did not find ${event_type} for order ${order_id} in topic ${topic}"
  return 1
}

wait_for_dlq() {
  local order_id="$1"
  local matched_line=""

  for _ in {1..40}; do
    local messages
    messages="$(docker compose exec -T kafka kafka-console-consumer \
      --bootstrap-server kafka:29092 \
      --topic order.dlq \
      --from-beginning \
      --timeout-ms 5000 2>/dev/null || true)"

    matched_line="$(echo "${messages}" | awk -v oid="${order_id}" '\
      index($0, "\"orderId\":\"" oid "\"") { print; exit }')"

    if [[ -n "${matched_line}" ]]; then
      echo "[phase2] found dlq event: ${matched_line}"
      return 0
    fi

    sleep 1
  done

  echo "[phase2] did not find order ${order_id} in order.dlq"
  return 1
}

wait_for_status() {
  local order_id="$1"
  local expected_status="$2"

  for _ in {1..40}; do
    local response
    response="$(curl -sS "http://localhost:3001/orders/${order_id}/status" || true)"

    if echo "${response}" | grep -q "\"status\":\"${expected_status}\""; then
      echo "[phase2] order ${order_id} status is ${expected_status}: ${response}"
      return 0
    fi

    sleep 1
  done

  echo "[phase2] status for order ${order_id} did not reach ${expected_status}"
  return 1
}

success_order_id="$(new_uuid)"
payment_failed_order_id="$(new_uuid)"
inventory_rejected_order_id="$(new_uuid)"
retry_order_id="$(new_uuid)"

echo "[phase2] case 1: success path to inventory.reserved"
create_order "${success_order_id}" "phase2-user-success" "120.25"
wait_for_topic_event "payment.events" "${success_order_id}" "payment.succeeded"
wait_for_topic_event "inventory.events" "${success_order_id}" "inventory.reserved"
wait_for_status "${success_order_id}" "INVENTORY_RESERVED"

echo "[phase2] case 2: payment failed path"
create_order "${payment_failed_order_id}" "phase2-user-decline" "1500.00"
wait_for_topic_event "payment.events" "${payment_failed_order_id}" "payment.failed"
wait_for_status "${payment_failed_order_id}" "PAYMENT_FAILED"

echo "[phase2] case 3: inventory rejected path"
create_order "${inventory_rejected_order_id}" "reject-inventory-smoke" "120.00"
wait_for_topic_event "payment.events" "${inventory_rejected_order_id}" "payment.succeeded"
wait_for_topic_event "inventory.events" "${inventory_rejected_order_id}" "inventory.rejected"
wait_for_status "${inventory_rejected_order_id}" "INVENTORY_REJECTED"

echo "[phase2] case 4: retry then dlq path"
create_order "${retry_order_id}" "fail-payment-smoke" "110.00"
wait_for_dlq "${retry_order_id}"
wait_for_status "${retry_order_id}" "PENDING_PAYMENT"

echo "[phase2] SUCCESS: phase 2 criteria passed"
