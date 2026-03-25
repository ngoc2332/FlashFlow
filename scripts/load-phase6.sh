#!/usr/bin/env bash
set -euo pipefail

TOTAL_REQUESTS="${TOTAL_REQUESTS:-200}"
CONCURRENCY="${CONCURRENCY:-20}"
TARGET_URL="${TARGET_URL:-http://localhost:3000/orders}"
ORDER_USER_PREFIX="${ORDER_USER_PREFIX:-phase6-load}"
ORDER_AMOUNT="${ORDER_AMOUNT:-99.99}"
REPORT_FILE="${REPORT_FILE:-docs/en/Interview/02-load-test-baseline.md}"

if ! command -v uuidgen >/dev/null 2>&1; then
  echo "[phase6-load] uuidgen is required" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "[phase6-load] curl is required" >&2
  exit 1
fi

if ! command -v xargs >/dev/null 2>&1; then
  echo "[phase6-load] xargs is required" >&2
  exit 1
fi

if ! curl -sf "${TARGET_URL%/orders}/health" >/dev/null 2>&1; then
  echo "[phase6-load] target API is not healthy: ${TARGET_URL%/orders}/health" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
result_file="${tmp_dir}/results.log"
trap 'rm -rf "${tmp_dir}"' EXIT

touch "${result_file}"

echo "[phase6-load] running load test: total=${TOTAL_REQUESTS}, concurrency=${CONCURRENCY}, target=${TARGET_URL}"

start_ns="$(date +%s%N)"

run_request() {
  local index="$1"
  local order_id
  order_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  local user_id="${ORDER_USER_PREFIX}-${index}"

  local response
  response="$(curl -sS -o /dev/null -w '%{http_code} %{time_total}' \
    -X POST "${TARGET_URL}" \
    -H 'Content-Type: application/json' \
    -d "{\"orderId\":\"${order_id}\",\"userId\":\"${user_id}\",\"totalAmount\":${ORDER_AMOUNT}}" || echo '000 30.000000')"

  printf '%s\n' "${response}" >> "${result_file}"
}

export TARGET_URL ORDER_USER_PREFIX ORDER_AMOUNT result_file
export -f run_request

seq 1 "${TOTAL_REQUESTS}" | xargs -I{} -P "${CONCURRENCY}" bash -lc 'run_request "$@"' _ {}

end_ns="$(date +%s%N)"

elapsed_seconds="$(awk -v s="${start_ns}" -v e="${end_ns}" 'BEGIN { printf "%.3f", (e-s)/1000000000 }')"
total="$(wc -l < "${result_file}" | tr -d ' ')"
success="$(awk '$1 == "201" { c++ } END { print c+0 }' "${result_file}")"
error_count="$((total - success))"
throughput="$(awk -v ok="${success}" -v elapsed="${elapsed_seconds}" 'BEGIN { if (elapsed <= 0) { print "0.00" } else { printf "%.2f", ok/elapsed } }')"

latency_file="${tmp_dir}/latency.log"
awk '$2 ~ /^[0-9.]+$/ { print $2 }' "${result_file}" | sort -n > "${latency_file}"

read_percentile() {
  local percentile="$1"
  awk -v p="${percentile}" '
    { values[NR] = $1 }
    END {
      if (NR == 0) {
        print "0.000"
        exit
      }

      rank = int((p / 100) * NR + 0.5)
      if (rank < 1) rank = 1
      if (rank > NR) rank = NR
      printf "%.3f", values[rank]
    }
  ' "${latency_file}"
}

p50="$(read_percentile 50)"
p95="$(read_percentile 95)"

timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

cat > "${REPORT_FILE}" <<REPORT
# Phase 6 Load Test Baseline

- Timestamp (UTC): ${timestamp}
- Target URL: ${TARGET_URL}
- Total requests: ${TOTAL_REQUESTS}
- Concurrency: ${CONCURRENCY}

## Result summary

- Successful responses (HTTP 201): ${success}
- Failed responses: ${error_count}
- Total wall time: ${elapsed_seconds} s
- Throughput: ${throughput} req/s
- p50 latency: ${p50} s
- p95 latency: ${p95} s

## Notes

- This is a local-machine baseline for interview discussion.
- Compare against project NFR targets in docs/en/BA/02-requirements.md.
- Re-run with higher load and tuned partitions/replicas for better throughput.
REPORT

echo "[phase6-load] SUCCESS: throughput=${throughput} req/s, p50=${p50}s, p95=${p95}s"
echo "[phase6-load] report written to ${REPORT_FILE}"
