import { PoolClient } from "pg";

export interface OutboxRow {
  id: string;
  event_id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
}

export async function fetchUnpublishedOutboxBatch(
  client: PoolClient,
  batchSize: number,
): Promise<OutboxRow[]> {
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

export async function markOutboxPublished(
  client: PoolClient,
  outboxId: string,
): Promise<void> {
  await client.query(
    `UPDATE outbox_events
     SET published_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [outboxId],
  );
}

export async function countUnpublishedOutboxEvents(
  client: PoolClient,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM outbox_events
     WHERE published_at IS NULL`,
  );

  const count = Number(result.rows[0]?.count ?? 0);
  return Number.isFinite(count) ? count : 0;
}
