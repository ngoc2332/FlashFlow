import { randomUUID } from "node:crypto";
import { Consumer, EachMessagePayload, Kafka, Producer } from "kafkajs";
import { Pool } from "pg";
import {
  EventEnvelope,
  HeaderValue,
  INVENTORY_EVENTS_TOPIC,
  MetricsRegistry,
  NonRetryableProcessingError,
  PAYMENT_EVENTS_TOPIC,
  PAYMENT_SUCCEEDED_EVENT,
  PaymentSucceededPayload,
  RetryPolicy,
  RetryableProcessingError,
  buildKafkaHeaders,
  closeMetricsServer,
  createDeterministicEventId,
  createInventoryRejectedEvent,
  createInventoryReservedEvent,
  createJsonLogger,
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
const rawMetricsPort = Number(process.env.INVENTORY_METRICS_PORT ?? 9402);
const metricsPort = Number.isFinite(rawMetricsPort) && rawMetricsPort > 0 ? rawMetricsPort : 9402;

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
  topics: [paymentEventsTopic, retryPolicy.retryTopic5s, retryPolicy.retryTopic1m],
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
        headers: buildKafkaHeaders({
          source: serviceName,
          traceId: inventoryEvent.traceId,
          eventId: inventoryEvent.eventId,
          orderId: inventoryEvent.orderId,
          schemaVersion: inventoryEvent.schemaVersion,
          eventKind: inventoryEvent.eventKind,
          eventType: inventoryEvent.eventType,
        }),
      },
    ],
  });

  producedEventsCounter.inc({
    service: serviceName,
    consumer_group: consumerGroup,
    topic: inventoryEventsTopic,
    event_type: inventoryEvent.eventType,
  });

  logger.info("inventory outcome published", {
    orderId: inventoryEvent.orderId,
    eventId: inventoryEvent.eventId,
    eventType: inventoryEvent.eventType,
    traceId: inventoryEvent.traceId,
    outputTopic: inventoryEventsTopic,
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

  if (payload.topic !== paymentEventsTopic && targetWorker !== serviceName) {
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

  let envelope: EventEnvelope<unknown> | undefined;

  try {
    envelope = parseEnvelope(payload.message.value);

    if (await hasProcessedEvent(envelope.eventId)) {
      duplicateEventsCounter.inc({
        service: serviceName,
        consumer_group: consumerGroup,
        topic: payload.topic,
      });
      logger.info("duplicate event skipped", {
        traceId: envelope.traceId,
        orderId: envelope.orderId,
        eventId: envelope.eventId,
        topic: payload.topic,
      });
      await commitOffset(payload);
      result = "duplicate";
      return;
    }

    const paymentSucceededEvent = parsePaymentSucceededEvent(envelope);

    if (!paymentSucceededEvent) {
      await commitOffset(payload);
      result = "ignored_event_type";
      return;
    }

    const decision = decideInventory(paymentSucceededEvent);

    await publishOutcome(paymentSucceededEvent, decision);
    await markProcessedEvent(envelope.eventId);
    await commitOffset(payload);

    processedEventsCounter.inc({
      service: serviceName,
      consumer_group: consumerGroup,
      topic: payload.topic,
      event_type: envelope.eventType,
    });
    result = "processed";
  } catch (rawError) {
    const error = rawError instanceof Error ? rawError : new Error("Unknown processing error");
    const orderId = envelope?.orderId ?? readOrderIdFromKey(payload.message);

    processingFailuresCounter.inc({
      service: serviceName,
      consumer_group: consumerGroup,
      topic: payload.topic,
      error_type: error.name,
    });

    const route = await routeToRetryOrDlq(payload, orderId, error);

    if (route.terminal && envelope) {
      await markProcessedEvent(envelope.eventId);
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

  await consumer.subscribe({ topic: paymentEventsTopic, fromBeginning: true });
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
      inputTopics: [paymentEventsTopic, retryPolicy.retryTopic5s, retryPolicy.retryTopic1m].join(","),
      outputTopic: inventoryEventsTopic,
    });
  });

  logger.info("service started", {
    brokers,
    metricsPort,
    reserveLimit,
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
        logger.error("inventory-worker failed to handle message", { error });
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
