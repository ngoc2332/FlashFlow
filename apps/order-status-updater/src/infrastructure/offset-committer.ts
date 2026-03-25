import { Consumer, EachMessagePayload } from "kafkajs";
import { nextOffset } from "@flashflow/common";

export async function commitMessageOffset(
  consumer: Consumer,
  payload: EachMessagePayload,
): Promise<void> {
  await consumer.commitOffsets([
    {
      topic: payload.topic,
      partition: payload.partition,
      offset: nextOffset(payload.message.offset),
    },
  ]);
}
