import { randomUUID } from "node:crypto";

export type EventKind = "domain" | "integration";

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

export interface CreateOrderCreatedEventInput {
  orderId: string;
  userId: string;
  totalAmount: number;
  traceId?: string;
}

export interface CreatePaymentSucceededEventInput {
  orderId: string;
  userId: string;
  totalAmount: number;
  traceId?: string;
  paymentId?: string;
  provider?: string;
}

export interface CreatePaymentFailedEventInput {
  orderId: string;
  userId: string;
  totalAmount: number;
  reason: string;
  retryable: boolean;
  traceId?: string;
}

export const ORDER_CREATED_EVENT = "order.created";
export const PAYMENT_SUCCEEDED_EVENT = "payment.succeeded";
export const PAYMENT_FAILED_EVENT = "payment.failed";
export const PAYMENT_EVENTS_TOPIC = "payment.events";

function createIntegrationEvent<T>(input: {
  eventType: string;
  orderId: string;
  traceId?: string;
  payload: T;
}): EventEnvelope<T> {
  return {
    eventId: randomUUID(),
    eventKind: "integration",
    eventType: input.eventType,
    orderId: input.orderId,
    occurredAt: new Date().toISOString(),
    traceId: input.traceId ?? randomUUID(),
    schemaVersion: 1,
    payload: input.payload,
  };
}

export function createOrderCreatedEvent(
  input: CreateOrderCreatedEventInput,
): EventEnvelope<OrderCreatedPayload> {
  return createIntegrationEvent<OrderCreatedPayload>({
    eventType: ORDER_CREATED_EVENT,
    orderId: input.orderId,
    traceId: input.traceId,
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
    eventType: PAYMENT_SUCCEEDED_EVENT,
    orderId: input.orderId,
    traceId: input.traceId,
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
    eventType: PAYMENT_FAILED_EVENT,
    orderId: input.orderId,
    traceId: input.traceId,
    payload: {
      userId: input.userId,
      totalAmount: input.totalAmount,
      reason: input.reason,
      retryable: input.retryable,
    },
  });
}
