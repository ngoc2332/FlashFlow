#!/usr/bin/env bash
set -euo pipefail

echo "[phase1] starting infra..."
docker compose up -d kafka schema-registry kafka-ui postgres redis

echo "[phase1] creating topics..."
./scripts/create-topics.sh

echo "[phase1] applying migrations..."
./scripts/migrate.sh

echo "[phase1] starting phase1 services..."
DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose --profile phase1 up -d --build order-api outbox-publisher

echo "[phase1] waiting for order-api health..."
for _ in {1..60}; do
  if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! curl -sf http://localhost:3000/health >/dev/null 2>&1; then
  echo "[phase1] order-api is not healthy"
  exit 1
fi

echo "[phase1] creating order..."
response="$(curl -sS -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -d '{"userId":"smoke-user","totalAmount":120.25}')"

echo "[phase1] create-order response: ${response}"

order_id="$(echo "${response}" | sed -n 's/.*"orderId":"\([^"]*\)".*/\1/p')"
if [[ -z "${order_id}" ]]; then
  echo "[phase1] failed to parse orderId from response"
  exit 1
fi

echo "[phase1] waiting for outbox publish marker..."
published_count="0"
for _ in {1..30}; do
  published_count="$(docker compose exec -T postgres psql -U flashflow -d flashflow -tA -c \
    "SELECT COUNT(*) FROM outbox_events WHERE aggregate_id='${order_id}'::uuid AND published_at IS NOT NULL;" \
    | tr -d '[:space:]')"

  if [[ "${published_count}" =~ ^[0-9]+$ ]] && [[ "${published_count}" -gt 0 ]]; then
    break
  fi
  sleep 1
done

if ! [[ "${published_count}" =~ ^[0-9]+$ ]] || [[ "${published_count}" -eq 0 ]]; then
  echo "[phase1] outbox published_at was not updated for order ${order_id}"
  exit 1
fi

echo "[phase1] checking kafka topic has at least one message..."
kafka_message="$(docker compose exec -T kafka kafka-console-consumer \
  --bootstrap-server kafka:29092 \
  --topic order.created \
  --from-beginning \
  --max-messages 1 \
  --timeout-ms 10000 2>/dev/null || true)"

if [[ -z "${kafka_message}" ]]; then
  echo "[phase1] no message found in order.created"
  exit 1
fi

echo "[phase1] kafka sample message: ${kafka_message}"
echo "[phase1] SUCCESS: phase 1 criteria passed"
