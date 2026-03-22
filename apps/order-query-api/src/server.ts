import express from "express";
import { Pool } from "pg";

const app = express();

const port = Number(process.env.ORDER_QUERY_API_PORT ?? 3001);
const postgresUrl =
  process.env.POSTGRES_URL ?? "postgres://flashflow:flashflow@localhost:5432/flashflow";

const pool = new Pool({ connectionString: postgresUrl });

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ status: "ok" });
  } catch (error) {
    res.status(500).json({ status: "error", message: (error as Error).message });
  }
});

app.get("/orders/:orderId/status", async (req, res) => {
  const orderId = typeof req.params.orderId === "string" ? req.params.orderId.trim() : "";

  if (!uuidRegex.test(orderId)) {
    res.status(400).json({ message: "Invalid orderId format" });
    return;
  }

  try {
    const statusView = await pool.query<{
      order_id: string;
      current_status: string;
      last_event_id: string;
      last_updated_at: Date;
    }>(
      `SELECT order_id, current_status, last_event_id, last_updated_at
       FROM order_status_view
       WHERE order_id = $1::uuid`,
      [orderId],
    );

    if (statusView.rowCount && statusView.rows[0]) {
      const row = statusView.rows[0];
      res.status(200).json({
        orderId: row.order_id,
        status: row.current_status,
        lastEventId: row.last_event_id,
        lastUpdatedAt: row.last_updated_at.toISOString(),
      });
      return;
    }

    const orderRow = await pool.query<{
      order_id: string;
      status: string;
      updated_at: Date;
    }>(
      `SELECT order_id, status, updated_at
       FROM orders
       WHERE order_id = $1::uuid`,
      [orderId],
    );

    if (orderRow.rowCount && orderRow.rows[0]) {
      const row = orderRow.rows[0];
      res.status(200).json({
        orderId: row.order_id,
        status: row.status,
        lastEventId: null,
        lastUpdatedAt: row.updated_at.toISOString(),
      });
      return;
    }

    res.status(404).json({ message: "Order not found" });
  } catch (error) {
    res.status(500).json({ message: "Failed to query order status", error: (error as Error).message });
  }
});

app.listen(port, () => {
  console.log(`order-query-api listening on port ${port}`);
});
