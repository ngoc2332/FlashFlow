import { randomUUID } from "node:crypto";
import express from "express";
import { Pool } from "pg";
import { MetricsRegistry, createJsonLogger, toHttpTraceId } from "@flashflow/common";

const app = express();

const port = Number(process.env.ORDER_QUERY_API_PORT ?? 3001);
const serviceName = process.env.ORDER_QUERY_API_SERVICE_NAME ?? "order-query-api";
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
const queryStatusResultCounter = metrics.counter(
  "flashflow_order_query_results_total",
  "Total order query result by type",
  ["service", "result"],
);

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveTraceId(headers: Record<string, unknown>): string {
  const rawTraceId = headers["x-trace-id"];

  if (Array.isArray(rawTraceId)) {
    return toHttpTraceId(rawTraceId[0]) ?? randomUUID();
  }

  return toHttpTraceId(rawTraceId) ?? randomUUID();
}

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  const traceId = resolveTraceId(req.headers as Record<string, unknown>);

  res.setHeader("x-trace-id", traceId);
  res.locals.traceId = traceId;

  res.on("finish", () => {
    const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    const route = req.path.startsWith("/orders/") && req.path.endsWith("/status")
      ? "/orders/:orderId/status"
      : req.path;
    const labels = {
      service: serviceName,
      method: req.method,
      route,
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

app.get("/orders/:orderId/status", async (req, res) => {
  const orderId = typeof req.params.orderId === "string" ? req.params.orderId.trim() : "";
  const traceId = typeof res.locals.traceId === "string" ? res.locals.traceId : randomUUID();

  if (!uuidRegex.test(orderId)) {
    queryStatusResultCounter.inc({ service: serviceName, result: "invalid_order_id" });
    logger.warn("query status rejected invalid orderId", {
      traceId,
      orderId,
    });
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
      queryStatusResultCounter.inc({ service: serviceName, result: "found_view" });
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
      queryStatusResultCounter.inc({ service: serviceName, result: "found_orders" });
      res.status(200).json({
        orderId: row.order_id,
        status: row.status,
        lastEventId: null,
        lastUpdatedAt: row.updated_at.toISOString(),
      });
      return;
    }

    queryStatusResultCounter.inc({ service: serviceName, result: "not_found" });
    res.status(404).json({ message: "Order not found" });
  } catch (error) {
    queryStatusResultCounter.inc({ service: serviceName, result: "db_error" });
    logger.error("query status failed", {
      traceId,
      orderId,
      error,
    });
    res.status(500).json({ message: "Failed to query order status", error: (error as Error).message });
  }
});

app.listen(port, () => {
  logger.info("service started", { port });
});
