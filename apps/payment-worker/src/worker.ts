import { Consumer, EachMessagePayload, Kafka, Producer } from "kafkajs";
import { Pool } from "pg";
import {
  EventEnvelope,
  MetricsRegistry,
  ORDER_CREATED_EVENT,
  OrderCreatedPayload,
  PAYMENT_EVENTS_TOPIC,
  RetryPolicy,
  closeMetricsServer,
  createJsonLogger,
  startConsumerLagCollector,
  startMetricsServer,
} from "@flashflow/common";
import { PaymentDecision } from "./domain/payment-policy";
import { processPaymentMessageUseCase } from "./application/process-payment-message.use-case";
import { commitMessageOffset } from "./infrastructure/offset-committer";
import { readOrderIdFromMessageKey } from "./infrastructure/order-key";
import {
  hasProcessedEvent as hasProcessedEventInStore,
  markProcessedEvent as markProcessedEventInStore,
} from "./infrastructure/processed-events-repository";
import {
  publishPaymentOutcome,
  routePaymentMessageToRetryOrDlq,
} from "./infrastructure/payment-outcome-publisher";

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

async function commitOffset(payload: EachMessagePayload): Promise<void> {
  await commitMessageOffset(consumer, payload);

  offsetCommitsCounter.inc({
    service: serviceName,
    consumer_group: consumerGroup,
    topic: payload.topic,
  });
}

async function publishOutcome(
  event: EventEnvelope<OrderCreatedPayload>,
  decision: PaymentDecision,
): Promise<void> {
  const published = await publishPaymentOutcome(producer, {
    serviceName,
    outputTopic: paymentEventsTopic,
    event,
    decision,
  });

  producedEventsCounter.inc({
    service: serviceName,
    consumer_group: consumerGroup,
    topic: paymentEventsTopic,
    event_type: published.eventType,
  });

  logger.info("payment outcome published", {
    orderId: published.orderId,
    eventId: published.eventId,
    eventType: published.eventType,
    traceId: published.traceId,
    outputTopic: paymentEventsTopic,
  });
}

async function routeToRetryOrDlq(
  payload: EachMessagePayload,
  orderId: string,
  error: Error,
): Promise<{ terminal: boolean; targetTopic: string; traceId: string; retryCount: number }> {
  const route = await routePaymentMessageToRetryOrDlq(producer, {
    serviceName,
    retryPolicy,
    payload,
    orderId,
    error,
  });

  if (route.targetTopic === retryPolicy.dlqTopic) {
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
      target_topic: route.targetTopic,
    });
  }

  return route;
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
        await processPaymentMessageUseCase({
          payload,
          serviceName,
          consumerGroup,
          orderCreatedTopic: ORDER_CREATED_EVENT,
          failUserPrefix,
          approvalLimit,
          hasProcessedEvent: (eventId) => hasProcessedEventInStore(pool, eventId, consumerGroup),
          markProcessedEvent: (eventId) => markProcessedEventInStore(pool, eventId, consumerGroup),
          commitOffset,
          readOrderIdFromMessageKey,
          publishOutcome,
          routeToRetryOrDlq,
          metrics: {
            processedEventsCounter,
            duplicateEventsCounter,
            processingFailuresCounter,
            processingDurationSeconds,
          },
          logger,
        });
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
