import { Consumer, EachMessagePayload, Kafka, Producer } from "kafkajs";
import { Pool } from "pg";
import {
  EventEnvelope,
  HeaderValue,
  MetricsRegistry,
  NonRetryableProcessingError,
  ORDER_CREATED_EVENT,
  OrderCreatedPayload,
  PAYMENT_EVENTS_TOPIC,
  RetryPolicy,
  RetryableProcessingError,
  buildKafkaHeaders,
  closeMetricsServer,
  createDeterministicEventId,
  createJsonLogger,
  createPaymentFailedEvent,
  createPaymentSucceededEvent,
  headerToString,
  nextOffset,
  normalizeHeaders,
  parseEventEnvelope,
  parseRetryCount,
  resolveRetryTarget,
  resolveTraceIdFromKafkaHeaders,
  startConsumerLagCollector,
  startMetricsServer,
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
const rawMetricsPort = Number(process.env.PAYMENT_METRICS_PORT ?? 9401);
const metricsPort = Number.isFinite(rawMetricsPort) && rawMetricsPort > 0 ? rawMetricsPort : 9401;

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
const logger = createJsonLogger({
  service: serviceName,
  defaultFields: {
    consumerGroup,
  },
});
const metrics = new MetricsRegistry();

const processedEventsCounter = metrics.counter(
  "flashflow_worker_processed_events_total",
  "Total processed worker events",
  ["service", "consumer_group", "topic", "event_type"],
);
const duplicateEventsCounter = metrics.counter(
  "flashflow_worker_duplicate_events_total",
  "Total duplicate events skipped by worker",
  ["service", "consumer_group", "topic"],
);
const processingFailuresCounter = metrics.counter(
  "flashflow_worker_processing_failures_total",
  "Total worker processing failures",
  ["service", "consumer_group", "topic", "error_type"],
);
const retryEventsCounter = metrics.counter(
  "flashflow_worker_retry_publishes_total",
  "Total messages routed to retry topics",
  ["service", "consumer_group", "topic", "target_topic"],
);
const dlqEventsCounter = metrics.counter(
  "flashflow_worker_dlq_publishes_total",
  "Total messages routed to DLQ",
  ["service", "consumer_group", "topic"],
);
const producedEventsCounter = metrics.counter(
  "flashflow_worker_published_events_total",
  "Total worker output events published",
  ["service", "consumer_group", "topic", "event_type"],
);
const offsetCommitsCounter = metrics.counter(
  "flashflow_worker_offset_commits_total",
  "Total committed offsets by worker",
  ["service", "consumer_group", "topic"],
);
const rebalanceCounter = metrics.counter(
  "flashflow_worker_rebalances_total",
  "Total consumer rebalances",
  ["service", "consumer_group"],
);
const inflightGauge = metrics.gauge(
  "flashflow_worker_inflight_messages",
  "Current in-flight messages",
  ["service", "consumer_group"],
);
const processingDurationSeconds = metrics.histogram(
  "flashflow_worker_processing_duration_seconds",
  "Worker message processing duration in seconds",
  ["service", "consumer_group", "topic", "result"],
);

const metricsServer = startMetricsServer({
  port: metricsPort,
  service: serviceName,
  registry: metrics,
  logger,
});

const lagCollector = startConsumerLagCollector({
  kafka,
  service: serviceName,
  consumerGroup,
  topics: [ORDER_CREATED_EVENT, retryPolicy.retryTopic5s, retryPolicy.retryTopic1m],
  registry: metrics,
  logger,
});

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

  offsetCommitsCounter.inc({
    service: serviceName,
    consumer_group: consumerGroup,
    topic: payload.topic,
  });
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
        headers: buildKafkaHeaders({
          source: serviceName,
          traceId: paymentEvent.traceId,
          eventId: paymentEvent.eventId,
          orderId: paymentEvent.orderId,
          schemaVersion: paymentEvent.schemaVersion,
          eventKind: paymentEvent.eventKind,
          eventType: paymentEvent.eventType,
        }),
      },
    ],
  });

  producedEventsCounter.inc({
    service: serviceName,
    consumer_group: consumerGroup,
    topic: paymentEventsTopic,
    event_type: paymentEvent.eventType,
  });

  logger.info("payment outcome published", {
    orderId: paymentEvent.orderId,
    eventId: paymentEvent.eventId,
    eventType: paymentEvent.eventType,
    traceId: paymentEvent.traceId,
    outputTopic: paymentEventsTopic,
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
  const traceId =
    resolveTraceIdFromKafkaHeaders(headers) ?? normalizedHeaders.traceId ?? normalizedHeaders["x-trace-id"];

  await producer.send({
    topic: route.topic,
    messages: [
      {
        key: orderId,
        value: messageValue,
        headers: {
          ...normalizedHeaders,
          ...buildKafkaHeaders({
            source: serviceName,
            traceId,
            eventId: normalizedHeaders.eventId,
            orderId,
            eventType: normalizedHeaders.eventType,
          }),
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

  if (route.topic === retryPolicy.dlqTopic) {
    dlqEventsCounter.inc({
      service: serviceName,
      consumer_group: consumerGroup,
      topic: payload.topic,
    });
  } else {
    retryEventsCounter.inc({
      service: serviceName,
      consumer_group: consumerGroup,
      topic: payload.topic,
      target_topic: route.topic,
    });
  }

  logger.error("message routed to retry or dlq", {
    traceId,
    orderId,
    sourceTopic: payload.topic,
    targetTopic: route.topic,
    terminal: route.terminal,
    retryCount,
    error,
  });

  return {
    terminal: route.terminal,
    targetTopic: route.topic,
  };
}

async function handleMessage(payload: EachMessagePayload): Promise<void> {
  const headers = payload.message.headers as Record<string, HeaderValue> | undefined;
  const targetWorker = headerToString(headers?.targetWorker);
  const startedAt = process.hrtime.bigint();
  let result = "success";

  if (payload.topic !== ORDER_CREATED_EVENT && targetWorker !== serviceName) {
    await commitOffset(payload);
    result = "skipped_target_worker";
    processingDurationSeconds.observe(
      {
        service: serviceName,
        consumer_group: consumerGroup,
        topic: payload.topic,
        result,
      },
      Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
    );
    return;
  }

  let event: EventEnvelope<OrderCreatedPayload> | undefined;

  try {
    event = parseOrderCreatedEvent(payload.message.value);

    if (await hasProcessedEvent(event.eventId)) {
      duplicateEventsCounter.inc({
        service: serviceName,
        consumer_group: consumerGroup,
        topic: payload.topic,
      });
      logger.info("duplicate event skipped", {
        traceId: event.traceId,
        orderId: event.orderId,
        eventId: event.eventId,
        topic: payload.topic,
      });
      await commitOffset(payload);
      result = "duplicate";
      return;
    }

    const decision = decidePayment(event);
    await publishOutcome(event, decision);
    await markProcessedEvent(event.eventId);
    await commitOffset(payload);

    processedEventsCounter.inc({
      service: serviceName,
      consumer_group: consumerGroup,
      topic: payload.topic,
      event_type: event.eventType,
    });
    result = "processed";
  } catch (rawError) {
    const error = rawError instanceof Error ? rawError : new Error("Unknown processing error");
    const orderId = event?.orderId ?? readOrderIdFromKey(payload.message);

    processingFailuresCounter.inc({
      service: serviceName,
      consumer_group: consumerGroup,
      topic: payload.topic,
      error_type: error.name,
    });

    const route = await routeToRetryOrDlq(payload, orderId, error);

    if (route.terminal && event) {
      await markProcessedEvent(event.eventId);
    }

    await commitOffset(payload);
    result = route.terminal ? "routed_dlq" : "routed_retry";
  } finally {
    processingDurationSeconds.observe(
      {
        service: serviceName,
        consumer_group: consumerGroup,
        topic: payload.topic,
        result,
      },
      Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
    );
  }
}

async function start(): Promise<void> {
  await producer.connect();
  await consumer.connect();

  await consumer.subscribe({ topic: ORDER_CREATED_EVENT, fromBeginning: true });
  await consumer.subscribe({ topic: retryPolicy.retryTopic5s, fromBeginning: true });
  await consumer.subscribe({ topic: retryPolicy.retryTopic1m, fromBeginning: true });

  consumer.on(consumer.events.REBALANCING, () => {
    rebalanceCounter.inc({
      service: serviceName,
      consumer_group: consumerGroup,
    });
    logger.warn("consumer rebalancing started");
  });

  consumer.on(consumer.events.GROUP_JOIN, () => {
    logger.info("consumer group join completed", {
      inputTopics: [ORDER_CREATED_EVENT, retryPolicy.retryTopic5s, retryPolicy.retryTopic1m].join(","),
      outputTopic: paymentEventsTopic,
    });
  });

  logger.info("service started", {
    brokers,
    metricsPort,
    approvalLimit,
  });

  runPromise = consumer.run({
    autoCommit: false,
    eachMessage: async (payload) => {
      if (isShuttingDown) {
        return;
      }

      inFlightMessages += 1;
      inflightGauge.set(
        {
          service: serviceName,
          consumer_group: consumerGroup,
        },
        inFlightMessages,
      );

      try {
        await handleMessage(payload);
      } catch (error) {
        logger.error("payment-worker failed to handle message", { error });
      } finally {
        inFlightMessages -= 1;
        inflightGauge.set(
          {
            service: serviceName,
            consumer_group: consumerGroup,
          },
          inFlightMessages,
        );
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
      logger.error("consumer stop failed", { error });
    }

    await waitForInflightDrain(30_000);

    if (runPromise) {
      try {
        await runPromise;
      } catch (error) {
        logger.error("run loop exited with error", { error });
      }
    }

    try {
      await consumer.disconnect();
    } catch (error) {
      logger.error("consumer disconnect failed", { error });
    }

    try {
      await producer.disconnect();
    } catch (error) {
      logger.error("producer disconnect failed", { error });
    }

    try {
      await lagCollector.stop();
    } catch (error) {
      logger.warn("lag collector stop failed", { error });
    }

    try {
      await closeMetricsServer(metricsServer);
    } catch (error) {
      logger.warn("metrics server close failed", { error });
    }

    try {
      await pool.end();
    } catch (error) {
      logger.error("postgres disconnect failed", { error });
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
  logger.error("service failed to start", { error });
  void shutdown(1);
});
