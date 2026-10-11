/**
 * The card without its `update`. That sentence is the Pro's alone (a local cable tee); the relay to the cloud and the
 * Wi-Fi devices get the card as they always did.
 */
export function withoutUpdate<T extends { type?: string; payload?: unknown }>(frame: T): T {
  const payload = frame.payload as Record<string, unknown> | undefined
  if (frame.type !== 'commander_event' || !payload || payload.kind !== 'processing' || !('update' in payload)) return frame
  const { update: _update, ...rest } = payload
  return { ...frame, payload: rest }
}
