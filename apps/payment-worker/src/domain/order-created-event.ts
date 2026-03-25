import {
  EventEnvelope,
  NonRetryableProcessingError,
  ORDER_CREATED_EVENT,
  OrderCreatedPayload,
  parseEventEnvelope,
} from "@flashflow/common";

export function parseOrderCreatedEvent(rawValue: Buffer | null): EventEnvelope<OrderCreatedPayload> {
  return parseEventEnvelope<OrderCreatedPayload>(rawValue, {
    expectedEventType: ORDER_CREATED_EVENT,
    parsePayload: (rawPayload) => {
      if (!rawPayload || typeof rawPayload !== "object") {
        throw new NonRetryableProcessingError("payload is required");
      }

      const payload = rawPayload as Partial<OrderCreatedPayload>;

      if (typeof payload.userId !== "string" || payload.userId.trim().length === 0) {
        throw new NonRetryableProcessingError("payload.userId is required");
      }

      if (
        typeof payload.totalAmount !== "number" ||
        !Number.isFinite(payload.totalAmount) ||
        payload.totalAmount <= 0
      ) {
        throw new NonRetryableProcessingError("payload.totalAmount must be a number > 0");
      }

      return {
        userId: payload.userId,
        totalAmount: payload.totalAmount,
      };
    },
  });
}
