import {
  INVENTORY_REJECTED_EVENT,
  INVENTORY_RESERVED_EVENT,
  ORDER_CREATED_EVENT,
  PAYMENT_FAILED_EVENT,
  PAYMENT_SUCCEEDED_EVENT,
} from "@flashflow/common";

const statusByEventType: Record<string, string> = {
  [ORDER_CREATED_EVENT]: "PENDING_PAYMENT",
  [PAYMENT_SUCCEEDED_EVENT]: "PAYMENT_SUCCEEDED",
  [PAYMENT_FAILED_EVENT]: "PAYMENT_FAILED",
  [INVENTORY_RESERVED_EVENT]: "INVENTORY_RESERVED",
  [INVENTORY_REJECTED_EVENT]: "INVENTORY_REJECTED",
};

export function resolveOrderStatus(eventType: string): string | undefined {
  return statusByEventType[eventType];
}
