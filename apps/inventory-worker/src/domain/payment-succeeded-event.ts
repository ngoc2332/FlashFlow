import { randomUUID } from "node:crypto";
import {
  EventEnvelope,
  NonRetryableProcessingError,
  PAYMENT_SUCCEEDED_EVENT,
  PaymentSucceededPayload,
  parseEventEnvelope,
} from "@flashflow/common";

export function parseEnvelope(rawValue: Buffer | null): EventEnvelope<unknown> {
  return parseEventEnvelope(rawValue);
}

export function parsePaymentSucceededEvent(
  event: EventEnvelope<unknown>,
): EventEnvelope<PaymentSucceededPayload> | undefined {
  if (event.eventType !== PAYMENT_SUCCEEDED_EVENT) {
    return undefined;
  }

  if (!event.payload || typeof event.payload !== "object") {
    throw new NonRetryableProcessingError("payment.succeeded payload is required");
  }

  const payload = event.payload as Partial<PaymentSucceededPayload>;

  if (typeof payload.userId !== "string" || payload.userId.trim().length === 0) {
    throw new NonRetryableProcessingError("payment.succeeded payload.userId is required");
  }

  if (
    typeof payload.totalAmount !== "number" ||
    !Number.isFinite(payload.totalAmount) ||
    payload.totalAmount <= 0
  ) {
    throw new NonRetryableProcessingError(
      "payment.succeeded payload.totalAmount must be a number > 0",
    );
  }

  return {
    ...event,
    payload: {
      userId: payload.userId,
      totalAmount: payload.totalAmount,
      paymentId:
        typeof payload.paymentId === "string" && payload.paymentId.trim().length > 0
          ? payload.paymentId
          : randomUUID(),
      provider:
        typeof payload.provider === "string" && payload.provider.trim().length > 0
          ? payload.provider
          : "mock-gateway",
    },
  };
}
