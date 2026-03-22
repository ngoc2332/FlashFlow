import { randomUUID } from "node:crypto";
import express from "express";
import { Pool } from "pg";
import { createOrderCreatedEvent } from "@flashflow/common";

const app = express();
app.use(express.json());

const port = Number(process.env.ORDER_API_PORT ?? 3000);
const postgresUrl =
  process.env.POSTGRES_URL ?? "postgres://flashflow:flashflow@localhost:5432/flashflow";

const pool = new Pool({ connectionString: postgresUrl });

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ status: "ok" });
  } catch (error) {
    res.status(500).json({ status: "error", message: (error as Error).message });
  }
});

app.post("/orders", async (req, res) => {
  const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
  const totalAmount = Number(req.body?.totalAmount);

  if (!userId || !Number.isFinite(totalAmount) || totalAmount <= 0) {
    res.status(400).json({
      message: "Invalid payload. Expect { userId: string, totalAmount: number > 0 }",
    });
    return;
  }

  const orderId =
    typeof req.body?.orderId === "string" && req.body.orderId.trim().length > 0
      ? req.body.orderId.trim()
      : randomUUID();

  const traceId =
    typeof req.headers["x-trace-id"] === "string" ? req.headers["x-trace-id"] : randomUUID();

  const event = createOrderCreatedEvent({ orderId, userId, totalAmount, traceId });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO orders (order_id, user_id, status, total_amount, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [orderId, userId, "PENDING_PAYMENT", totalAmount],
    );

    await client.query(
      `INSERT INTO outbox_events (id, event_id, aggregate_id, event_type, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())`,
      [randomUUID(), event.eventId, orderId, event.eventType, JSON.stringify(event)],
    );

    await client.query(
      `INSERT INTO order_status_view (order_id, current_status, last_event_id, last_updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (order_id) DO UPDATE
       SET current_status = EXCLUDED.current_status,
           last_event_id = EXCLUDED.last_event_id,
           last_updated_at = NOW()`,
      [orderId, "PENDING_PAYMENT", event.eventId],
    );

    await client.query("COMMIT");

    res.status(201).json({
      orderId,
      eventId: event.eventId,
      status: "PENDING_PAYMENT",
      traceId: event.traceId,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    if ((error as { code?: string }).code === "23505") {
      res.status(409).json({ message: "Order already exists" });
      return;
    }

    res.status(500).json({ message: "Failed to create order", error: (error as Error).message });
  } finally {
    client.release();
  }
});

app.listen(port, () => {
  console.log(`order-api listening on port ${port}`);
});
