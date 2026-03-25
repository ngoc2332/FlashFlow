import { EventEnvelope } from "@flashflow/common";

export function resolveOutboxTopic(eventType: string): string {
  return eventType;
}

export function readOutboxEnvelope(value: unknown): Partial<EventEnvelope<unknown>> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Partial<EventEnvelope<unknown>>;
}
