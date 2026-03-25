import { Pool } from "pg";
import { findOrder, findOrderStatusView } from "../infrastructure/order-query-repository";

export type QueryOrderStatusUseCaseResult =
  | {
      result: "found_view";
      payload: {
        orderId: string;
        status: string;
        lastEventId: string;
        lastUpdatedAt: string;
      };
    }
  | {
      result: "found_orders";
      payload: {
        orderId: string;
        status: string;
        lastEventId: null;
        lastUpdatedAt: string;
      };
    }
  | {
      result: "not_found";
    };

export async function queryOrderStatusUseCase(
  pool: Pool,
  orderId: string,
): Promise<QueryOrderStatusUseCaseResult> {
  const statusView = await findOrderStatusView(pool, orderId);

  if (statusView) {
    return {
      result: "found_view",
      payload: {
        orderId: statusView.order_id,
        status: statusView.current_status,
        lastEventId: statusView.last_event_id,
        lastUpdatedAt: statusView.last_updated_at.toISOString(),
      },
    };
  }

  const orderRow = await findOrder(pool, orderId);

  if (orderRow) {
    return {
      result: "found_orders",
      payload: {
        orderId: orderRow.order_id,
        status: orderRow.status,
        lastEventId: null,
        lastUpdatedAt: orderRow.updated_at.toISOString(),
      },
    };
  }

  return {
    result: "not_found",
  };
}
