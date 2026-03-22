import { createHash } from "node:crypto";

export class RetryableProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableProcessingError";
  }
}

export class NonRetryableProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableProcessingError";
  }
}

export type HeaderValue = Buffer | string | undefined;

export function headerToString(value: HeaderValue): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }

  return undefined;
}

export function normalizeHeaders(
  headers: Record<string, HeaderValue> | undefined,
): Record<string, string> {
  if (!headers) {
    return {};
  }

  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    const parsed = headerToString(value);
    if (parsed !== undefined) {
      normalized[key] = parsed;
    }
  }

  return normalized;
}

export function parseRetryCount(headers: Record<string, HeaderValue> | undefined): number {
  const raw = headers ? headerToString(headers.retryCount) : undefined;
  const retryCount = Number(raw ?? 0);

  if (!Number.isInteger(retryCount) || retryCount < 0) {
    return 0;
  }

  return retryCount;
}

export interface RetryPolicy {
  retryTopic5s: string;
  retryTopic1m: string;
  dlqTopic: string;
}

export interface RetryTarget {
  topic: string;
  nextRetryCount: number;
  terminal: boolean;
}

export function resolveRetryTarget(
  error: Error,
  retryCount: number,
  retryPolicy: RetryPolicy,
): RetryTarget {
  if (error instanceof NonRetryableProcessingError) {
    return {
      topic: retryPolicy.dlqTopic,
      nextRetryCount: retryCount,
      terminal: true,
    };
  }

  if (retryCount === 0) {
    return {
      topic: retryPolicy.retryTopic5s,
      nextRetryCount: 1,
      terminal: false,
    };
  }

  if (retryCount === 1) {
    return {
      topic: retryPolicy.retryTopic1m,
      nextRetryCount: 2,
      terminal: false,
    };
  }

  return {
    topic: retryPolicy.dlqTopic,
    nextRetryCount: retryCount + 1,
    terminal: true,
  };
}

export function nextOffset(offset: string): string {
  return (BigInt(offset) + 1n).toString();
}

export function createDeterministicEventId(seed: string): string {
  const hashHex = createHash("sha256").update(seed).digest("hex");

  return [
    hashHex.slice(0, 8),
    hashHex.slice(8, 12),
    hashHex.slice(12, 16),
    hashHex.slice(16, 20),
    hashHex.slice(20, 32),
  ].join("-");
}
