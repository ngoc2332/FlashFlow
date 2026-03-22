import { randomUUID } from "node:crypto";
import { Consumer, EachMessagePayload, Kafka, Producer } from "kafkajs";
import { Pool } from "pg";
import {
  EventEnvelope,
  HeaderValue,
  INVENTORY_EVENTS_TOPIC,
  NonRetryableProcessingError,
  PAYMENT_EVENTS_TOPIC,
  PAYMENT_SUCCEEDED_EVENT,
  PaymentSucceededPayload,
  RetryPolicy,
  RetryableProcessingError,
  createDeterministicEventId,
  createInventoryRejectedEvent,
  createInventoryReservedEvent,
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

const serviceName = process.env.INVENTORY_SERVICE_NAME ?? "inventory-worker";
const clientId = process.env.INVENTORY_CLIENT_ID ?? "flashflow-inventory-worker";
const consumerGroup = process.env.INVENTORY_CONSUMER_GROUP ?? "inventory-workers";
const paymentEventsTopic = process.env.PAYMENT_EVENTS_TOPIC ?? PAYMENT_EVENTS_TOPIC;
const inventoryEventsTopic = process.env.INVENTORY_EVENTS_TOPIC ?? INVENTORY_EVENTS_TOPIC;
const rejectUserPrefix = process.env.INVENTORY_REJECT_USER_PREFIX ?? "reject-inventory";
const failUserPrefix = process.env.INVENTORY_FAIL_USER_PREFIX ?? "fail-inventory";

const retryPolicy: RetryPolicy = {
  retryTopic5s: process.env.RETRY_TOPIC_5S ?? "order.retry.5s",
  retryTopic1m: process.env.RETRY_TOPIC_1M ?? "order.retry.1m",
  dlqTopic: process.env.ORDER_DLQ_TOPIC ?? "order.dlq",
};

const rawReserveLimit = Number(process.env.INVENTORY_RESERVE_LIMIT ?? 800);
const reserveLimit = Number.isFinite(rawReserveLimit) && rawReserveLimit > 0 ? rawReserveLimit : 800;

const kafka = new Kafka({ clientId, brokers });
const pool = new Pool({ connectionString: postgresUrl });
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

function parseEnvelope(rawValue: Buffer | null): EventEnvelope<unknown> {
  return parseEventEnvelope(rawValue);
}

function parsePaymentSucceededEvent(
  event: EventEnvelope<unknown>,
): EventEnvelope<PaymentSucceededPayload> | undefined {
  if (event.eventType !== PAYMENT_SUCCEEDED_EVENT) {
    return undefined;
  }

  if (!event.payload || typeof event.payload !== "object") {
    throw new NonRetryableProcessingError("payment.succeeded payload is required");
  }

  const payload = event.payload as Partial<PaymentSucceededPayload>;

  if (typeof payload.userId !== "string" || payload.userId.trim().length === 0) {
    throw new NonRetryableProcessingError("payment.succeeded payload.userId is required");
  }

  if (
    typeof payload.totalAmount !== "number" ||
    !Number.isFinite(payload.totalAmount) ||
    payload.totalAmount <= 0
  ) {
    throw new NonRetryableProcessingError(
      "payment.succeeded payload.totalAmount must be a number > 0",
    );
  }

  return {
    ...event,
    payload: {
      userId: payload.userId,
      totalAmount: payload.totalAmount,
      paymentId:
        typeof payload.paymentId === "string" && payload.paymentId.trim().length > 0
          ? payload.paymentId
          : randomUUID(),
      provider:
        typeof payload.provider === "string" && payload.provider.trim().length > 0
          ? payload.provider
          : "mock-gateway",
    },
  };
}

type InventoryDecision =
  | {
      status: "reserved";
    }
  | {
      status: "rejected";
      reason: string;
    };

function decideInventory(event: EventEnvelope<PaymentSucceededPayload>): InventoryDecision {
  if (event.payload.userId.startsWith(failUserPrefix)) {
    throw new RetryableProcessingError("Mock inventory service timeout");
  }

  if (event.payload.userId.startsWith(rejectUserPrefix)) {
    return {
      status: "rejected",
      reason: "INVENTORY_REJECTED_BY_TEST_RULE",
    };
  }

  if (event.payload.totalAmount > reserveLimit) {
    return {
      status: "rejected",
      reason: "INVENTORY_OUT_OF_STOCK",
    };
  }

  return { status: "reserved" };
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

async function publishOutcome(
  event: EventEnvelope<PaymentSucceededPayload>,
  decision: InventoryDecision,
): Promise<void> {
  const outputEventType =
    decision.status === "reserved" ? "inventory.reserved" : "inventory.rejected";
  const outputEventId = createDeterministicEventId(`${event.eventId}:${outputEventType}`);

  const inventoryEvent =
    decision.status === "reserved"
      ? createInventoryReservedEvent({
          eventId: outputEventId,
          orderId: event.orderId,
          userId: event.payload.userId,
          totalAmount: event.payload.totalAmount,
          traceId: event.traceId,
        })
      : createInventoryRejectedEvent({
          eventId: outputEventId,
          orderId: event.orderId,
          userId: event.payload.userId,
          totalAmount: event.payload.totalAmount,
          traceId: event.traceId,
          reason: decision.reason,
        });

  await producer.send({
    topic: inventoryEventsTopic,
    messages: [
      {
        key: event.orderId,
        value: JSON.stringify(inventoryEvent),
        headers: {
          eventId: inventoryEvent.eventId,
          traceId: inventoryEvent.traceId,
          source: serviceName,
          schemaVersion: String(inventoryEvent.schemaVersion),
          eventKind: inventoryEvent.eventKind,
        },
      },
    ],
  });

  console.log(
    `published ${inventoryEvent.eventType} for order ${inventoryEvent.orderId} to ${inventoryEventsTopic}`,
  );
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

  if (payload.topic !== paymentEventsTopic && targetWorker !== serviceName) {
    await commitOffset(payload);
    return;
  }

  let envelope: EventEnvelope<unknown> | undefined;

  try {
    envelope = parseEnvelope(payload.message.value);

    if (await hasProcessedEvent(envelope.eventId)) {
      console.log(`skip duplicated inventory input eventId=${envelope.eventId}`);
      await commitOffset(payload);
      return;
    }

    const paymentSucceededEvent = parsePaymentSucceededEvent(envelope);

    if (!paymentSucceededEvent) {
      await commitOffset(payload);
      return;
    }

    const decision = decideInventory(paymentSucceededEvent);

    await publishOutcome(paymentSucceededEvent, decision);
    await markProcessedEvent(envelope.eventId);
    await commitOffset(payload);
  } catch (rawError) {
    const error = rawError instanceof Error ? rawError : new Error("Unknown processing error");
    const orderId = envelope?.orderId ?? readOrderIdFromKey(payload.message);

    const route = await routeToRetryOrDlq(payload, orderId, error);

    if (route.terminal && envelope) {
      await markProcessedEvent(envelope.eventId);
    }

    await commitOffset(payload);
  }
}

async function start(): Promise<void> {
  await producer.connect();
  await consumer.connect();

  await consumer.subscribe({ topic: paymentEventsTopic, fromBeginning: true });
  await consumer.subscribe({ topic: retryPolicy.retryTopic5s, fromBeginning: true });
  await consumer.subscribe({ topic: retryPolicy.retryTopic1m, fromBeginning: true });

  consumer.on(consumer.events.REBALANCING, () => {
    console.warn(`${serviceName} rebalancing started`);
  });

  consumer.on(consumer.events.GROUP_JOIN, () => {
    console.log(`${serviceName} group join completed`);
  });

  console.log(
    `${serviceName} started: group=${consumerGroup}, inputTopics=${paymentEventsTopic},${retryPolicy.retryTopic5s},${retryPolicy.retryTopic1m}, outputTopic=${inventoryEventsTopic}`,
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
        console.error("inventory-worker failed to handle message", error);
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
      console.error("inventory-worker consumer stop failed", error);
    }

    await waitForInflightDrain(30_000);

    if (runPromise) {
      try {
        await runPromise;
      } catch (error) {
        console.error("inventory-worker run loop exited with error", error);
      }
    }

    try {
      await consumer.disconnect();
    } catch (error) {
      console.error("inventory-worker consumer disconnect failed", error);
    }

    try {
      await producer.disconnect();
    } catch (error) {
      console.error("inventory-worker producer disconnect failed", error);
    }

    try {
      await pool.end();
    } catch (error) {
      console.error("inventory-worker postgres disconnect failed", error);
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
  console.error("inventory-worker failed to start", error);
  void shutdown(1);
});
