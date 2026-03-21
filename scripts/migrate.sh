#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required"
  exit 1
fi

echo "Waiting for postgres to be ready..."
for _ in {1..30}; do
  if docker compose exec -T postgres pg_isready -U flashflow -d flashflow >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

for file in db/migrations/*.sql; do
  echo "Applying migration: ${file}"
  docker compose exec -T postgres psql -U flashflow -d flashflow -v ON_ERROR_STOP=1 -f - < "${file}"
done

echo "Migrations applied"
