import { randomUUID } from "node:crypto";
import { Consumer, EachMessagePayload, Kafka, Producer } from "kafkajs";
import {
  EventEnvelope,
  OrderCreatedPayload,
  ORDER_CREATED_EVENT,
  PAYMENT_EVENTS_TOPIC,
  createPaymentFailedEvent,
  createPaymentSucceededEvent,
} from "@flashflow/common";

class RetryableProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableProcessingError";
  }
}

class NonRetryableProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableProcessingError";
  }
}

const defaultKafkaBrokers = "localhost:9092";
const brokers = (process.env.KAFKA_BROKERS ?? defaultKafkaBrokers)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const serviceName = process.env.PAYMENT_SERVICE_NAME ?? "payment-worker";
const clientId = process.env.PAYMENT_CLIENT_ID ?? "flashflow-payment-worker";
const consumerGroup = process.env.PAYMENT_CONSUMER_GROUP ?? "payment-workers";
const paymentEventsTopic = process.env.PAYMENT_EVENTS_TOPIC ?? PAYMENT_EVENTS_TOPIC;
const retryTopic5s = process.env.RETRY_TOPIC_5S ?? "order.retry.5s";
const retryTopic1m = process.env.RETRY_TOPIC_1M ?? "order.retry.1m";
const dlqTopic = process.env.ORDER_DLQ_TOPIC ?? "order.dlq";
const failUserPrefix = process.env.PAYMENT_FAIL_USER_PREFIX ?? "fail-payment";

const parsedApprovalLimit = Number(process.env.PAYMENT_APPROVAL_LIMIT ?? 1000);
const approvalLimit = Number.isFinite(parsedApprovalLimit) && parsedApprovalLimit > 0 ? parsedApprovalLimit : 1000;

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

function parseRetryCount(headers: Record<string, HeaderValue> | undefined): number {
  const raw = headers ? headerToString(headers.retryCount) : undefined;
  const retryCount = Number(raw ?? 0);

  if (!Number.isInteger(retryCount) || retryCount < 0) {
    return 0;
  }

  return retryCount;
}

function readOrderIdFromKey(message: EachMessagePayload["message"]): string {
  if (Buffer.isBuffer(message.key)) {
    return message.key.toString("utf8");
  }

  if (typeof message.key === "string") {
    return message.key;
  }

  return "unknown-order";
}

function normalizeHeaders(headers: Record<string, HeaderValue> | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }

  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    const parsed = headerToString(value);
    if (parsed !== undefined) {
      normalized[key] = parsed;
    }
  }

  return normalized;
}

function parseOrderCreatedEvent(rawValue: Buffer | null): EventEnvelope<OrderCreatedPayload> {
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

  const event = parsed as Partial<EventEnvelope<OrderCreatedPayload>>;

  if (event.eventType !== ORDER_CREATED_EVENT) {
    throw new NonRetryableProcessingError(`Unsupported eventType: ${String(event.eventType)}`);
  }

  if (typeof event.orderId !== "string" || event.orderId.trim().length === 0) {
    throw new NonRetryableProcessingError("orderId is required");
  }

  if (!event.payload || typeof event.payload !== "object") {
    throw new NonRetryableProcessingError("payload is required");
  }

  const payload = event.payload as Partial<OrderCreatedPayload>;

  if (typeof payload.userId !== "string" || payload.userId.trim().length === 0) {
    throw new NonRetryableProcessingError("payload.userId is required");
  }

  if (typeof payload.totalAmount !== "number" || !Number.isFinite(payload.totalAmount) || payload.totalAmount <= 0) {
    throw new NonRetryableProcessingError("payload.totalAmount must be a number > 0");
  }

  const traceId = typeof event.traceId === "string" && event.traceId.trim().length > 0 ? event.traceId : randomUUID();

  return {
    eventId: typeof event.eventId === "string" && event.eventId.trim().length > 0 ? event.eventId : randomUUID(),
    eventKind: event.eventKind === "domain" ? "domain" : "integration",
    eventType: ORDER_CREATED_EVENT,
    orderId: event.orderId,
    occurredAt:
      typeof event.occurredAt === "string" && event.occurredAt.trim().length > 0
        ? event.occurredAt
        : new Date().toISOString(),
    traceId,
    schemaVersion: typeof event.schemaVersion === "number" ? event.schemaVersion : 1,
    payload: {
      userId: payload.userId,
      totalAmount: payload.totalAmount,
    },
  };
}

type PaymentDecision =
  | {
      status: "succeeded";
    }
  | {
      status: "failed";
      reason: string;
      retryable: false;
    };

function decidePayment(event: EventEnvelope<OrderCreatedPayload>): PaymentDecision {
  if (event.payload.userId.startsWith(failUserPrefix)) {
    throw new RetryableProcessingError("Mock payment gateway timeout");
  }

  if (event.payload.totalAmount > approvalLimit) {
    return {
      status: "failed",
      reason: "PAYMENT_DECLINED_LIMIT_EXCEEDED",
      retryable: false,
    };
  }

  return { status: "succeeded" };
}

function resolveFailureTopic(error: Error, retryCount: number): string {
  if (!(error instanceof RetryableProcessingError)) {
    return dlqTopic;
  }

  if (retryCount === 0) {
    return retryTopic5s;
  }

  if (retryCount === 1) {
    return retryTopic1m;
  }

  return dlqTopic;
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

async function publishOutcome(event: EventEnvelope<OrderCreatedPayload>, decision: PaymentDecision): Promise<void> {
  const paymentEvent =
    decision.status === "succeeded"
      ? createPaymentSucceededEvent({
          orderId: event.orderId,
          userId: event.payload.userId,
          totalAmount: event.payload.totalAmount,
          traceId: event.traceId,
        })
      : createPaymentFailedEvent({
          orderId: event.orderId,
          userId: event.payload.userId,
          totalAmount: event.payload.totalAmount,
          reason: decision.reason,
          retryable: decision.retryable,
          traceId: event.traceId,
        });

  await producer.send({
    topic: paymentEventsTopic,
    messages: [
      {
        key: event.orderId,
        value: JSON.stringify(paymentEvent),
        headers: {
          eventId: paymentEvent.eventId,
          traceId: paymentEvent.traceId,
          source: serviceName,
          schemaVersion: String(paymentEvent.schemaVersion),
          eventKind: paymentEvent.eventKind,
        },
      },
    ],
  });

  console.log(
    `published ${paymentEvent.eventType} for order ${paymentEvent.orderId} to ${paymentEventsTopic}`,
  );
}

async function routeToRetryOrDlq(payload: EachMessagePayload, orderId: string, error: Error): Promise<void> {
  const retryCount = parseRetryCount(payload.message.headers as Record<string, HeaderValue> | undefined);
  const targetTopic = resolveFailureTopic(error, retryCount);
  const normalizedHeaders = normalizeHeaders(
    payload.message.headers as Record<string, HeaderValue> | undefined,
  );

  const nextRetryCount = error instanceof RetryableProcessingError ? retryCount + 1 : retryCount;
  const messageValue = payload.message.value ? payload.message.value.toString("utf8") : "{}";

  await producer.send({
    topic: targetTopic,
    messages: [
      {
        key: orderId,
        value: messageValue,
        headers: {
          ...normalizedHeaders,
          retryCount: String(nextRetryCount),
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

  await commitOffset(payload);

  console.error(
    `routed order ${orderId} to ${targetTopic} after error ${error.name}: ${error.message}`,
  );
}

async function handleMessage(payload: EachMessagePayload): Promise<void> {
  const targetWorker = headerToString(
    (payload.message.headers as Record<string, HeaderValue> | undefined)?.targetWorker,
  );

  if (payload.topic !== ORDER_CREATED_EVENT && targetWorker !== serviceName) {
    await commitOffset(payload);
    return;
  }

  let event: EventEnvelope<OrderCreatedPayload> | undefined;

  try {
    event = parseOrderCreatedEvent(payload.message.value);
    const decision = decidePayment(event);

    await publishOutcome(event, decision);
    await commitOffset(payload);
  } catch (rawError) {
    const error = rawError instanceof Error ? rawError : new Error("Unknown processing error");
    const orderId = event?.orderId ?? readOrderIdFromKey(payload.message);

    await routeToRetryOrDlq(payload, orderId, error);
  }
}

async function start(): Promise<void> {
  await producer.connect();
  await consumer.connect();

  await consumer.subscribe({ topic: ORDER_CREATED_EVENT, fromBeginning: true });
  await consumer.subscribe({ topic: retryTopic5s, fromBeginning: true });
  await consumer.subscribe({ topic: retryTopic1m, fromBeginning: true });

  console.log(
    `${serviceName} started: group=${consumerGroup}, inputTopics=${ORDER_CREATED_EVENT},${retryTopic5s},${retryTopic1m}, outputTopic=${paymentEventsTopic}`,
  );

  await consumer.run({
    autoCommit: false,
    eachMessage: async (payload) => {
      try {
        await handleMessage(payload);
      } catch (error) {
        console.error("payment-worker failed to handle message", error);
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
    console.error("payment-worker consumer disconnect failed", error);
  }

  try {
    await producer.disconnect();
  } catch (error) {
    console.error("payment-worker producer disconnect failed", error);
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
  console.error("payment-worker failed to start", error);
  process.exit(1);
});
