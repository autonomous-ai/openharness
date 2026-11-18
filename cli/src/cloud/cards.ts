/** Cloud turn transitions belong to the component that owns these agents. */
import type { TurnCardFrame } from '../core/api.js'
import type { CloudHarness } from '../lib/cloudAgents.js'

export function createCloudCards() {
  let previous = new Map<string, { busy: boolean; told: string }>()
  return (harnesses: readonly CloudHarness[], reconnect = false): TurnCardFrame[] => {
    if (reconnect) previous.clear()
    const next = new Map<string, { busy: boolean; told: string }>()
    const cards: TurnCardFrame[] = []
    for (const harness of harnesses) {
      const before = previous.get(harness.agentId)
      const busy = harness.state === 'working' || harness.state === 'starting'
      const state = { busy, told: before?.told ?? harness.said ?? '' }
      next.set(harness.agentId, state)
      const card = (payload: Record<string, unknown>): void => {
        cards.push({ type: 'commander_event', agentId: harness.agentId, dbSessionId: harness.agentId,
          ...(payload.kind === 'summary' ? { name: harness.name } : {}), payload })
      }
      // A stopped harness has no tile. First-seen answers are history, not new notifications.
      if (harness.state === 'stopped') continue
      if (busy) {
        if (!before?.busy) card({ kind: 'processing', text: harness.activity ?? 'Working…' })
      } else if (before) {
        if (harness.said && harness.card && harness.said !== state.told) {
          state.told = harness.said
          card({ kind: 'summary', ...harness.card, ...(harness.state === 'failed' ? { failed: true } : {}),
            notification: harness.state === 'needs_input' ? null : { id: `${harness.agentId}:${harness.messages}`, kind: 'done' } })
        } else if (before.busy) {
          card(harness.state === 'failed' ? { kind: 'error', text: harness.activity ?? 'It stopped with an error.' }
            : { kind: 'done', text: 'done' })
        }
      }
    }
    previous = next
    return cards
  }
}
