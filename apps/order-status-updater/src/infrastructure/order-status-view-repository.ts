import { Pool } from "pg";
import { EventEnvelope, NonRetryableProcessingError } from "@flashflow/common";

export interface UpsertResult {
  applied: boolean;
  currentStatus: string;
  lastEventId: string;
  lastUpdatedAt: string;
}

export async function upsertOrderStatusView(
  pool: Pool,
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
