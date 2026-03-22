import { randomUUID } from "node:crypto";
import { NonRetryableProcessingError } from "./reliability";

export type EventKind = "domain" | "integration";
export const DEFAULT_SCHEMA_VERSION = 1;

export interface EventEnvelope<T> {
  eventId: string;
  eventKind: EventKind;
  eventType: string;
  orderId: string;
  occurredAt: string;
  traceId: string;
  schemaVersion: number;
  payload: T;
}

export interface OrderCreatedPayload {
  userId: string;
  totalAmount: number;
}

export interface PaymentSucceededPayload {
  userId: string;
  totalAmount: number;
  paymentId: string;
  provider: string;
}

export interface PaymentFailedPayload {
  userId: string;
  totalAmount: number;
  reason: string;
  retryable: boolean;
}

export interface InventoryReservedPayload {
  userId: string;
  totalAmount: number;
  reservationId: string;
  warehouse: string;
}

export interface InventoryRejectedPayload {
  userId: string;
  totalAmount: number;
  reason: string;
}

export interface CreateOrderCreatedEventInput {
  eventId?: string;
  orderId: string;
  userId: string;
  totalAmount: number;
  traceId?: string;
  schemaVersion?: number;
}

export interface CreatePaymentSucceededEventInput {
  eventId?: string;
  orderId: string;
  userId: string;
  totalAmount: number;
  traceId?: string;
  schemaVersion?: number;
  paymentId?: string;
  provider?: string;
}

export interface CreatePaymentFailedEventInput {
  eventId?: string;
  orderId: string;
  userId: string;
  totalAmount: number;
  reason: string;
  retryable: boolean;
  traceId?: string;
  schemaVersion?: number;
}

export interface CreateInventoryReservedEventInput {
  eventId?: string;
  orderId: string;
  userId: string;
  totalAmount: number;
  traceId?: string;
  schemaVersion?: number;
  reservationId?: string;
  warehouse?: string;
}

export interface CreateInventoryRejectedEventInput {
  eventId?: string;
  orderId: string;
  userId: string;
  totalAmount: number;
  reason: string;
  traceId?: string;
  schemaVersion?: number;
}

export const ORDER_CREATED_EVENT = "order.created";
export const PAYMENT_SUCCEEDED_EVENT = "payment.succeeded";
export const PAYMENT_FAILED_EVENT = "payment.failed";
export const PAYMENT_EVENTS_TOPIC = "payment.events";
export const INVENTORY_RESERVED_EVENT = "inventory.reserved";
export const INVENTORY_REJECTED_EVENT = "inventory.rejected";
export const INVENTORY_EVENTS_TOPIC = "inventory.events";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequiredUuid(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new NonRetryableProcessingError(`${fieldName} must be a valid UUID`);
  }

  return value;
}

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new NonRetryableProcessingError(`${fieldName} is required`);
  }

  return value;
}

export function parseSchemaVersion(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_SCHEMA_VERSION;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new NonRetryableProcessingError("schemaVersion must be a positive integer");
  }

  return value;
}

export interface ParseEventEnvelopeOptions<TPayload> {
  expectedEventType?: string;
  parsePayload?: (
    payload: unknown,
    envelope: Omit<EventEnvelope<unknown>, "payload">,
  ) => TPayload;
}

export function parseEventEnvelope<TPayload = unknown>(
  rawValue: Buffer | null,
  options: ParseEventEnvelopeOptions<TPayload> = {},
): EventEnvelope<TPayload> {
  if (!rawValue) {
    throw new NonRetryableProcessingError("Message value is empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue.toString("utf8"));
  } catch (error) {
    throw new NonRetryableProcessingError(
      `Message is not valid JSON: ${(error as Error).message}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new NonRetryableProcessingError("Event envelope must be an object");
  }

  const eventType = parseRequiredString(parsed.eventType, "eventType");
  if (options.expectedEventType && eventType !== options.expectedEventType) {
    throw new NonRetryableProcessingError(
      `Unsupported eventType: ${String(parsed.eventType)}`,
    );
  }

  if (!isRecord(parsed.payload)) {
    throw new NonRetryableProcessingError("payload is required");
  }

  const eventWithoutPayload: Omit<EventEnvelope<unknown>, "payload"> = {
    eventId: parseRequiredUuid(parsed.eventId, "eventId"),
    eventKind: parsed.eventKind === "domain" ? "domain" : "integration",
    eventType,
    orderId: parseRequiredUuid(parsed.orderId, "orderId"),
    occurredAt:
      typeof parsed.occurredAt === "string" && parsed.occurredAt.trim().length > 0
        ? parsed.occurredAt
        : new Date().toISOString(),
    traceId:
      typeof parsed.traceId === "string" && parsed.traceId.trim().length > 0
        ? parsed.traceId
        : randomUUID(),
    schemaVersion: parseSchemaVersion(parsed.schemaVersion),
  };

  return {
    ...eventWithoutPayload,
    payload: options.parsePayload
      ? options.parsePayload(parsed.payload, eventWithoutPayload)
      : (parsed.payload as TPayload),
  };
}

function createIntegrationEvent<T>(input: {
  eventId?: string;
  eventType: string;
  orderId: string;
  traceId?: string;
  schemaVersion?: number;
  payload: T;
}): EventEnvelope<T> {
  return {
    eventId: input.eventId ?? randomUUID(),
    eventKind: "integration",
    eventType: input.eventType,
    orderId: input.orderId,
    occurredAt: new Date().toISOString(),
    traceId: input.traceId ?? randomUUID(),
    schemaVersion: parseSchemaVersion(input.schemaVersion),
    payload: input.payload,
  };
}

export function createOrderCreatedEvent(
  input: CreateOrderCreatedEventInput,
): EventEnvelope<OrderCreatedPayload> {
  return createIntegrationEvent<OrderCreatedPayload>({
    eventId: input.eventId,
    eventType: ORDER_CREATED_EVENT,
    orderId: input.orderId,
    traceId: input.traceId,
    schemaVersion: input.schemaVersion,
    payload: {
      userId: input.userId,
      totalAmount: input.totalAmount,
    },
  });
}

export function createPaymentSucceededEvent(
  input: CreatePaymentSucceededEventInput,
): EventEnvelope<PaymentSucceededPayload> {
  return createIntegrationEvent<PaymentSucceededPayload>({
    eventId: input.eventId,
    eventType: PAYMENT_SUCCEEDED_EVENT,
    orderId: input.orderId,
    traceId: input.traceId,
    schemaVersion: input.schemaVersion,
    payload: {
      userId: input.userId,
      totalAmount: input.totalAmount,
      paymentId: input.paymentId ?? randomUUID(),
      provider: input.provider ?? "mock-gateway",
    },
  });
}

export function createPaymentFailedEvent(
  input: CreatePaymentFailedEventInput,
): EventEnvelope<PaymentFailedPayload> {
  return createIntegrationEvent<PaymentFailedPayload>({
    eventId: input.eventId,
    eventType: PAYMENT_FAILED_EVENT,
    orderId: input.orderId,
    traceId: input.traceId,
    schemaVersion: input.schemaVersion,
    payload: {
      userId: input.userId,
      totalAmount: input.totalAmount,
      reason: input.reason,
      retryable: input.retryable,
    },
  });
}

export function createInventoryReservedEvent(
  input: CreateInventoryReservedEventInput,
): EventEnvelope<InventoryReservedPayload> {
  return createIntegrationEvent<InventoryReservedPayload>({
    eventId: input.eventId,
    eventType: INVENTORY_RESERVED_EVENT,
    orderId: input.orderId,
    traceId: input.traceId,
    schemaVersion: input.schemaVersion,
    payload: {
      userId: input.userId,
      totalAmount: input.totalAmount,
      reservationId: input.reservationId ?? randomUUID(),
      warehouse: input.warehouse ?? "mock-wh-1",
    },
  });
}

export function createInventoryRejectedEvent(
  input: CreateInventoryRejectedEventInput,
): EventEnvelope<InventoryRejectedPayload> {
  return createIntegrationEvent<InventoryRejectedPayload>({
    eventId: input.eventId,
    eventType: INVENTORY_REJECTED_EVENT,
    orderId: input.orderId,
    traceId: input.traceId,
    schemaVersion: input.schemaVersion,
    payload: {
      userId: input.userId,
      totalAmount: input.totalAmount,
      reason: input.reason,
    },
  });
}

export * from "./reliability";
