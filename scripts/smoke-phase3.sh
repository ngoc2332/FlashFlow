#!/usr/bin/env bash
set -euo pipefail

echo "[phase3] starting infra..."
docker compose up -d kafka schema-registry kafka-ui postgres redis

echo "[phase3] creating topics..."
./scripts/create-topics.sh

echo "[phase3] applying migrations..."
./scripts/migrate.sh

echo "[phase3] starting phase3 services..."
DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose --profile phase3 up -d --build order-api order-query-api outbox-publisher payment-worker inventory-worker order-status-updater

wait_for_health() {
  local name="$1"
  local url="$2"

  for _ in {1..60}; do
    if curl -sf "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  echo "[phase3] ${name} is not healthy"
  exit 1
}

echo "[phase3] waiting for APIs health..."
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
    echo "[phase3] create-order failed for ${order_id}, response=${response}"
    exit 1
  fi

  echo "[phase3] create-order response: ${response}"
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

  echo "[phase3] did not find ${event_type} for order ${order_id} in topic ${topic}" >&2
  return 1
}

wait_for_status() {
  local order_id="$1"
  local expected_status="$2"

  for _ in {1..40}; do
    local response
    response="$(curl -sS "http://localhost:3001/orders/${order_id}/status" || true)"

    if echo "${response}" | grep -q "\"status\":\"${expected_status}\""; then
      echo "[phase3] order ${order_id} status is ${expected_status}: ${response}"
      return 0
    fi

    sleep 1
  done

  echo "[phase3] status for order ${order_id} did not reach ${expected_status}"
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
      echo "[phase3] found dlq event: ${matched_line}"
      return 0
    fi

    sleep 1
  done

  echo "[phase3] did not find order ${order_id} in order.dlq"
  return 1
}

extract_event_id() {
  local event_line="$1"

  local event_id
  event_id="$(echo "${event_line}" | sed -n 's/.*"eventId":"\([^"]*\)".*/\1/p')"

  if [[ -z "${event_id}" ]]; then
    echo "[phase3] failed to extract eventId from line: ${event_line}" >&2
    return 1
  fi

  echo "${event_id}"
}

assert_processed_event() {
  local event_id="$1"
  local group="$2"

  local count
  count="$(docker compose exec -T postgres psql -U flashflow -d flashflow -Atc \
    "SELECT COUNT(*) FROM processed_events WHERE event_id='${event_id}'::uuid AND consumer_group='${group}';")"

  if [[ "${count}" != "1" ]]; then
    echo "[phase3] expected processed_events count=1 for eventId=${event_id}, group=${group}, got=${count}"
    exit 1
  fi

  echo "[phase3] processed_events check passed for eventId=${event_id}, group=${group}"
}

count_topic_events() {
  local topic="$1"
  local order_id="$2"
  local event_type="$3"

  local messages
  messages="$(docker compose exec -T kafka kafka-console-consumer \
    --bootstrap-server kafka:29092 \
    --topic "${topic}" \
    --from-beginning \
    --timeout-ms 5000 2>/dev/null || true)"

  echo "${messages}" | awk -v oid="${order_id}" -v et="${event_type}" '\
    index($0, "\"orderId\":\"" oid "\"") && index($0, "\"eventType\":\"" et "\"") { c++ }
    END { print c + 0 }'
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

success_order_id="$(new_uuid)"
inventory_retry_order_id="$(new_uuid)"
restart_order_id="$(new_uuid)"
invalid_updater_order_id="$(new_uuid)"

echo "[phase3] case 1: success + dedup by processed_events"
create_order "${success_order_id}" "phase3-user-success" "130.25"

order_created_line="$(wait_for_topic_event_line "order.created" "${success_order_id}" "order.created")"
payment_succeeded_line="$(wait_for_topic_event_line "payment.events" "${success_order_id}" "payment.succeeded")"
inventory_reserved_line="$(wait_for_topic_event_line "inventory.events" "${success_order_id}" "inventory.reserved")"
wait_for_status "${success_order_id}" "INVENTORY_RESERVED"

order_created_event_id="$(extract_event_id "${order_created_line}")"
payment_succeeded_event_id="$(extract_event_id "${payment_succeeded_line}")"
inventory_reserved_event_id="$(extract_event_id "${inventory_reserved_line}")"

assert_processed_event "${order_created_event_id}" "payment-workers"
assert_processed_event "${order_created_event_id}" "order-status-updaters"
assert_processed_event "${payment_succeeded_event_id}" "inventory-workers"
assert_processed_event "${payment_succeeded_event_id}" "order-status-updaters"
assert_processed_event "${inventory_reserved_event_id}" "order-status-updaters"

echo "[phase3] injecting duplicate order.created with the same eventId"
produce_message "order.created" "${success_order_id}" "${order_created_line}"
sleep 3

payment_succeeded_count="$(count_topic_events "payment.events" "${success_order_id}" "payment.succeeded")"
if [[ "${payment_succeeded_count}" != "1" ]]; then
  echo "[phase3] dedup failed: expected 1 payment.succeeded for ${success_order_id}, got ${payment_succeeded_count}"
  exit 1
fi

echo "[phase3] dedup check passed: payment.succeeded count=${payment_succeeded_count}"

echo "[phase3] case 2: standardized retry/DLQ on inventory-worker"
create_order "${inventory_retry_order_id}" "fail-inventory-smoke" "90.00"
wait_for_topic_event_line "payment.events" "${inventory_retry_order_id}" "payment.succeeded" >/dev/null
wait_for_dlq "${inventory_retry_order_id}"
wait_for_status "${inventory_retry_order_id}" "PAYMENT_SUCCEEDED"

echo "[phase3] case 3: non-retryable event routed to DLQ by order-status-updater"
invalid_updater_event="{\"orderId\":\"${invalid_updater_order_id}\",\"eventType\":\"inventory.reserved\",\"occurredAt\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\",\"traceId\":\"phase3-updater-trace\",\"payload\":{}}"
produce_message "inventory.events" "${invalid_updater_order_id}" "${invalid_updater_event}"
wait_for_dlq "${invalid_updater_order_id}"

echo "[phase3] case 4: graceful shutdown/restart safety"
docker compose --profile phase3 restart payment-worker inventory-worker order-status-updater
create_order "${restart_order_id}" "phase3-user-restart" "99.95"
wait_for_topic_event_line "payment.events" "${restart_order_id}" "payment.succeeded" >/dev/null
wait_for_topic_event_line "inventory.events" "${restart_order_id}" "inventory.reserved" >/dev/null
wait_for_status "${restart_order_id}" "INVENTORY_RESERVED"

echo "[phase3] SUCCESS: phase 3 reliability criteria passed"
