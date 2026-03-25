import {
  EventEnvelope,
  OrderCreatedPayload,
  RetryableProcessingError,
} from "@flashflow/common";

export type PaymentDecision =
  | {
      status: "succeeded";
    }
  | {
      status: "failed";
      reason: string;
      retryable: false;
    };

export interface PaymentPolicyConfig {
  failUserPrefix: string;
  approvalLimit: number;
}

export function decidePayment(
  event: EventEnvelope<OrderCreatedPayload>,
  config: PaymentPolicyConfig,
): PaymentDecision {
  if (event.payload.userId.startsWith(config.failUserPrefix)) {
    throw new RetryableProcessingError("Mock payment gateway timeout");
  }

  if (event.payload.totalAmount > config.approvalLimit) {
    return {
      status: "failed",
      reason: "PAYMENT_DECLINED_LIMIT_EXCEEDED",
      retryable: false,
    };
  }

  return { status: "succeeded" };
}
