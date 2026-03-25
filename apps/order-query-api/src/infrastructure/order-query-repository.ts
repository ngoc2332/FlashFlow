import { Pool } from "pg";

export interface OrderStatusViewRow {
  order_id: string;
  current_status: string;
  last_event_id: string;
  last_updated_at: Date;
}

export interface OrderRow {
  order_id: string;
  status: string;
  updated_at: Date;
}

export async function findOrderStatusView(
  pool: Pool,
  orderId: string,
): Promise<OrderStatusViewRow | undefined> {
  const statusView = await pool.query<OrderStatusViewRow>(
    `SELECT order_id, current_status, last_event_id, last_updated_at
     FROM order_status_view
     WHERE order_id = $1::uuid`,
    [orderId],
  );

  return statusView.rowCount && statusView.rows[0] ? statusView.rows[0] : undefined;
}

export async function findOrder(
  pool: Pool,
  orderId: string,
): Promise<OrderRow | undefined> {
  const orderRow = await pool.query<OrderRow>(
    `SELECT order_id, status, updated_at
     FROM orders
     WHERE order_id = $1::uuid`,
    [orderId],
  );

  return orderRow.rowCount && orderRow.rows[0] ? orderRow.rows[0] : undefined;
}
