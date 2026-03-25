export const PENDING_PAYMENT_STATUS = "PENDING_PAYMENT";

export interface CreateOrderCommand {
  orderId: string;
  userId: string;
  totalAmount: number;
}

export interface InvalidCreateOrderPayload {
  userId: string;
  totalAmount: number;
}

export type CreateOrderCommandResult =
  | {
      ok: true;
      command: CreateOrderCommand;
    }
  | {
      ok: false;
      error: InvalidCreateOrderPayload;
    };

export function buildCreateOrderCommand(
  body: unknown,
  generateOrderId: () => string,
): CreateOrderCommandResult {
  const raw = body as {
    orderId?: unknown;
    userId?: unknown;
    totalAmount?: unknown;
  };

  const userId = typeof raw?.userId === "string" ? raw.userId.trim() : "";
  const totalAmount = Number(raw?.totalAmount);

  if (!userId || !Number.isFinite(totalAmount) || totalAmount <= 0) {
    return {
      ok: false,
      error: {
        userId,
        totalAmount,
      },
    };
  }

  const orderId =
    typeof raw?.orderId === "string" && raw.orderId.trim().length > 0
      ? raw.orderId.trim()
      : generateOrderId();

  return {
    ok: true,
    command: {
      orderId,
      userId,
      totalAmount,
    },
  };
}
