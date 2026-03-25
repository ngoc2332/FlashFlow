import { EachMessagePayload } from "kafkajs";
import { EventEnvelope, HeaderValue, OrderCreatedPayload, headerToString } from "@flashflow/common";
import { parseOrderCreatedEvent } from "../domain/order-created-event";
import { decidePayment } from "../domain/payment-policy";

interface CounterLike {
  inc: (labels?: Record<string, string>, value?: number) => void;
}

interface HistogramLike {
  observe: (labels: Record<string, string>, value: number) => void;
}

interface LoggerLike {
  info: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
}

export interface ProcessPaymentMessageInput {
  payload: EachMessagePayload;
  serviceName: string;
  consumerGroup: string;
  orderCreatedTopic: string;
  failUserPrefix: string;
  approvalLimit: number;
  hasProcessedEvent: (eventId: string) => Promise<boolean>;
  markProcessedEvent: (eventId: string) => Promise<void>;
  commitOffset: (payload: EachMessagePayload) => Promise<void>;
  readOrderIdFromMessageKey: (message: EachMessagePayload["message"]) => string;
  publishOutcome: (
    event: EventEnvelope<OrderCreatedPayload>,
    decision: {
      status: "succeeded";
    } | {
      status: "failed";
      reason: string;
      retryable: false;
    },
  ) => Promise<void>;
  routeToRetryOrDlq: (
    payload: EachMessagePayload,
    orderId: string,
    error: Error,
  ) => Promise<{
    terminal: boolean;
    targetTopic: string;
    traceId: string;
    retryCount: number;
  }>;
  metrics: {
    processedEventsCounter: CounterLike;
    duplicateEventsCounter: CounterLike;
    processingFailuresCounter: CounterLike;
    processingDurationSeconds: HistogramLike;
  };
  logger: LoggerLike;
}

export async function processPaymentMessageUseCase(
  input: ProcessPaymentMessageInput,
): Promise<void> {
  const headers = input.payload.message.headers as Record<string, HeaderValue> | undefined;
  const targetWorker = headerToString(headers?.targetWorker);
  const startedAt = process.hrtime.bigint();
  let result = "success";

  if (input.payload.topic !== input.orderCreatedTopic && targetWorker !== input.serviceName) {
    await input.commitOffset(input.payload);
    result = "skipped_target_worker";
    input.metrics.processingDurationSeconds.observe(
      {
        service: input.serviceName,
        consumer_group: input.consumerGroup,
        topic: input.payload.topic,
        result,
      },
      Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
    );
    return;
  }

  let event: EventEnvelope<OrderCreatedPayload> | undefined;

  try {
    event = parseOrderCreatedEvent(input.payload.message.value);

    if (await input.hasProcessedEvent(event.eventId)) {
      input.metrics.duplicateEventsCounter.inc({
        service: input.serviceName,
        consumer_group: input.consumerGroup,
        topic: input.payload.topic,
      });
      input.logger.info("duplicate event skipped", {
        traceId: event.traceId,
        orderId: event.orderId,
        eventId: event.eventId,
        topic: input.payload.topic,
      });
      await input.commitOffset(input.payload);
      result = "duplicate";
      return;
    }

    const decision = decidePayment(event, {
      failUserPrefix: input.failUserPrefix,
      approvalLimit: input.approvalLimit,
    });
    await input.publishOutcome(event, decision);
    await input.markProcessedEvent(event.eventId);
    await input.commitOffset(input.payload);

    input.metrics.processedEventsCounter.inc({
      service: input.serviceName,
      consumer_group: input.consumerGroup,
      topic: input.payload.topic,
      event_type: event.eventType,
    });
    result = "processed";
  } catch (rawError) {
    const error = rawError instanceof Error ? rawError : new Error("Unknown processing error");
    const orderId = event?.orderId ?? input.readOrderIdFromMessageKey(input.payload.message);

    input.metrics.processingFailuresCounter.inc({
      service: input.serviceName,
      consumer_group: input.consumerGroup,
      topic: input.payload.topic,
      error_type: error.name,
    });

    const route = await input.routeToRetryOrDlq(input.payload, orderId, error);

    input.logger.error("message routed to retry or dlq", {
      traceId: route.traceId,
      orderId,
      sourceTopic: input.payload.topic,
      targetTopic: route.targetTopic,
      terminal: route.terminal,
      retryCount: route.retryCount,
      error,
    });

    if (route.terminal && event) {
      await input.markProcessedEvent(event.eventId);
    }

    await input.commitOffset(input.payload);
    result = route.terminal ? "routed_dlq" : "routed_retry";
  } finally {
    input.metrics.processingDurationSeconds.observe(
      {
        service: input.serviceName,
        consumer_group: input.consumerGroup,
        topic: input.payload.topic,
        result,
      },
      Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
    );
  }
}
