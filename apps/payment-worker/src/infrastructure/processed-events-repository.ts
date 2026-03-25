import { Pool } from "pg";

export async function hasProcessedEvent(
  pool: Pool,
  eventId: string,
  consumerGroup: string,
): Promise<boolean> {
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

export async function markProcessedEvent(
  pool: Pool,
  eventId: string,
  consumerGroup: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO processed_events (event_id, consumer_group, processed_at)
     VALUES ($1::uuid, $2, NOW())
     ON CONFLICT (event_id, consumer_group) DO NOTHING`,
    [eventId, consumerGroup],
  );
}
