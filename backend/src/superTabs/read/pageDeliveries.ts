/**
 * The messages page's receipts by message (store.ts messages). Filtering every delivery of the page per message was 1.4 M
 * calls in the 2026-11-02 prod profiles (12 profiles), on every messages read: one pass groups them instead.
 */

/** [deliveries] by their message, each list in input order, so a page's filter and receipt sort see what they saw before. */
export function deliveriesByMessage<D extends { messageId: string }>(deliveries: readonly D[]): ReadonlyMap<string, D[]> {
  const byMessage = new Map<string, D[]>()
  for (const delivery of deliveries) {
    const own = byMessage.get(delivery.messageId)
    if (own) own.push(delivery)
    else byMessage.set(delivery.messageId, [delivery])
  }
  return byMessage
}
