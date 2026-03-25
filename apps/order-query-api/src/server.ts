import { randomUUID } from "node:crypto";
import express from "express";
import { Pool } from "pg";
import { MetricsRegistry, createJsonLogger, toHttpTraceId } from "@flashflow/common";
import { queryOrderStatusUseCase } from "./application/query-order-status.use-case";
import { parseOrderId } from "./domain/order-id";

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
  const orderId = parseOrderId(req.params.orderId);
  const traceId = typeof res.locals.traceId === "string" ? res.locals.traceId : randomUUID();

  if (!orderId) {
    queryStatusResultCounter.inc({ service: serviceName, result: "invalid_order_id" });
    logger.warn("query status rejected invalid orderId", {
      traceId,
      orderId: req.params.orderId,
    });
    res.status(400).json({ message: "Invalid orderId format" });
    return;
  }

  try {
    const queryResult = await queryOrderStatusUseCase(pool, orderId);

    if (queryResult.result === "not_found") {
      queryStatusResultCounter.inc({ service: serviceName, result: "not_found" });
      res.status(404).json({ message: "Order not found" });
      return;
    }

    queryStatusResultCounter.inc({ service: serviceName, result: queryResult.result });
    res.status(200).json(queryResult.payload);
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
