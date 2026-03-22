import { Kafka, Producer } from "kafkajs";
import { Pool, PoolClient } from "pg";
import { EventEnvelope } from "@flashflow/common";

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

const pool = new Pool({ connectionString: postgresUrl });

const kafka = new Kafka({ clientId, brokers });
const producer: Producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });

let timer: NodeJS.Timeout | undefined;
let isRunning = false;

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

async function publishOnce(): Promise<number> {
  const client = await pool.connect();

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

      await producer.send({
        topic,
        messages: [
          {
            key: row.aggregate_id,
            value: JSON.stringify(row.payload),
            headers: {
              eventId: row.event_id,
              traceId:
                typeof envelope.traceId === "string" && envelope.traceId.trim().length > 0
                  ? envelope.traceId
                  : row.event_id,
              source: "outbox-publisher",
              schemaVersion:
                typeof envelope.schemaVersion === "number"
                  ? String(envelope.schemaVersion)
                  : "1",
              eventKind: envelope.eventKind === "domain" ? "domain" : "integration",
              eventType:
                typeof envelope.eventType === "string" && envelope.eventType.trim().length > 0
                  ? envelope.eventType
                  : row.event_type,
            },
          },
        ],
      });

      await client.query(
        `UPDATE outbox_events
         SET published_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [row.id],
      );
    }

    await client.query("COMMIT");
    return rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
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
    if (processed > 0) {
      console.log(`published ${processed} outbox event(s)`);
    }
  } catch (error) {
    console.error("outbox publish failed", error);
  } finally {
    isRunning = false;
  }
}

async function start(): Promise<void> {
  await producer.connect();
  console.log("outbox-publisher started");

  await tick();
  timer = setInterval(() => {
    void tick();
  }, pollIntervalMs);
}

async function shutdown(): Promise<void> {
  if (timer) {
    clearInterval(timer);
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

void start();
