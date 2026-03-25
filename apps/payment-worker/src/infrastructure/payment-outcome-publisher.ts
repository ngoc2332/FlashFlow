import { EachMessagePayload, Producer } from "kafkajs";
import {
  EventEnvelope,
  HeaderValue,
  OrderCreatedPayload,
  RetryPolicy,
  buildKafkaHeaders,
  createDeterministicEventId,
  createPaymentFailedEvent,
  createPaymentSucceededEvent,
  normalizeHeaders,
  parseRetryCount,
  resolveRetryTarget,
  resolveTraceIdFromKafkaHeaders,
} from "@flashflow/common";
import { PaymentDecision } from "../domain/payment-policy";

export async function publishPaymentOutcome(
  producer: Producer,
  input: {
    serviceName: string;
    outputTopic: string;
    event: EventEnvelope<OrderCreatedPayload>;
    decision: PaymentDecision;
  },
): Promise<{ eventType: string; eventId: string; traceId: string; orderId: string }> {
  const outputEventType =
    input.decision.status === "succeeded" ? "payment.succeeded" : "payment.failed";
  const outputEventId = createDeterministicEventId(`${input.event.eventId}:${outputEventType}`);

  const paymentEvent =
    input.decision.status === "succeeded"
      ? createPaymentSucceededEvent({
          eventId: outputEventId,
          orderId: input.event.orderId,
          userId: input.event.payload.userId,
          totalAmount: input.event.payload.totalAmount,
          traceId: input.event.traceId,
        })
      : createPaymentFailedEvent({
          eventId: outputEventId,
          orderId: input.event.orderId,
          userId: input.event.payload.userId,
          totalAmount: input.event.payload.totalAmount,
          reason: input.decision.reason,
          retryable: input.decision.retryable,
          traceId: input.event.traceId,
        });

  await producer.send({
    topic: input.outputTopic,
    messages: [
      {
        key: input.event.orderId,
        value: JSON.stringify(paymentEvent),
        headers: buildKafkaHeaders({
          source: input.serviceName,
          traceId: paymentEvent.traceId,
          eventId: paymentEvent.eventId,
          orderId: paymentEvent.orderId,
          schemaVersion: paymentEvent.schemaVersion,
          eventKind: paymentEvent.eventKind,
          eventType: paymentEvent.eventType,
        }),
      },
    ],
  });

  return {
    eventType: paymentEvent.eventType,
    eventId: paymentEvent.eventId,
    traceId: paymentEvent.traceId,
    orderId: paymentEvent.orderId,
  };
}

export async function routePaymentMessageToRetryOrDlq(
  producer: Producer,
  input: {
    serviceName: string;
    retryPolicy: RetryPolicy;
    payload: EachMessagePayload;
    orderId: string;
    error: Error;
  },
): Promise<{
  terminal: boolean;
  targetTopic: string;
  traceId: string;
  retryCount: number;
}> {
  const headers = input.payload.message.headers as Record<string, HeaderValue> | undefined;
  const retryCount = parseRetryCount(headers);
  const route = resolveRetryTarget(input.error, retryCount, input.retryPolicy);
  const normalizedHeaders = normalizeHeaders(headers);
  const messageValue = input.payload.message.value
    ? input.payload.message.value.toString("utf8")
    : "{}";
  const traceId =
    resolveTraceIdFromKafkaHeaders(headers) ??
    normalizedHeaders.traceId ??
    normalizedHeaders["x-trace-id"] ??
    input.orderId;

  await producer.send({
    topic: route.topic,
    messages: [
      {
        key: input.orderId,
        value: messageValue,
        headers: {
          ...normalizedHeaders,
          ...buildKafkaHeaders({
            source: input.serviceName,
            traceId,
            eventId: normalizedHeaders.eventId,
            orderId: input.orderId,
            eventType: normalizedHeaders.eventType,
          }),
          retryCount: String(route.nextRetryCount),
          sourceTopic: input.payload.topic,
          sourceService: input.serviceName,
          targetWorker: input.serviceName,
          errorType: input.error.name,
          errorMessage: input.error.message,
          failedAt: new Date().toISOString(),
        },
      },
    ],
  });

  return {
    terminal: route.terminal,
    targetTopic: route.topic,
    traceId,
    retryCount,
  };
}
