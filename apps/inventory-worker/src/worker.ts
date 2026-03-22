import { randomUUID } from "node:crypto";
import { Consumer, EachMessagePayload, Kafka, Producer } from "kafkajs";
import {
  EventEnvelope,
  INVENTORY_EVENTS_TOPIC,
  PAYMENT_EVENTS_TOPIC,
  PAYMENT_SUCCEEDED_EVENT,
  PaymentSucceededPayload,
  createInventoryRejectedEvent,
  createInventoryReservedEvent,
} from "@flashflow/common";

class NonRetryableProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableProcessingError";
  }
}

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

const rawReserveLimit = Number(process.env.INVENTORY_RESERVE_LIMIT ?? 800);
const reserveLimit = Number.isFinite(rawReserveLimit) && rawReserveLimit > 0 ? rawReserveLimit : 800;

const kafka = new Kafka({ clientId, brokers });
const consumer: Consumer = kafka.consumer({ groupId: consumerGroup });
const producer: Producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });

type HeaderValue = Buffer | string | undefined;

function headerToString(value: HeaderValue): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }

  return undefined;
}

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

function parsePaymentSucceededEvent(event: EventEnvelope<unknown>): EventEnvelope<PaymentSucceededPayload> | undefined {
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

  if (typeof payload.totalAmount !== "number" || !Number.isFinite(payload.totalAmount) || payload.totalAmount <= 0) {
    throw new NonRetryableProcessingError("payment.succeeded payload.totalAmount must be a number > 0");
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

async function publishOutcome(
  event: EventEnvelope<PaymentSucceededPayload>,
  decision: InventoryDecision,
): Promise<void> {
  const inventoryEvent =
    decision.status === "reserved"
      ? createInventoryReservedEvent({
          orderId: event.orderId,
          userId: event.payload.userId,
          totalAmount: event.payload.totalAmount,
          traceId: event.traceId,
        })
      : createInventoryRejectedEvent({
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

async function handleMessage(payload: EachMessagePayload): Promise<void> {
  const targetWorker = headerToString(
    (payload.message.headers as Record<string, HeaderValue> | undefined)?.targetWorker,
  );

  if (targetWorker && targetWorker !== serviceName) {
    await commitOffset(payload);
    return;
  }

  const envelope = parseEnvelope(payload.message.value);
  const paymentSucceededEvent = parsePaymentSucceededEvent(envelope);

  if (!paymentSucceededEvent) {
    await commitOffset(payload);
    return;
  }

  const decision = decideInventory(paymentSucceededEvent);

  await publishOutcome(paymentSucceededEvent, decision);
  await commitOffset(payload);
}

async function start(): Promise<void> {
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({ topic: paymentEventsTopic, fromBeginning: true });

  console.log(
    `${serviceName} started: group=${consumerGroup}, inputTopic=${paymentEventsTopic}, outputTopic=${inventoryEventsTopic}`,
  );

  await consumer.run({
    autoCommit: false,
    eachMessage: async (payload) => {
      try {
        await handleMessage(payload);
      } catch (error) {
        if (error instanceof NonRetryableProcessingError) {
          console.error("inventory-worker skipped non-retryable event", error.message);
          await commitOffset(payload);
          return;
        }

        console.error("inventory-worker failed to handle message", error);
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
    console.error("inventory-worker consumer disconnect failed", error);
  }

  try {
    await producer.disconnect();
  } catch (error) {
    console.error("inventory-worker producer disconnect failed", error);
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
  console.error("inventory-worker failed to start", error);
  process.exit(1);
});
