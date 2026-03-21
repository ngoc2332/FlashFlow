#!/usr/bin/env bash
set -euo pipefail

echo "Waiting for kafka to be ready..."
for _ in {1..30}; do
  if docker compose exec -T kafka kafka-topics --bootstrap-server kafka:29092 --list >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

create_topic() {
  local name="$1"
  local partitions="$2"

  docker compose exec -T kafka kafka-topics \
    --bootstrap-server kafka:29092 \
    --create \
    --if-not-exists \
    --topic "${name}" \
    --partitions "${partitions}" \
    --replication-factor 1
}

create_topic "order.created" 6
create_topic "order.retry.5s" 3
create_topic "order.retry.1m" 3
create_topic "order.dlq" 3
create_topic "order.status" 6

echo "Topics are ready"
