import { randomUUID } from "node:crypto";
import { PoolClient } from "pg";
import { EventEnvelope, OrderCreatedPayload } from "@flashflow/common";
import { PENDING_PAYMENT_STATUS } from "../domain/order";

export async function insertOrder(
  client: PoolClient,
  input: {
    orderId: string;
    userId: string;
    totalAmount: number;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO orders (order_id, user_id, status, total_amount, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())`,
    [input.orderId, input.userId, PENDING_PAYMENT_STATUS, input.totalAmount],
  );
}

export async function insertOutboxOrderCreated(
  client: PoolClient,
  event: EventEnvelope<OrderCreatedPayload>,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events (id, event_id, aggregate_id, event_type, payload, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())`,
    [randomUUID(), event.eventId, event.orderId, event.eventType, JSON.stringify(event)],
  );
}

export async function upsertOrderStatusView(
  client: PoolClient,
  input: {
    orderId: string;
    lastEventId: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO order_status_view (order_id, current_status, last_event_id, last_updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (order_id) DO UPDATE
     SET current_status = EXCLUDED.current_status,
         last_event_id = EXCLUDED.last_event_id,
         last_updated_at = NOW()`,
    [input.orderId, PENDING_PAYMENT_STATUS, input.lastEventId],
  );
}
