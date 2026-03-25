import { Kafka, Producer } from "kafkajs";
import { Pool } from "pg";
import {
  MetricsRegistry,
  closeMetricsServer,
  createJsonLogger,
  startMetricsServer,
} from "@flashflow/common";
import { publishOutboxBatchUseCase } from "./application/publish-outbox-batch.use-case";
import { countUnpublishedOutboxEvents } from "./infrastructure/outbox-repository";

const postgresUrl =
  process.env.POSTGRES_URL ?? "postgres://flashflow:flashflow@localhost:5432/flashflow";
const brokers = (process.env.KAFKA_BROKERS ?? "localhost:9092")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const clientId = process.env.OUTBOX_CLIENT_ID ?? "flashflow-outbox-publisher";
const pollIntervalMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1000);
const batchSize = Number(process.env.OUTBOX_BATCH_SIZE ?? 50);
const serviceName = process.env.OUTBOX_SERVICE_NAME ?? "outbox-publisher";
const rawMetricsPort = Number(process.env.OUTBOX_METRICS_PORT ?? 9400);
const metricsPort = Number.isFinite(rawMetricsPort) && rawMetricsPort > 0 ? rawMetricsPort : 9400;

const pool = new Pool({ connectionString: postgresUrl });

const kafka = new Kafka({ clientId, brokers });
const producer: Producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
const logger = createJsonLogger({ service: serviceName });
const metrics = new MetricsRegistry();

const pollRunsCounter = metrics.counter(
  "flashflow_outbox_poll_runs_total",
  "Total outbox poll runs",
  ["service"],
);
const publishedEventsCounter = metrics.counter(
  "flashflow_outbox_published_events_total",
  "Total outbox events published to Kafka",
  ["service", "topic", "event_type"],
);
const publishFailuresCounter = metrics.counter(
  "flashflow_outbox_publish_failures_total",
  "Total outbox publish failures",
  ["service"],
);
const publishDurationSeconds = metrics.histogram(
  "flashflow_outbox_publish_duration_seconds",
  "Outbox publish duration in seconds",
  ["service", "result"],
);
const outboxBacklogGauge = metrics.gauge(
  "flashflow_outbox_unpublished_events",
  "Current number of unpublished outbox events",
  ["service"],
);

let timer: NodeJS.Timeout | undefined;
let isRunning = false;
const metricsServer = startMetricsServer({
  port: metricsPort,
  service: serviceName,
  registry: metrics,
  logger,
});

async function updateOutboxBacklog(): Promise<void> {
  const client = await pool.connect();
  try {
    const count = await countUnpublishedOutboxEvents(client);
    outboxBacklogGauge.set({ service: serviceName }, count);
  } finally {
    client.release();
  }
}

async function publishOnce(): Promise<number> {
  const startedAt = process.hrtime.bigint();
  pollRunsCounter.inc({ service: serviceName });

  try {
    const processed = await publishOutboxBatchUseCase({
      pool,
      producer,
      serviceName,
      batchSize,
      publishedEventsCounter,
    });
    publishDurationSeconds.observe(
      { service: serviceName, result: "success" },
      Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
    );
    return processed;
  } catch (error) {
    publishFailuresCounter.inc({ service: serviceName });
    publishDurationSeconds.observe(
      { service: serviceName, result: "error" },
      Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
    );
    logger.error("outbox publish failed", { error });
    throw error;
  }
}

async function tick(): Promise<void> {
  if (isRunning) {
    return;
  }

  isRunning = true;
  try {
    const processed = await publishOnce();
    await updateOutboxBacklog();
    if (processed > 0) {
      logger.info("outbox events published", { processed });
    }
  } catch (error) {
    logger.error("outbox tick failed", { error });
  } finally {
    isRunning = false;
  }
}

async function start(): Promise<void> {
  await producer.connect();
  logger.info("service started", {
    pollIntervalMs,
    batchSize,
    brokers,
  });

  await updateOutboxBacklog();
  await tick();
  timer = setInterval(() => {
    void tick();
  }, pollIntervalMs);
}

async function shutdown(): Promise<void> {
  if (timer) {
    clearInterval(timer);
  }

  try {
    await closeMetricsServer(metricsServer);
  } catch (error) {
    logger.warn("metrics server close failed", { error });
  }

  await producer.disconnect();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

void start().catch((error) => {
  logger.error("service start failed", { error });
  void shutdown();
});
