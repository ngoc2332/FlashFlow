import { EachMessagePayload, Producer } from "kafkajs";
import {
  HeaderValue,
  RetryPolicy,
  buildKafkaHeaders,
  normalizeHeaders,
  parseRetryCount,
  resolveRetryTarget,
  resolveTraceIdFromKafkaHeaders,
} from "@flashflow/common";

export async function routeStatusMessageToRetryOrDlq(
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
