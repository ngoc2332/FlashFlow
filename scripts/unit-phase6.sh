#!/usr/bin/env bash
set -euo pipefail

echo "[phase6-unit] running aggregate invariant tests in packages/common..."

docker compose exec -T order-api node <<'NODE'
const assert = require("node:assert/strict");
const {
  createDeterministicEventId,
  parseEventEnvelope,
  parseSchemaVersion,
  resolveRetryTarget,
  RetryableProcessingError,
  NonRetryableProcessingError,
} = require("/app/packages/common/dist/index.js");

let failed = false;

function test(name, fn) {
  try {
    fn();
    console.log(`[ok] ${name}`);
  } catch (error) {
    failed = true;
    console.error(`[failed] ${name}: ${error.message}`);
  }
}

test("parseSchemaVersion accepts undefined -> default 1", () => {
  assert.equal(parseSchemaVersion(undefined), 1);
});

test("parseSchemaVersion rejects non-positive values", () => {
  assert.throws(
    () => parseSchemaVersion(0),
    (error) => error instanceof NonRetryableProcessingError,
  );
});

test("parseEventEnvelope rejects invalid eventId UUID", () => {
  const event = {
    eventId: "not-a-uuid",
    eventKind: "integration",
    eventType: "order.created",
    orderId: "11111111-1111-4111-8111-111111111111",
    occurredAt: new Date().toISOString(),
    traceId: "trace-1",
    schemaVersion: 1,
    payload: { userId: "u-1", totalAmount: 10 },
  };

  assert.throws(
    () => parseEventEnvelope(Buffer.from(JSON.stringify(event))),
    (error) => error instanceof NonRetryableProcessingError,
  );
});

test("parseEventEnvelope parses valid message", () => {
  const event = {
    eventId: "11111111-1111-4111-8111-111111111111",
    eventKind: "integration",
    eventType: "order.created",
    orderId: "22222222-2222-4222-8222-222222222222",
    occurredAt: new Date().toISOString(),
    traceId: "trace-2",
    schemaVersion: 1,
    payload: { userId: "u-1", totalAmount: 10 },
  };

  const parsed = parseEventEnvelope(Buffer.from(JSON.stringify(event)));
  assert.equal(parsed.eventType, "order.created");
  assert.equal(parsed.orderId, "22222222-2222-4222-8222-222222222222");
});

test("resolveRetryTarget routes retryable errors to retry topics then DLQ", () => {
  const retryPolicy = {
    retryTopic5s: "order.retry.5s",
    retryTopic1m: "order.retry.1m",
    dlqTopic: "order.dlq",
  };

  const retryable = new RetryableProcessingError("temporary outage");

  assert.deepEqual(resolveRetryTarget(retryable, 0, retryPolicy), {
    topic: "order.retry.5s",
    nextRetryCount: 1,
    terminal: false,
  });

  assert.deepEqual(resolveRetryTarget(retryable, 1, retryPolicy), {
    topic: "order.retry.1m",
    nextRetryCount: 2,
    terminal: false,
  });

  assert.deepEqual(resolveRetryTarget(retryable, 2, retryPolicy), {
    topic: "order.dlq",
    nextRetryCount: 3,
    terminal: true,
  });
});

test("resolveRetryTarget routes non-retryable errors directly to DLQ", () => {
  const retryPolicy = {
    retryTopic5s: "order.retry.5s",
    retryTopic1m: "order.retry.1m",
    dlqTopic: "order.dlq",
  };

  const nonRetryable = new NonRetryableProcessingError("invalid payload");

  assert.deepEqual(resolveRetryTarget(nonRetryable, 0, retryPolicy), {
    topic: "order.dlq",
    nextRetryCount: 0,
    terminal: true,
  });
});

test("createDeterministicEventId returns stable UUID-like string", () => {
  const first = createDeterministicEventId("seed-1");
  const second = createDeterministicEventId("seed-1");
  const third = createDeterministicEventId("seed-2");

  assert.equal(first, second);
  assert.notEqual(first, third);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

if (failed) {
  process.exit(1);
}
NODE

echo "[phase6-unit] SUCCESS: aggregate invariant unit tests passed"
