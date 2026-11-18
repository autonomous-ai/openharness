/** Cloud turn transitions belong to the component that owns these agents. */
import { createHash } from 'node:crypto'
import type { TurnCardFrame } from '../core/api.js'
import { cloudFingerprint, type CloudHarness } from '../lib/cloudAgents.js'

export interface CloudPresentation {
  fingerprint: string
  owners: Array<{ agentId: string; fingerprint: string; busy: boolean; told: string }>
}

export const emptyPresentation = (): CloudPresentation => ({ fingerprint: cloudFingerprint([]), owners: [] })

/** Preparing is pure: only acknowledged or reconciled publication advances the caller's checkpoint. */
export function prepareCloudCards(harnesses: readonly CloudHarness[], previous: CloudPresentation = emptyPresentation()) {
  const beforeById = new Map(previous.owners.map(owner => [owner.agentId, owner]))
  const imageHash = createHash('sha256').update('[')
  let imageBytes = 2
  const next: CloudPresentation = { fingerprint: '', owners: [] }
  const cards: TurnCardFrame[] = []
  for (const [index, harness] of harnesses.entries()) {
    // One transient encoding supplies both existing hashes and the publication's exact byte bound.
    const encoded = JSON.stringify(harness)
    if (index) imageHash.update(',')
    imageHash.update(encoded)
    imageBytes += Buffer.byteLength(encoded) + (index ? 1 : 0)
    const before = beforeById.get(harness.agentId)
    const busy = harness.state === 'working' || harness.state === 'starting'
    const fingerprint = createHash('sha256').update('[').update(encoded).update(']').digest('hex')
    const state = { agentId: harness.agentId, fingerprint, busy, told: before?.told ?? harness.said ?? '' }
    next.owners.push(state)
    // Core suppresses unchanged rows. A same-image publication therefore cannot change notification history.
    if (before?.fingerprint === state.fingerprint) continue
    const card = (payload: Record<string, unknown>): void => {
      cards.push({ type: 'commander_event', agentId: harness.agentId, dbSessionId: harness.agentId,
        ...(payload.kind === 'summary' ? { name: harness.name } : {}), payload })
    }
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
  next.fingerprint = imageHash.update(']').digest('hex')
  return { cards, next, imageBytes }
}
