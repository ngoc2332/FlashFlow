import { Producer } from "kafkajs";
import { EventEnvelope, buildKafkaHeaders } from "@flashflow/common";

export async function publishOrderStatusSnapshot(
  producer: Producer,
  input: {
    serviceName: string;
    topic: string;
    event: EventEnvelope<unknown>;
    currentStatus: string;
    lastEventId: string;
    lastUpdatedAt: string;
  },
): Promise<void> {
  const snapshot = {
    orderId: input.event.orderId,
    currentStatus: input.currentStatus,
    sourceEventType: input.event.eventType,
    lastEventId: input.lastEventId,
    traceId: input.event.traceId,
    updatedAt: input.lastUpdatedAt,
  };

  await producer.send({
    topic: input.topic,
    messages: [
      {
        key: input.event.orderId,
        value: JSON.stringify(snapshot),
        headers: buildKafkaHeaders({
          source: input.serviceName,
          traceId: input.event.traceId,
          eventId: input.lastEventId,
          orderId: input.event.orderId,
          eventType: input.event.eventType,
        }),
      },
    ],
  });
}
