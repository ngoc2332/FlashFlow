import { Consumer, EachMessagePayload, Kafka, Producer } from "kafkajs";
import { Pool } from "pg";
import {
  EventEnvelope,
  HeaderValue,
  INVENTORY_EVENTS_TOPIC,
  INVENTORY_REJECTED_EVENT,
  INVENTORY_RESERVED_EVENT,
  NonRetryableProcessingError,
  ORDER_CREATED_EVENT,
  PAYMENT_EVENTS_TOPIC,
  PAYMENT_FAILED_EVENT,
  PAYMENT_SUCCEEDED_EVENT,
  RetryPolicy,
  headerToString,
  nextOffset,
  normalizeHeaders,
  parseEventEnvelope,
  parseRetryCount,
  resolveRetryTarget,
} from "@flashflow/common";

const postgresUrl =
  process.env.POSTGRES_URL ?? "postgres://flashflow:flashflow@localhost:5432/flashflow";
const brokers = (process.env.KAFKA_BROKERS ?? "localhost:9092")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const serviceName = process.env.STATUS_UPDATER_SERVICE_NAME ?? "order-status-updater";
const clientId = process.env.STATUS_UPDATER_CLIENT_ID ?? "flashflow-order-status-updater";
const consumerGroup = process.env.STATUS_UPDATER_CONSUMER_GROUP ?? "order-status-updaters";
const paymentEventsTopic = process.env.PAYMENT_EVENTS_TOPIC ?? PAYMENT_EVENTS_TOPIC;
const inventoryEventsTopic = process.env.INVENTORY_EVENTS_TOPIC ?? INVENTORY_EVENTS_TOPIC;
const orderStatusTopic = process.env.ORDER_STATUS_TOPIC ?? "order.status";

const retryPolicy: RetryPolicy = {
  retryTopic5s: process.env.RETRY_TOPIC_5S ?? "order.retry.5s",
  retryTopic1m: process.env.RETRY_TOPIC_1M ?? "order.retry.1m",
  dlqTopic: process.env.ORDER_DLQ_TOPIC ?? "order.dlq",
};

const statusByEventType: Record<string, string> = {
  [ORDER_CREATED_EVENT]: "PENDING_PAYMENT",
  [PAYMENT_SUCCEEDED_EVENT]: "PAYMENT_SUCCEEDED",
  [PAYMENT_FAILED_EVENT]: "PAYMENT_FAILED",
  [INVENTORY_RESERVED_EVENT]: "INVENTORY_RESERVED",
  [INVENTORY_REJECTED_EVENT]: "INVENTORY_REJECTED",
};

const pool = new Pool({ connectionString: postgresUrl });
const kafka = new Kafka({ clientId, brokers });
const consumer: Consumer = kafka.consumer({ groupId: consumerGroup });
const producer: Producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });

let isShuttingDown = false;
let inFlightMessages = 0;
let runPromise: Promise<void> | undefined;
let shutdownPromise: Promise<void> | undefined;

function readOrderIdFromKey(message: EachMessagePayload["message"]): string {
  if (Buffer.isBuffer(message.key)) {
    return message.key.toString("utf8");
  }

  if (typeof message.key === "string") {
    return message.key;
  }

  return "unknown-order";
}

async function commitOffset(payload: EachMessagePayload): Promise<void> {
  await consumer.commitOffsets([
    {
      topic: payload.topic,
      partition: payload.partition,
      offset: nextOffset(payload.message.offset),
    },
  ]);
}

function parseEnvelope(rawValue: Buffer | null): EventEnvelope<unknown> {
  return parseEventEnvelope(rawValue);
}

function resolveStatus(eventType: string): string | undefined {
  return statusByEventType[eventType];
}

interface UpsertResult {
  applied: boolean;
  currentStatus: string;
  lastEventId: string;
  lastUpdatedAt: string;
}

async function hasProcessedEvent(eventId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
     FROM processed_events
     WHERE event_id = $1::uuid
       AND consumer_group = $2
     LIMIT 1`,
    [eventId, consumerGroup],
  );

  return (result.rowCount ?? 0) > 0;
}

async function markProcessedEvent(eventId: string): Promise<void> {
  await pool.query(
    `INSERT INTO processed_events (event_id, consumer_group, processed_at)
     VALUES ($1::uuid, $2, NOW())
     ON CONFLICT (event_id, consumer_group) DO NOTHING`,
    [eventId, consumerGroup],
  );
}

async function upsertOrderStatus(
  event: EventEnvelope<unknown>,
  status: string,
): Promise<UpsertResult> {
  const parsedOccurredAt = Date.parse(event.occurredAt);
  if (Number.isNaN(parsedOccurredAt)) {
    throw new NonRetryableProcessingError("occurredAt is not a valid datetime");
  }

  const result = await pool.query<{
    current_status: string;
    last_event_id: string;
    last_updated_at: Date;
  }>(
    `INSERT INTO order_status_view (order_id, current_status, last_event_id, last_updated_at)
     VALUES ($1::uuid, $2, $3::uuid, $4::timestamptz)
     ON CONFLICT (order_id) DO UPDATE
     SET current_status = CASE
           WHEN EXCLUDED.last_updated_at >= order_status_view.last_updated_at THEN EXCLUDED.current_status
           ELSE order_status_view.current_status
         END,
         last_event_id = CASE
           WHEN EXCLUDED.last_updated_at >= order_status_view.last_updated_at THEN EXCLUDED.last_event_id
           ELSE order_status_view.last_event_id
         END,
         last_updated_at = GREATEST(order_status_view.last_updated_at, EXCLUDED.last_updated_at)
     RETURNING current_status, last_event_id, last_updated_at`,
    [event.orderId, status, event.eventId, event.occurredAt],
  );

  const row = result.rows[0];
  return {
    applied: row.last_event_id === event.eventId,
    currentStatus: row.current_status,
    lastEventId: row.last_event_id,
    lastUpdatedAt: row.last_updated_at.toISOString(),
  };
}

async function publishStatusSnapshot(
  event: EventEnvelope<unknown>,
  status: string,
  lastEventId: string,
  lastUpdatedAt: string,
): Promise<void> {
  const snapshot = {
    orderId: event.orderId,
    currentStatus: status,
    sourceEventType: event.eventType,
    lastEventId,
    traceId: event.traceId,
    updatedAt: lastUpdatedAt,
  };

  await producer.send({
    topic: orderStatusTopic,
    messages: [
      {
        key: event.orderId,
        value: JSON.stringify(snapshot),
        headers: {
          eventId: lastEventId,
          traceId: event.traceId,
          source: serviceName,
        },
      },
    ],
  });
}

async function routeToRetryOrDlq(
  payload: EachMessagePayload,
  orderId: string,
  error: Error,
): Promise<{ terminal: boolean; targetTopic: string }> {
  const headers = payload.message.headers as Record<string, HeaderValue> | undefined;
  const retryCount = parseRetryCount(headers);
  const route = resolveRetryTarget(error, retryCount, retryPolicy);
  const normalizedHeaders = normalizeHeaders(headers);
  const messageValue = payload.message.value ? payload.message.value.toString("utf8") : "{}";

  await producer.send({
    topic: route.topic,
    messages: [
      {
        key: orderId,
        value: messageValue,
        headers: {
          ...normalizedHeaders,
          retryCount: String(route.nextRetryCount),
          sourceTopic: payload.topic,
          sourceService: serviceName,
          targetWorker: serviceName,
          errorType: error.name,
          errorMessage: error.message,
          failedAt: new Date().toISOString(),
        },
      },
    ],
  });

  console.error(
    `routed order ${orderId} to ${route.topic} after error ${error.name}: ${error.message}`,
  );

  return {
    terminal: route.terminal,
    targetTopic: route.topic,
  };
}

async function handleMessage(payload: EachMessagePayload): Promise<void> {
  const headers = payload.message.headers as Record<string, HeaderValue> | undefined;
  const targetWorker = headerToString(headers?.targetWorker);

  const primaryTopics = new Set([ORDER_CREATED_EVENT, paymentEventsTopic, inventoryEventsTopic]);

  if (!primaryTopics.has(payload.topic) && targetWorker !== serviceName) {
    await commitOffset(payload);
    return;
  }

  let event: EventEnvelope<unknown> | undefined;

  try {
    event = parseEnvelope(payload.message.value);

    if (await hasProcessedEvent(event.eventId)) {
      console.log(`skip duplicated order status input eventId=${event.eventId}`);
      await commitOffset(payload);
      return;
    }

    const status = resolveStatus(event.eventType);

    if (!status) {
      await markProcessedEvent(event.eventId);
      await commitOffset(payload);
      return;
    }

    const upsertResult = await upsertOrderStatus(event, status);

    if (upsertResult.applied) {
      await publishStatusSnapshot(
        event,
        upsertResult.currentStatus,
        upsertResult.lastEventId,
        upsertResult.lastUpdatedAt,
      );
    }

    await markProcessedEvent(event.eventId);
    await commitOffset(payload);
  } catch (rawError) {
    const error = rawError instanceof Error ? rawError : new Error("Unknown processing error");
    const orderId = event?.orderId ?? readOrderIdFromKey(payload.message);

    const route = await routeToRetryOrDlq(payload, orderId, error);

    if (route.terminal && event) {
      await markProcessedEvent(event.eventId);
    }

    await commitOffset(payload);
  }
}

async function start(): Promise<void> {
  await producer.connect();
  await consumer.connect();

  await consumer.subscribe({ topic: ORDER_CREATED_EVENT, fromBeginning: true });
  await consumer.subscribe({ topic: paymentEventsTopic, fromBeginning: true });
  await consumer.subscribe({ topic: inventoryEventsTopic, fromBeginning: true });
  await consumer.subscribe({ topic: retryPolicy.retryTopic5s, fromBeginning: true });
  await consumer.subscribe({ topic: retryPolicy.retryTopic1m, fromBeginning: true });

  consumer.on(consumer.events.REBALANCING, () => {
    console.warn(`${serviceName} rebalancing started`);
  });

  consumer.on(consumer.events.GROUP_JOIN, () => {
    console.log(`${serviceName} group join completed`);
  });

  console.log(
    `${serviceName} started: group=${consumerGroup}, inputTopics=${ORDER_CREATED_EVENT},${paymentEventsTopic},${inventoryEventsTopic},${retryPolicy.retryTopic5s},${retryPolicy.retryTopic1m}, outputTopic=${orderStatusTopic}`,
  );

  runPromise = consumer.run({
    autoCommit: false,
    eachMessage: async (payload) => {
      if (isShuttingDown) {
        return;
      }

      inFlightMessages += 1;

      try {
        await handleMessage(payload);
      } catch (error) {
        console.error("order-status-updater failed to handle message", error);
      } finally {
        inFlightMessages -= 1;
      }
    },
  });

  await runPromise;
}

async function waitForInflightDrain(timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (inFlightMessages > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
}

async function shutdown(exitCode = 0): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    isShuttingDown = true;

    try {
      await consumer.stop();
    } catch (error) {
      console.error("order-status-updater consumer stop failed", error);
    }

    await waitForInflightDrain(30_000);

    if (runPromise) {
      try {
        await runPromise;
      } catch (error) {
        console.error("order-status-updater run loop exited with error", error);
      }
    }

    try {
      await consumer.disconnect();
    } catch (error) {
      console.error("order-status-updater consumer disconnect failed", error);
    }

    try {
      await producer.disconnect();
    } catch (error) {
      console.error("order-status-updater producer disconnect failed", error);
    }

    try {
      await pool.end();
    } catch (error) {
      console.error("order-status-updater postgres disconnect failed", error);
    }

    process.exit(exitCode);
  })();

  await shutdownPromise;
}

process.on("SIGINT", () => {
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});

void start().catch((error) => {
  console.error("order-status-updater failed to start", error);
  void shutdown(1);
});
