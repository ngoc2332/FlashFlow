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

export interface CreateOrderCreatedEventInput {
  orderId: string;
  userId: string;
  totalAmount: number;
  traceId?: string;
}

export const ORDER_CREATED_EVENT = "order.created";

export function createOrderCreatedEvent(
  input: CreateOrderCreatedEventInput,
): EventEnvelope<OrderCreatedPayload> {
  return {
    eventId: randomUUID(),
    eventKind: "integration",
    eventType: ORDER_CREATED_EVENT,
    orderId: input.orderId,
    occurredAt: new Date().toISOString(),
    traceId: input.traceId ?? randomUUID(),
    schemaVersion: 1,
    payload: {
      userId: input.userId,
      totalAmount: input.totalAmount,
    },
  };
}
