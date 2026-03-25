import { Producer } from "kafkajs";
import { Pool } from "pg";
import {
  fetchUnpublishedOutboxBatch,
  markOutboxPublished,
} from "../infrastructure/outbox-repository";
import { publishOutboxRow } from "../infrastructure/outbox-kafka-producer";

interface CounterLike {
  inc: (labels?: Record<string, string>, value?: number) => void;
}

export interface PublishOutboxBatchInput {
  pool: Pool;
  producer: Producer;
  serviceName: string;
  batchSize: number;
  publishedEventsCounter: CounterLike;
}

export async function publishOutboxBatchUseCase(
  input: PublishOutboxBatchInput,
): Promise<number> {
  const client = await input.pool.connect();

  try {
    await client.query("BEGIN");

    const rows = await fetchUnpublishedOutboxBatch(client, input.batchSize);

    if (rows.length === 0) {
      await client.query("COMMIT");
      return 0;
    }

    for (const row of rows) {
      const published = await publishOutboxRow(
        input.producer,
        input.serviceName,
        row,
      );

      input.publishedEventsCounter.inc({
        service: input.serviceName,
        topic: published.topic,
        event_type: published.eventType,
      });

      await markOutboxPublished(client, row.id);
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
