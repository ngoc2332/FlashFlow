#!/usr/bin/env bash
set -euo pipefail

schema_registry_url="${SCHEMA_REGISTRY_URL:-http://localhost:8081}"
order_created_subject="${ORDER_CREATED_SUBJECT:-order.created-value}"
order_created_v1_schema_file="${ORDER_CREATED_V1_SCHEMA_FILE:-schemas/order.created/v1.json}"
order_created_v2_schema_file="${ORDER_CREATED_V2_SCHEMA_FILE:-schemas/order.created/v2.json}"

wait_for_schema_registry() {
  for _ in {1..60}; do
    if curl -sf "${schema_registry_url}/subjects" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "[phase4] schema-registry is not healthy: ${schema_registry_url}" >&2
  return 1
}

encode_schema_json_string() {
  local file="$1"
  sed 's/\\/\\\\/g; s/"/\\"/g' "${file}" | tr -d '\n'
}

set_compatibility_backward() {
  local endpoint="$1"
  local response

  response="$(curl -sS -X PUT "${endpoint}" \
    -H 'Content-Type: application/vnd.schemaregistry.v1+json' \
    --data '{"compatibility":"BACKWARD"}')"

  if ! echo "${response}" | grep -q '"compatibility":"BACKWARD"'; then
    echo "[phase4] failed to set BACKWARD compatibility on ${endpoint}: ${response}" >&2
    return 1
  fi
}

register_json_schema() {
  local subject="$1"
  local schema_file="$2"
  local schema_json
  local payload

  schema_json="$(encode_schema_json_string "${schema_file}")"
  payload="{\"schemaType\":\"JSON\",\"schema\":\"${schema_json}\"}"

  curl -sS -X POST "${schema_registry_url}/subjects/${subject}/versions" \
    -H 'Content-Type: application/vnd.schemaregistry.v1+json' \
    --data "${payload}"
}

assert_backward_compatible() {
  local subject="$1"
  local schema_file="$2"
  local schema_json
  local payload
  local response

  schema_json="$(encode_schema_json_string "${schema_file}")"
  payload="{\"schemaType\":\"JSON\",\"schema\":\"${schema_json}\"}"

  response="$(curl -sS -X POST "${schema_registry_url}/compatibility/subjects/${subject}/versions/latest" \
    -H 'Content-Type: application/vnd.schemaregistry.v1+json' \
    --data "${payload}")"

  if ! echo "${response}" | grep -q '"is_compatible":true'; then
    echo "[phase4] schema ${schema_file} is not backward compatible for ${subject}: ${response}" >&2
    return 1
  fi
}

if [[ ! -f "${order_created_v1_schema_file}" ]]; then
  echo "[phase4] missing schema file: ${order_created_v1_schema_file}" >&2
  exit 1
fi

if [[ ! -f "${order_created_v2_schema_file}" ]]; then
  echo "[phase4] missing schema file: ${order_created_v2_schema_file}" >&2
  exit 1
fi

wait_for_schema_registry
set_compatibility_backward "${schema_registry_url}/config"
set_compatibility_backward "${schema_registry_url}/config/${order_created_subject}"

v1_response="$(register_json_schema "${order_created_subject}" "${order_created_v1_schema_file}")"
if ! echo "${v1_response}" | grep -q '"id"'; then
  echo "[phase4] failed to register v1 schema for ${order_created_subject}: ${v1_response}" >&2
  exit 1
fi

echo "[phase4] registered order.created schema v1: ${v1_response}"

assert_backward_compatible "${order_created_subject}" "${order_created_v2_schema_file}"
v2_response="$(register_json_schema "${order_created_subject}" "${order_created_v2_schema_file}")"

if ! echo "${v2_response}" | grep -q '"id"'; then
  echo "[phase4] failed to register v2 schema for ${order_created_subject}: ${v2_response}" >&2
  exit 1
fi

echo "[phase4] backward compatibility check passed (v1 -> v2)"
echo "[phase4] registered order.created schema v2: ${v2_response}"
