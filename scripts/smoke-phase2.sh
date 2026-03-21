#!/usr/bin/env bash
set -euo pipefail

echo "[phase2] starting infra..."
docker compose up -d kafka schema-registry kafka-ui postgres redis

echo "[phase2] creating topics..."
./scripts/create-topics.sh

echo "[phase2] applying migrations..."
./scripts/migrate.sh

echo "[phase2] starting phase2 services..."
DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose --profile phase2 up -d --build order-api outbox-publisher payment-worker

echo "[phase2] waiting for order-api health..."
for _ in {1..60}; do
  if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! curl -sf http://localhost:3000/health >/dev/null 2>&1; then
  echo "[phase2] order-api is not healthy"
  exit 1
fi

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

wait_for_payment_event() {
  local order_id="$1"
  local event_type="$2"
  local matched_line=""

  for _ in {1..30}; do
    local messages
    messages="$(docker compose exec -T kafka kafka-console-consumer \
      --bootstrap-server kafka:29092 \
      --topic payment.events \
      --from-beginning \
      --max-messages 200 \
      --timeout-ms 5000 2>/dev/null || true)"

    matched_line="$(echo "${messages}" | awk -v oid="${order_id}" -v et="${event_type}" '\
      index($0, "\"orderId\":\"" oid "\"") && index($0, "\"eventType\":\"" et "\"") { print; exit }')"

    if [[ -n "${matched_line}" ]]; then
      echo "[phase2] found ${event_type}: ${matched_line}"
      return 0
    fi

    sleep 1
  done

  echo "[phase2] did not find ${event_type} for order ${order_id}"
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
      --max-messages 200 \
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

success_order_id="$(new_uuid)"
failed_order_id="$(new_uuid)"
retry_order_id="$(new_uuid)"

echo "[phase2] case 1: success payment path"
create_order "${success_order_id}" "phase2-user-success" "120.25"
wait_for_payment_event "${success_order_id}" "payment.succeeded"

echo "[phase2] case 2: business failed payment path"
create_order "${failed_order_id}" "phase2-user-decline" "1500.00"
wait_for_payment_event "${failed_order_id}" "payment.failed"

echo "[phase2] case 3: retry then dlq path"
create_order "${retry_order_id}" "fail-payment-smoke" "110.00"
wait_for_dlq "${retry_order_id}"

echo "[phase2] SUCCESS: phase 2 criteria passed"
