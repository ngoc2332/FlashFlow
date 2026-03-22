import { createServer, Server } from "node:http";
import { randomUUID } from "node:crypto";
import { Kafka } from "kafkajs";
import { HeaderValue, headerToString } from "./reliability";

type LogLevel = "info" | "warn" | "error";

type LabelValues = Record<string, string>;

interface MetricBase {
  name: string;
  help: string;
  labelNames: string[];
}

interface CounterMetric extends MetricBase {
  type: "counter";
  values: Map<string, { labels: LabelValues; value: number }>;
}

interface GaugeMetric extends MetricBase {
  type: "gauge";
  values: Map<string, { labels: LabelValues; value: number }>;
}

interface HistogramSeries {
  labels: LabelValues;
  bucketValues: number[];
  sum: number;
  count: number;
}

interface HistogramMetric extends MetricBase {
  type: "histogram";
  buckets: number[];
  values: Map<string, HistogramSeries>;
}

type RegisteredMetric = CounterMetric | GaugeMetric | HistogramMetric;

const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function toMetricKey(labelNames: string[], labels: LabelValues): string {
  return labelNames.map((labelName) => labels[labelName] ?? "").join("\u0001");
}

function normalizeLabels(labelNames: string[], labels: LabelValues | undefined): LabelValues {
  const normalized: LabelValues = {};

  for (const labelName of labelNames) {
    normalized[labelName] = labels?.[labelName] ?? "";
  }

  return normalized;
}

function formatLabels(labels: LabelValues): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return "";
  }

  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;
}

function asFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return fallback;
}

function parseOffset(rawOffset: string | null | undefined): bigint | undefined {
  if (!rawOffset || rawOffset === "-1") {
    return undefined;
  }

  try {
    return BigInt(rawOffset);
  } catch {
    return undefined;
  }
}

function toHexTraceId(traceId: string): string | undefined {
  const sanitized = traceId.replace(/-/g, "").trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(sanitized) ? sanitized : undefined;
}

function parseTraceParent(traceParent: string): string | undefined {
  const matched = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(traceParent.trim());
  if (!matched?.[1]) {
    return undefined;
  }

  return matched[1];
}

export interface JsonLogger {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
}

export interface CreateJsonLoggerOptions {
  service: string;
  defaultFields?: Record<string, unknown>;
}

function serializeError(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  return {
    errorName: error.name,
    errorMessage: error.message,
    errorStack: error.stack,
  };
}

export function createJsonLogger(options: CreateJsonLoggerOptions): JsonLogger {
  function write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    const errorFields = serializeError(fields?.error);
    const record: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      service: options.service,
      message,
      ...(options.defaultFields ?? {}),
      ...(fields ?? {}),
    };

    if (errorFields) {
      record.error = undefined;
      Object.assign(record, errorFields);
    }

    const line = JSON.stringify(record);

    if (level === "error") {
      console.error(line);
      return;
    }

    if (level === "warn") {
      console.warn(line);
      return;
    }

    console.log(line);
  }

  return {
    info: (message, fields) => {
      write("info", message, fields);
    },
    warn: (message, fields) => {
      write("warn", message, fields);
    },
    error: (message, fields) => {
      write("error", message, fields);
    },
  };
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, RegisteredMetric>();

  counter(name: string, help: string, labelNames: string[] = []): {
    inc: (labels?: LabelValues, value?: number) => void;
  } {
    const metric = this.registerCounter(name, help, labelNames);

    return {
      inc: (labels, value = 1) => {
        const safeLabels = normalizeLabels(metric.labelNames, labels);
        const metricKey = toMetricKey(metric.labelNames, safeLabels);
        const existing = metric.values.get(metricKey);
        const nextValue = (existing?.value ?? 0) + asFiniteNumber(value, 1);

        metric.values.set(metricKey, {
          labels: safeLabels,
          value: nextValue,
        });
      },
    };
  }

  gauge(name: string, help: string, labelNames: string[] = []): {
    set: (labels: LabelValues | undefined, value: number) => void;
    inc: (labels?: LabelValues, value?: number) => void;
    dec: (labels?: LabelValues, value?: number) => void;
  } {
    const metric = this.registerGauge(name, help, labelNames);

    return {
      set: (labels, value) => {
        const safeLabels = normalizeLabels(metric.labelNames, labels);
        const metricKey = toMetricKey(metric.labelNames, safeLabels);

        metric.values.set(metricKey, {
          labels: safeLabels,
          value: asFiniteNumber(value, 0),
        });
      },
      inc: (labels, value = 1) => {
        const safeLabels = normalizeLabels(metric.labelNames, labels);
        const metricKey = toMetricKey(metric.labelNames, safeLabels);
        const existing = metric.values.get(metricKey);
        const nextValue = (existing?.value ?? 0) + asFiniteNumber(value, 1);

        metric.values.set(metricKey, {
          labels: safeLabels,
          value: nextValue,
        });
      },
      dec: (labels, value = 1) => {
        const safeLabels = normalizeLabels(metric.labelNames, labels);
        const metricKey = toMetricKey(metric.labelNames, safeLabels);
        const existing = metric.values.get(metricKey);
        const nextValue = (existing?.value ?? 0) - asFiniteNumber(value, 1);

        metric.values.set(metricKey, {
          labels: safeLabels,
          value: nextValue,
        });
      },
    };
  }

  histogram(
    name: string,
    help: string,
    labelNames: string[] = [],
    buckets: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  ): {
    observe: (labels: LabelValues | undefined, value: number) => void;
  } {
    const metric = this.registerHistogram(name, help, labelNames, buckets);

    return {
      observe: (labels, value) => {
        const safeLabels = normalizeLabels(metric.labelNames, labels);
        const metricKey = toMetricKey(metric.labelNames, safeLabels);
        const series = metric.values.get(metricKey) ?? {
          labels: safeLabels,
          bucketValues: metric.buckets.map(() => 0),
          sum: 0,
          count: 0,
        };

        const safeValue = asFiniteNumber(value, 0);
        series.sum += safeValue;
        series.count += 1;

        for (let index = 0; index < metric.buckets.length; index += 1) {
          if (safeValue <= metric.buckets[index]) {
            series.bucketValues[index] += 1;
          }
        }

        metric.values.set(metricKey, series);
      },
    };
  }

  render(): string {
    const lines: string[] = [];

    for (const metric of this.metrics.values()) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);

      if (metric.type === "counter" || metric.type === "gauge") {
        for (const entry of metric.values.values()) {
          lines.push(`${metric.name}${formatLabels(entry.labels)} ${entry.value}`);
        }
        continue;
      }

      for (const series of metric.values.values()) {
        let cumulative = 0;

        for (let index = 0; index < metric.buckets.length; index += 1) {
          cumulative += series.bucketValues[index];
          lines.push(
            `${metric.name}_bucket${formatLabels({
              ...series.labels,
              le: String(metric.buckets[index]),
            })} ${cumulative}`,
          );
        }

        lines.push(
          `${metric.name}_bucket${formatLabels({ ...series.labels, le: "+Inf" })} ${series.count}`,
        );
        lines.push(`${metric.name}_sum${formatLabels(series.labels)} ${series.sum}`);
        lines.push(`${metric.name}_count${formatLabels(series.labels)} ${series.count}`);
      }
    }

    lines.push("");
    return lines.join("\n");
  }

  private registerCounter(name: string, help: string, labelNames: string[]): CounterMetric {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.type !== "counter") {
        throw new Error(`Metric ${name} already registered with type ${existing.type}`);
      }
      return existing;
    }

    const metric: CounterMetric = {
      name,
      help,
      type: "counter",
      labelNames,
      values: new Map(),
    };
    this.metrics.set(name, metric);
    return metric;
  }

  private registerGauge(name: string, help: string, labelNames: string[]): GaugeMetric {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.type !== "gauge") {
        throw new Error(`Metric ${name} already registered with type ${existing.type}`);
      }
      return existing;
    }

    const metric: GaugeMetric = {
      name,
      help,
      type: "gauge",
      labelNames,
      values: new Map(),
    };
    this.metrics.set(name, metric);
    return metric;
  }

  private registerHistogram(
    name: string,
    help: string,
    labelNames: string[],
    buckets: number[],
  ): HistogramMetric {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.type !== "histogram") {
        throw new Error(`Metric ${name} already registered with type ${existing.type}`);
      }
      return existing;
    }

    const deduplicatedSortedBuckets = [...new Set(buckets.filter((bucket) => Number.isFinite(bucket)))]
      .sort((left, right) => left - right);

    const metric: HistogramMetric = {
      name,
      help,
      type: "histogram",
      labelNames,
      buckets: deduplicatedSortedBuckets,
      values: new Map(),
    };
    this.metrics.set(name, metric);
    return metric;
  }
}

export interface MetricsServerOptions {
  port: number;
  service: string;
  registry: MetricsRegistry;
  logger: JsonLogger;
}

export function startMetricsServer(options: MetricsServerOptions): Server {
  const server = createServer((req, res) => {
    const path = req.url ?? "/";

    if (path === "/health") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ status: "ok", service: options.service }));
      return;
    }

    if (path === "/metrics") {
      res.statusCode = 200;
      res.setHeader("Content-Type", METRICS_CONTENT_TYPE);
      res.end(options.registry.render());
      return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ message: "Not found" }));
  });

  server.listen(options.port, () => {
    options.logger.info("metrics server started", {
      metricsPort: options.port,
    });
  });

  return server;
}

export async function closeMetricsServer(server: Server | undefined): Promise<void> {
  if (!server || !server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export interface ConsumerLagCollectorOptions {
  kafka: Kafka;
  service: string;
  consumerGroup: string;
  topics: string[];
  pollIntervalMs?: number;
  registry: MetricsRegistry;
  logger: JsonLogger;
}

export interface ConsumerLagCollector {
  stop: () => Promise<void>;
}

export function startConsumerLagCollector(options: ConsumerLagCollectorOptions): ConsumerLagCollector {
  const intervalMs =
    Number.isFinite(options.pollIntervalMs) && (options.pollIntervalMs ?? 0) > 0
      ? Number(options.pollIntervalMs)
      : 15_000;

  const admin = options.kafka.admin();
  const lagGauge = options.registry.gauge(
    "flashflow_kafka_consumer_lag",
    "Kafka consumer lag by group/topic/partition",
    ["service", "consumer_group", "topic", "partition"],
  );
  const scrapeFailuresCounter = options.registry.counter(
    "flashflow_kafka_lag_scrape_failures_total",
    "Number of consumer lag scrape failures",
    ["service", "consumer_group"],
  );

  let connected = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function ensureConnected(): Promise<boolean> {
    if (connected) {
      return true;
    }

    try {
      await admin.connect();
      connected = true;
      return true;
    } catch (error) {
      scrapeFailuresCounter.inc({
        service: options.service,
        consumer_group: options.consumerGroup,
      });
      options.logger.warn("consumer lag collector connect failed", {
        consumerGroup: options.consumerGroup,
        error,
      });
      return false;
    }
  }

  async function collectOnce(): Promise<void> {
    if (running || stopped) {
      return;
    }

    running = true;

    try {
      if (!(await ensureConnected())) {
        return;
      }

      for (const topic of options.topics) {
        const [latestOffsets, committedOffsetsByTopic] = await Promise.all([
          admin.fetchTopicOffsets(topic),
          admin.fetchOffsets({
            groupId: options.consumerGroup,
            topics: [topic],
          }),
        ]);
        const committedOffsets = committedOffsetsByTopic[0]?.partitions ?? [];

        const committedByPartition = new Map<number, bigint>();

        for (const committedOffset of committedOffsets) {
          const parsedCommittedOffset = parseOffset(committedOffset.offset);
          if (parsedCommittedOffset !== undefined) {
            committedByPartition.set(committedOffset.partition, parsedCommittedOffset);
          }
        }

        for (const latestOffset of latestOffsets) {
          const latest = parseOffset(latestOffset.offset) ?? 0n;
          const committed = committedByPartition.get(latestOffset.partition);
          const lagBigInt = committed === undefined ? latest : latest - committed;
          const lag = Number(lagBigInt > 0n ? lagBigInt : 0n);

          lagGauge.set(
            {
              service: options.service,
              consumer_group: options.consumerGroup,
              topic,
              partition: String(latestOffset.partition),
            },
            lag,
          );
        }
      }
    } catch (error) {
      scrapeFailuresCounter.inc({
        service: options.service,
        consumer_group: options.consumerGroup,
      });
      options.logger.warn("consumer lag collector scrape failed", {
        consumerGroup: options.consumerGroup,
        error,
      });
    } finally {
      running = false;
    }
  }

  void collectOnce();
  timer = setInterval(() => {
    void collectOnce();
  }, intervalMs);

  return {
    stop: async () => {
      stopped = true;

      if (timer) {
        clearInterval(timer);
      }

      if (!connected) {
        return;
      }

      try {
        await admin.disconnect();
      } catch (error) {
        options.logger.warn("consumer lag collector disconnect failed", {
          consumerGroup: options.consumerGroup,
          error,
        });
      }
    },
  };
}

export function toHttpTraceId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized;
}

export function resolveTraceIdFromKafkaHeaders(
  headers: Record<string, HeaderValue> | undefined,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  const traceParent = headerToString(headers.traceparent);
  const traceIdFromTraceParent = traceParent ? parseTraceParent(traceParent) : undefined;

  return (
    toHttpTraceId(headerToString(headers.traceId)) ??
    toHttpTraceId(headerToString(headers["x-trace-id"])) ??
    toHttpTraceId(traceIdFromTraceParent)
  );
}

export interface KafkaHeaderContext {
  source: string;
  traceId?: string;
  eventId?: string;
  orderId?: string;
  schemaVersion?: number;
  eventKind?: string;
  eventType?: string;
  extra?: Record<string, string>;
}

export function buildKafkaHeaders(context: KafkaHeaderContext): Record<string, string> {
  const traceId = context.traceId?.trim() || randomUUID();
  const headers: Record<string, string> = {
    source: context.source,
    traceId,
    "x-trace-id": traceId,
  };

  const hexTraceId = toHexTraceId(traceId);
  if (hexTraceId) {
    headers.traceparent = `00-${hexTraceId}-0000000000000000-01`;
  }

  if (context.eventId && context.eventId.trim().length > 0) {
    headers.eventId = context.eventId;
    headers["x-event-id"] = context.eventId;
  }

  if (context.orderId && context.orderId.trim().length > 0) {
    headers.orderId = context.orderId;
    headers["x-order-id"] = context.orderId;
  }

  if (typeof context.schemaVersion === "number" && Number.isFinite(context.schemaVersion)) {
    headers.schemaVersion = String(context.schemaVersion);
  }

  if (context.eventKind && context.eventKind.trim().length > 0) {
    headers.eventKind = context.eventKind;
  }

  if (context.eventType && context.eventType.trim().length > 0) {
    headers.eventType = context.eventType;
  }

  if (context.extra) {
    for (const [key, value] of Object.entries(context.extra)) {
      headers[key] = value;
    }
  }

  return headers;
}
