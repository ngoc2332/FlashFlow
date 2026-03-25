const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseOrderId(value: unknown): string | undefined {
  const orderId = typeof value === "string" ? value.trim() : "";

  if (!uuidRegex.test(orderId)) {
    return undefined;
  }

  return orderId;
}
