import { Kafka, Producer } from "kafkajs";
import { Pool, PoolClient } from "pg";
import {
  EventEnvelope,
  MetricsRegistry,
  buildKafkaHeaders,
  closeMetricsServer,
  createJsonLogger,
  startMetricsServer,
} from "@flashflow/common";

interface OutboxRow {
  id: string;
  event_id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
}

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

function resolveTopic(eventType: string): string {
  return eventType;
}

function readEnvelope(value: unknown): Partial<EventEnvelope<unknown>> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Partial<EventEnvelope<unknown>>;
}

async function fetchBatch(client: PoolClient): Promise<OutboxRow[]> {
  const result = await client.query<OutboxRow>(
    `SELECT id, event_id, aggregate_id, event_type, payload
     FROM outbox_events
     WHERE published_at IS NULL
     ORDER BY created_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [batchSize],
  );

  return result.rows;
}

async function updateOutboxBacklog(): Promise<void> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM outbox_events
     WHERE published_at IS NULL`,
  );

  const count = Number(result.rows[0]?.count ?? 0);
  outboxBacklogGauge.set({ service: serviceName }, Number.isFinite(count) ? count : 0);
}

async function publishOnce(): Promise<number> {
  const client = await pool.connect();
  const startedAt = process.hrtime.bigint();
  pollRunsCounter.inc({ service: serviceName });

  try {
    await client.query("BEGIN");
    const rows = await fetchBatch(client);

    if (rows.length === 0) {
      await client.query("COMMIT");
      return 0;
    }

    for (const row of rows) {
      const topic = resolveTopic(row.event_type);
      const envelope = readEnvelope(row.payload);
      const traceId =
        typeof envelope.traceId === "string" && envelope.traceId.trim().length > 0
          ? envelope.traceId
          : row.event_id;
      const eventType =
        typeof envelope.eventType === "string" && envelope.eventType.trim().length > 0
          ? envelope.eventType
          : row.event_type;
      const schemaVersion =
        typeof envelope.schemaVersion === "number" ? envelope.schemaVersion : 1;
      const eventKind = envelope.eventKind === "domain" ? "domain" : "integration";

      await producer.send({
        topic,
        messages: [
          {
            key: row.aggregate_id,
            value: JSON.stringify(row.payload),
            headers: buildKafkaHeaders({
              source: serviceName,
              traceId,
              eventId: row.event_id,
              orderId: row.aggregate_id,
              schemaVersion,
              eventKind,
              eventType,
            }),
          },
        ],
      });

      publishedEventsCounter.inc({
        service: serviceName,
        topic,
        event_type: eventType,
      });

      await client.query(
        `UPDATE outbox_events
         SET published_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [row.id],
      );
    }

    await client.query("COMMIT");
    publishDurationSeconds.observe(
      { service: serviceName, result: "success" },
      Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
    );
    return rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    publishFailuresCounter.inc({ service: serviceName });
    publishDurationSeconds.observe(
      { service: serviceName, result: "error" },
      Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
    );
    logger.error("outbox publish failed", { error });
    throw error;
  } finally {
    client.release();
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
