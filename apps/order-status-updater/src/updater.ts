import { Consumer, EachMessagePayload, Kafka, Producer } from "kafkajs";
import { Pool } from "pg";
import {
  EventEnvelope,
  HeaderValue,
  INVENTORY_EVENTS_TOPIC,
  INVENTORY_REJECTED_EVENT,
  INVENTORY_RESERVED_EVENT,
  MetricsRegistry,
  NonRetryableProcessingError,
  ORDER_CREATED_EVENT,
  PAYMENT_EVENTS_TOPIC,
  PAYMENT_FAILED_EVENT,
  PAYMENT_SUCCEEDED_EVENT,
  RetryPolicy,
  buildKafkaHeaders,
  closeMetricsServer,
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

const serviceName = process.env.STATUS_UPDATER_SERVICE_NAME ?? "order-status-updater";
const clientId = process.env.STATUS_UPDATER_CLIENT_ID ?? "flashflow-order-status-updater";
const consumerGroup = process.env.STATUS_UPDATER_CONSUMER_GROUP ?? "order-status-updaters";
const paymentEventsTopic = process.env.PAYMENT_EVENTS_TOPIC ?? PAYMENT_EVENTS_TOPIC;
const inventoryEventsTopic = process.env.INVENTORY_EVENTS_TOPIC ?? INVENTORY_EVENTS_TOPIC;
const orderStatusTopic = process.env.ORDER_STATUS_TOPIC ?? "order.status";
const rawMetricsPort = Number(process.env.STATUS_UPDATER_METRICS_PORT ?? 9403);
const metricsPort = Number.isFinite(rawMetricsPort) && rawMetricsPort > 0 ? rawMetricsPort : 9403;

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
  topics: [
    ORDER_CREATED_EVENT,
    paymentEventsTopic,
    inventoryEventsTopic,
    retryPolicy.retryTopic5s,
    retryPolicy.retryTopic1m,
  ],
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
        headers: buildKafkaHeaders({
          source: serviceName,
          traceId: event.traceId,
          eventId: lastEventId,
          orderId: event.orderId,
          eventType: event.eventType,
        }),
      },
    ],
  });

  producedEventsCounter.inc({
    service: serviceName,
    consumer_group: consumerGroup,
    topic: orderStatusTopic,
    event_type: event.eventType,
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

  const primaryTopics = new Set([ORDER_CREATED_EVENT, paymentEventsTopic, inventoryEventsTopic]);
  const startedAt = process.hrtime.bigint();
  let result = "success";

  if (!primaryTopics.has(payload.topic) && targetWorker !== serviceName) {
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

  let event: EventEnvelope<unknown> | undefined;

  try {
    event = parseEnvelope(payload.message.value);

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

    const status = resolveStatus(event.eventType);

    if (!status) {
      await markProcessedEvent(event.eventId);
      await commitOffset(payload);
      result = "ignored_event_type";
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
  await consumer.subscribe({ topic: paymentEventsTopic, fromBeginning: true });
  await consumer.subscribe({ topic: inventoryEventsTopic, fromBeginning: true });
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
      inputTopics: [
        ORDER_CREATED_EVENT,
        paymentEventsTopic,
        inventoryEventsTopic,
        retryPolicy.retryTopic5s,
        retryPolicy.retryTopic1m,
      ].join(","),
      outputTopic: orderStatusTopic,
    });
  });

  logger.info("service started", {
    brokers,
    metricsPort,
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
        logger.error("order-status-updater failed to handle message", { error });
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
