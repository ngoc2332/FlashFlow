import {
  EventEnvelope,
  PaymentSucceededPayload,
  RetryableProcessingError,
} from "@flashflow/common";

export type InventoryDecision =
  | {
      status: "reserved";
    }
  | {
      status: "rejected";
      reason: string;
    };

export interface InventoryPolicyConfig {
  failUserPrefix: string;
  rejectUserPrefix: string;
  reserveLimit: number;
}

export function decideInventory(
  event: EventEnvelope<PaymentSucceededPayload>,
  config: InventoryPolicyConfig,
): InventoryDecision {
  if (event.payload.userId.startsWith(config.failUserPrefix)) {
    throw new RetryableProcessingError("Mock inventory service timeout");
  }

  if (event.payload.userId.startsWith(config.rejectUserPrefix)) {
    return {
      status: "rejected",
      reason: "INVENTORY_REJECTED_BY_TEST_RULE",
    };
  }

  if (event.payload.totalAmount > config.reserveLimit) {
    return {
      status: "rejected",
      reason: "INVENTORY_OUT_OF_STOCK",
    };
  }

  return { status: "reserved" };
}
