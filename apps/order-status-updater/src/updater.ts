import { randomUUID } from "node:crypto";
import { Consumer, EachMessagePayload, Kafka, Producer } from "kafkajs";
import { Pool } from "pg";
import {
  EventEnvelope,
  INVENTORY_EVENTS_TOPIC,
  INVENTORY_REJECTED_EVENT,
  INVENTORY_RESERVED_EVENT,
  ORDER_CREATED_EVENT,
  PAYMENT_EVENTS_TOPIC,
  PAYMENT_FAILED_EVENT,
  PAYMENT_SUCCEEDED_EVENT,
} from "@flashflow/common";

class NonRetryableProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableProcessingError";
  }
}

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

function nextOffset(offset: string): string {
  return (BigInt(offset) + 1n).toString();
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
  if (!rawValue) {
    throw new NonRetryableProcessingError("Message value is empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue.toString("utf8"));
  } catch (error) {
    throw new NonRetryableProcessingError(
      `Message is not valid JSON: ${(error as Error).message}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new NonRetryableProcessingError("Event envelope must be an object");
  }

  const event = parsed as Partial<EventEnvelope<unknown>>;

  if (typeof event.orderId !== "string" || event.orderId.trim().length === 0) {
    throw new NonRetryableProcessingError("orderId is required");
  }

  if (typeof event.eventType !== "string" || event.eventType.trim().length === 0) {
    throw new NonRetryableProcessingError("eventType is required");
  }

  return {
    eventId:
      typeof event.eventId === "string" && event.eventId.trim().length > 0
        ? event.eventId
        : randomUUID(),
    eventKind: event.eventKind === "domain" ? "domain" : "integration",
    eventType: event.eventType,
    orderId: event.orderId,
    occurredAt:
      typeof event.occurredAt === "string" && event.occurredAt.trim().length > 0
        ? event.occurredAt
        : new Date().toISOString(),
    traceId:
      typeof event.traceId === "string" && event.traceId.trim().length > 0
        ? event.traceId
        : randomUUID(),
    schemaVersion: typeof event.schemaVersion === "number" ? event.schemaVersion : 1,
    payload: event.payload,
  };
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
     VALUES ($1, $2, $3::uuid, $4::timestamptz)
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

async function handleMessage(payload: EachMessagePayload): Promise<void> {
  const event = parseEnvelope(payload.message.value);
  const status = resolveStatus(event.eventType);

  if (!status) {
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

  await commitOffset(payload);
}

async function start(): Promise<void> {
  await producer.connect();
  await consumer.connect();

  await consumer.subscribe({ topic: ORDER_CREATED_EVENT, fromBeginning: true });
  await consumer.subscribe({ topic: paymentEventsTopic, fromBeginning: true });
  await consumer.subscribe({ topic: inventoryEventsTopic, fromBeginning: true });

  console.log(
    `${serviceName} started: group=${consumerGroup}, inputTopics=${ORDER_CREATED_EVENT},${paymentEventsTopic},${inventoryEventsTopic}, outputTopic=${orderStatusTopic}`,
  );

  await consumer.run({
    autoCommit: false,
    eachMessage: async (payload) => {
      try {
        await handleMessage(payload);
      } catch (error) {
        if (error instanceof NonRetryableProcessingError) {
          console.error("order-status-updater skipped non-retryable event", error.message);
          await commitOffset(payload);
          return;
        }

        console.error("order-status-updater failed to handle message", error);
      }
    },
  });
}

let isShuttingDown = false;

async function shutdown(): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

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

  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});

void start().catch((error) => {
  console.error("order-status-updater failed to start", error);
  process.exit(1);
});
