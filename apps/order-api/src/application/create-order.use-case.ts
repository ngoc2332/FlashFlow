import { Pool } from "pg";
import { createOrderCreatedEvent } from "@flashflow/common";
import { CreateOrderCommand, PENDING_PAYMENT_STATUS } from "../domain/order";
import {
  insertOrder,
  insertOutboxOrderCreated,
  upsertOrderStatusView,
} from "../infrastructure/order-write-repository";

export interface CreateOrderUseCaseInput {
  command: CreateOrderCommand;
  traceId: string;
  pool: Pool;
}

export interface CreateOrderUseCaseResult {
  orderId: string;
  eventId: string;
  status: string;
  traceId: string;
  totalAmount: number;
}

export async function createOrderUseCase(
  input: CreateOrderUseCaseInput,
): Promise<CreateOrderUseCaseResult> {
  const event = createOrderCreatedEvent({
    orderId: input.command.orderId,
    userId: input.command.userId,
    totalAmount: input.command.totalAmount,
    traceId: input.traceId,
  });

  const client = await input.pool.connect();

  try {
    await client.query("BEGIN");

    await insertOrder(client, {
      orderId: input.command.orderId,
      userId: input.command.userId,
      totalAmount: input.command.totalAmount,
    });

    await insertOutboxOrderCreated(client, event);

    await upsertOrderStatusView(client, {
      orderId: input.command.orderId,
      lastEventId: event.eventId,
    });

    await client.query("COMMIT");

    return {
      orderId: input.command.orderId,
      eventId: event.eventId,
      status: PENDING_PAYMENT_STATUS,
      traceId: event.traceId,
      totalAmount: input.command.totalAmount,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
