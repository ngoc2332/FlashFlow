import { randomUUID } from "node:crypto";
import express from "express";
import { Pool } from "pg";
import {
  MetricsRegistry,
  createJsonLogger,
  createOrderCreatedEvent,
  toHttpTraceId,
} from "@flashflow/common";

const app = express();
app.use(express.json());

const port = Number(process.env.ORDER_API_PORT ?? 3000);
const serviceName = process.env.ORDER_API_SERVICE_NAME ?? "order-api";
const postgresUrl =
  process.env.POSTGRES_URL ?? "postgres://flashflow:flashflow@localhost:5432/flashflow";

const pool = new Pool({ connectionString: postgresUrl });
const logger = createJsonLogger({ service: serviceName });
const metrics = new MetricsRegistry();

const requestCounter = metrics.counter(
  "flashflow_http_requests_total",
  "Total HTTP requests",
  ["service", "method", "route", "status"],
);
const requestDurationSeconds = metrics.histogram(
  "flashflow_http_request_duration_seconds",
  "HTTP request duration in seconds",
  ["service", "method", "route", "status"],
);
const ordersCreatedCounter = metrics.counter(
  "flashflow_orders_created_total",
  "Total orders created",
  ["service"],
);
const orderCreateFailuresCounter = metrics.counter(
  "flashflow_order_create_failures_total",
  "Total order create failures",
  ["service", "reason"],
);

function resolveTraceId(headers: Record<string, unknown>): string {
  const rawTraceId = headers["x-trace-id"];

  if (Array.isArray(rawTraceId)) {
    return toHttpTraceId(rawTraceId[0]) ?? randomUUID();
  }

  return toHttpTraceId(rawTraceId) ?? randomUUID();
}

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    const labels = {
      service: serviceName,
      method: req.method,
      route: req.path,
      status: String(res.statusCode),
    };

    requestCounter.inc(labels);
    requestDurationSeconds.observe(labels, elapsedSeconds);
  });

  next();
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ status: "ok" });
  } catch (error) {
    logger.error("health check failed", { error });
    res.status(500).json({ status: "error", message: (error as Error).message });
  }
});

app.get("/metrics", (_req, res) => {
  res.status(200).type("text/plain; version=0.0.4; charset=utf-8").send(metrics.render());
});

app.post("/orders", async (req, res) => {
  const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
  const totalAmount = Number(req.body?.totalAmount);
  const traceId = resolveTraceId(req.headers as Record<string, unknown>);

  res.setHeader("x-trace-id", traceId);

  if (!userId || !Number.isFinite(totalAmount) || totalAmount <= 0) {
    orderCreateFailuresCounter.inc({
      service: serviceName,
      reason: "invalid_payload",
    });
    logger.warn("order create rejected due to invalid payload", {
      traceId,
      userId,
      totalAmount,
    });
    res.status(400).json({
      message: "Invalid payload. Expect { userId: string, totalAmount: number > 0 }",
      traceId,
    });
    return;
  }

  const orderId =
    typeof req.body?.orderId === "string" && req.body.orderId.trim().length > 0
      ? req.body.orderId.trim()
      : randomUUID();

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

    ordersCreatedCounter.inc({ service: serviceName });
    logger.info("order created", {
      traceId: event.traceId,
      orderId,
      eventId: event.eventId,
      totalAmount,
    });

    res.status(201).json({
      orderId,
      eventId: event.eventId,
      status: "PENDING_PAYMENT",
      traceId: event.traceId,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    if ((error as { code?: string }).code === "23505") {
      orderCreateFailuresCounter.inc({
        service: serviceName,
        reason: "duplicate_order",
      });
      logger.warn("order create conflict", {
        traceId,
        orderId,
        error,
      });
      res.status(409).json({ message: "Order already exists" });
      return;
    }

    orderCreateFailuresCounter.inc({
      service: serviceName,
      reason: "db_error",
    });
    logger.error("order create failed", {
      traceId,
      orderId,
      error,
    });
    res.status(500).json({ message: "Failed to create order", error: (error as Error).message });
  } finally {
    client.release();
  }
});

app.listen(port, () => {
  logger.info("service started", { port });
});
