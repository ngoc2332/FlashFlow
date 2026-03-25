import { Producer } from "kafkajs";
import { buildKafkaHeaders } from "@flashflow/common";
import { readOutboxEnvelope, resolveOutboxTopic } from "../domain/outbox-event";
import { OutboxRow } from "./outbox-repository";

export interface PublishOutboxRowResult {
  topic: string;
  eventType: string;
}

export async function publishOutboxRow(
  producer: Producer,
  serviceName: string,
  row: OutboxRow,
): Promise<PublishOutboxRowResult> {
  const topic = resolveOutboxTopic(row.event_type);
  const envelope = readOutboxEnvelope(row.payload);
  const traceId =
    typeof envelope.traceId === "string" && envelope.traceId.trim().length > 0
      ? envelope.traceId
      : row.event_id;
  const eventType =
    typeof envelope.eventType === "string" && envelope.eventType.trim().length > 0
      ? envelope.eventType
      : row.event_type;
  const schemaVersion =
    typeof envelope.schemaVersion === "number" ? envelope.schemaVersion : 1;
  const eventKind = envelope.eventKind === "domain" ? "domain" : "integration";

  await producer.send({
    topic,
    messages: [
      {
        key: row.aggregate_id,
        value: JSON.stringify(row.payload),
        headers: buildKafkaHeaders({
          source: serviceName,
          traceId,
          eventId: row.event_id,
          orderId: row.aggregate_id,
          schemaVersion,
          eventKind,
          eventType,
        }),
      },
    ],
  });

  return {
    topic,
    eventType,
  };
}
