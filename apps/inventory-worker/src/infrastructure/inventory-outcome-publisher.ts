import { EachMessagePayload, Producer } from "kafkajs";
import {
  EventEnvelope,
  HeaderValue,
  PaymentSucceededPayload,
  RetryPolicy,
  buildKafkaHeaders,
  createDeterministicEventId,
  createInventoryRejectedEvent,
  createInventoryReservedEvent,
  normalizeHeaders,
  parseRetryCount,
  resolveRetryTarget,
  resolveTraceIdFromKafkaHeaders,
} from "@flashflow/common";
import { InventoryDecision } from "../domain/inventory-policy";

export async function publishInventoryOutcome(
  producer: Producer,
  input: {
    serviceName: string;
    outputTopic: string;
    event: EventEnvelope<PaymentSucceededPayload>;
    decision: InventoryDecision;
  },
): Promise<{ eventType: string; eventId: string; traceId: string; orderId: string }> {
  const outputEventType =
    input.decision.status === "reserved" ? "inventory.reserved" : "inventory.rejected";
  const outputEventId = createDeterministicEventId(`${input.event.eventId}:${outputEventType}`);

  const inventoryEvent =
    input.decision.status === "reserved"
      ? createInventoryReservedEvent({
          eventId: outputEventId,
          orderId: input.event.orderId,
          userId: input.event.payload.userId,
          totalAmount: input.event.payload.totalAmount,
          traceId: input.event.traceId,
        })
      : createInventoryRejectedEvent({
          eventId: outputEventId,
          orderId: input.event.orderId,
          userId: input.event.payload.userId,
          totalAmount: input.event.payload.totalAmount,
          traceId: input.event.traceId,
          reason: input.decision.reason,
        });

  await producer.send({
    topic: input.outputTopic,
    messages: [
      {
        key: input.event.orderId,
        value: JSON.stringify(inventoryEvent),
        headers: buildKafkaHeaders({
          source: input.serviceName,
          traceId: inventoryEvent.traceId,
          eventId: inventoryEvent.eventId,
          orderId: inventoryEvent.orderId,
          schemaVersion: inventoryEvent.schemaVersion,
          eventKind: inventoryEvent.eventKind,
          eventType: inventoryEvent.eventType,
        }),
      },
    ],
  });

  return {
    eventType: inventoryEvent.eventType,
    eventId: inventoryEvent.eventId,
    traceId: inventoryEvent.traceId,
    orderId: inventoryEvent.orderId,
  };
}

export async function routeInventoryMessageToRetryOrDlq(
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
