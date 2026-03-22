import { Consumer, EachMessagePayload, Kafka, Producer } from "kafkajs";
import { Pool } from "pg";
import {
  EventEnvelope,
  HeaderValue,
  NonRetryableProcessingError,
  ORDER_CREATED_EVENT,
  OrderCreatedPayload,
  PAYMENT_EVENTS_TOPIC,
  RetryPolicy,
  RetryableProcessingError,
  createDeterministicEventId,
  createPaymentFailedEvent,
  createPaymentSucceededEvent,
  headerToString,
  nextOffset,
  normalizeHeaders,
  parseEventEnvelope,
  parseRetryCount,
  resolveRetryTarget,
} from "@flashflow/common";

const postgresUrl =
  process.env.POSTGRES_URL ?? "postgres://flashflow:flashflow@localhost:5432/flashflow";
const defaultKafkaBrokers = "localhost:9092";
const brokers = (process.env.KAFKA_BROKERS ?? defaultKafkaBrokers)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const serviceName = process.env.PAYMENT_SERVICE_NAME ?? "payment-worker";
const clientId = process.env.PAYMENT_CLIENT_ID ?? "flashflow-payment-worker";
const consumerGroup = process.env.PAYMENT_CONSUMER_GROUP ?? "payment-workers";
const paymentEventsTopic = process.env.PAYMENT_EVENTS_TOPIC ?? PAYMENT_EVENTS_TOPIC;

const retryPolicy: RetryPolicy = {
  retryTopic5s: process.env.RETRY_TOPIC_5S ?? "order.retry.5s",
  retryTopic1m: process.env.RETRY_TOPIC_1M ?? "order.retry.1m",
  dlqTopic: process.env.ORDER_DLQ_TOPIC ?? "order.dlq",
};

const failUserPrefix = process.env.PAYMENT_FAIL_USER_PREFIX ?? "fail-payment";

const parsedApprovalLimit = Number(process.env.PAYMENT_APPROVAL_LIMIT ?? 1000);
const approvalLimit =
  Number.isFinite(parsedApprovalLimit) && parsedApprovalLimit > 0 ? parsedApprovalLimit : 1000;

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

function parseOrderCreatedEvent(rawValue: Buffer | null): EventEnvelope<OrderCreatedPayload> {
  return parseEventEnvelope<OrderCreatedPayload>(rawValue, {
    expectedEventType: ORDER_CREATED_EVENT,
    parsePayload: (rawPayload) => {
      if (!rawPayload || typeof rawPayload !== "object") {
        throw new NonRetryableProcessingError("payload is required");
      }

      const payload = rawPayload as Partial<OrderCreatedPayload>;

      if (typeof payload.userId !== "string" || payload.userId.trim().length === 0) {
        throw new NonRetryableProcessingError("payload.userId is required");
      }

      if (
        typeof payload.totalAmount !== "number" ||
        !Number.isFinite(payload.totalAmount) ||
        payload.totalAmount <= 0
      ) {
        throw new NonRetryableProcessingError("payload.totalAmount must be a number > 0");
      }

      return {
        userId: payload.userId,
        totalAmount: payload.totalAmount,
      };
    },
  });
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
  event: EventEnvelope<OrderCreatedPayload>,
  decision: PaymentDecision,
): Promise<void> {
  const outputEventType =
    decision.status === "succeeded" ? "payment.succeeded" : "payment.failed";
  const outputEventId = createDeterministicEventId(`${event.eventId}:${outputEventType}`);

  const paymentEvent =
    decision.status === "succeeded"
      ? createPaymentSucceededEvent({
          eventId: outputEventId,
          orderId: event.orderId,
          userId: event.payload.userId,
          totalAmount: event.payload.totalAmount,
          traceId: event.traceId,
        })
      : createPaymentFailedEvent({
          eventId: outputEventId,
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

  if (payload.topic !== ORDER_CREATED_EVENT && targetWorker !== serviceName) {
    await commitOffset(payload);
    return;
  }

  let event: EventEnvelope<OrderCreatedPayload> | undefined;

  try {
    event = parseOrderCreatedEvent(payload.message.value);

    if (await hasProcessedEvent(event.eventId)) {
      console.log(`skip duplicated order.created eventId=${event.eventId}`);
      await commitOffset(payload);
      return;
    }

    const decision = decidePayment(event);
    await publishOutcome(event, decision);
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
  await consumer.subscribe({ topic: retryPolicy.retryTopic5s, fromBeginning: true });
  await consumer.subscribe({ topic: retryPolicy.retryTopic1m, fromBeginning: true });

  consumer.on(consumer.events.REBALANCING, () => {
    console.warn(`${serviceName} rebalancing started`);
  });

  consumer.on(consumer.events.GROUP_JOIN, () => {
    console.log(`${serviceName} group join completed`);
  });

  console.log(
    `${serviceName} started: group=${consumerGroup}, inputTopics=${ORDER_CREATED_EVENT},${retryPolicy.retryTopic5s},${retryPolicy.retryTopic1m}, outputTopic=${paymentEventsTopic}`,
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
        console.error("payment-worker failed to handle message", error);
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
      console.error("payment-worker consumer stop failed", error);
    }

    await waitForInflightDrain(30_000);

    if (runPromise) {
      try {
        await runPromise;
      } catch (error) {
        console.error("payment-worker run loop exited with error", error);
      }
    }

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

    try {
      await pool.end();
    } catch (error) {
      console.error("payment-worker postgres disconnect failed", error);
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
  console.error("payment-worker failed to start", error);
  void shutdown(1);
});
