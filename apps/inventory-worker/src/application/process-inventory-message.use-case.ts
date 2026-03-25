import { EachMessagePayload } from "kafkajs";
import { EventEnvelope, HeaderValue, PaymentSucceededPayload, headerToString } from "@flashflow/common";
import { InventoryDecision, decideInventory } from "../domain/inventory-policy";
import { parseEnvelope, parsePaymentSucceededEvent } from "../domain/payment-succeeded-event";

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

export interface ProcessInventoryMessageInput {
  payload: EachMessagePayload;
  serviceName: string;
  consumerGroup: string;
  paymentEventsTopic: string;
  failUserPrefix: string;
  rejectUserPrefix: string;
  reserveLimit: number;
  hasProcessedEvent: (eventId: string) => Promise<boolean>;
  markProcessedEvent: (eventId: string) => Promise<void>;
  commitOffset: (payload: EachMessagePayload) => Promise<void>;
  readOrderIdFromMessageKey: (message: EachMessagePayload["message"]) => string;
  publishOutcome: (
    event: EventEnvelope<PaymentSucceededPayload>,
    decision: InventoryDecision,
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

export async function processInventoryMessageUseCase(
  input: ProcessInventoryMessageInput,
): Promise<void> {
  const headers = input.payload.message.headers as Record<string, HeaderValue> | undefined;
  const targetWorker = headerToString(headers?.targetWorker);
  const startedAt = process.hrtime.bigint();
  let result = "success";

  if (input.payload.topic !== input.paymentEventsTopic && targetWorker !== input.serviceName) {
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

  let envelope: EventEnvelope<unknown> | undefined;

  try {
    envelope = parseEnvelope(input.payload.message.value);

    if (await input.hasProcessedEvent(envelope.eventId)) {
      input.metrics.duplicateEventsCounter.inc({
        service: input.serviceName,
        consumer_group: input.consumerGroup,
        topic: input.payload.topic,
      });
      input.logger.info("duplicate event skipped", {
        traceId: envelope.traceId,
        orderId: envelope.orderId,
        eventId: envelope.eventId,
        topic: input.payload.topic,
      });
      await input.commitOffset(input.payload);
      result = "duplicate";
      return;
    }

    const paymentSucceededEvent = parsePaymentSucceededEvent(envelope);

    if (!paymentSucceededEvent) {
      await input.commitOffset(input.payload);
      result = "ignored_event_type";
      return;
    }

    const decision = decideInventory(paymentSucceededEvent, {
      failUserPrefix: input.failUserPrefix,
      rejectUserPrefix: input.rejectUserPrefix,
      reserveLimit: input.reserveLimit,
    });

    await input.publishOutcome(paymentSucceededEvent, decision);
    await input.markProcessedEvent(envelope.eventId);
    await input.commitOffset(input.payload);

    input.metrics.processedEventsCounter.inc({
      service: input.serviceName,
      consumer_group: input.consumerGroup,
      topic: input.payload.topic,
      event_type: envelope.eventType,
    });
    result = "processed";
  } catch (rawError) {
    const error = rawError instanceof Error ? rawError : new Error("Unknown processing error");
    const orderId = envelope?.orderId ?? input.readOrderIdFromMessageKey(input.payload.message);

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

    if (route.terminal && envelope) {
      await input.markProcessedEvent(envelope.eventId);
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
