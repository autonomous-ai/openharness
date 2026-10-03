import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { TeamMailbox } from './mailbox.js'

it('keeps swarm input off before opt-in, on disable, and across recipient restarts', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-swarm-gate-'))
  let enabled = false, sends = 0, cancels = 0
  const create = () => new TeamMailbox({ stateDir: root,
    runtime: () => ({ name: 'peer', engine: 'codex', available: true }),
    channelsEnabled: () => enabled, send: () => { sends++ }, cancel: () => { cancels++; return true } })
  let box = create()
  const delivery = { id: `team:${'1'.repeat(32)}:${'2'.repeat(32)}:intro`, agentId: 'peer', text: 'Peers are available.', channel: true, expiresAt: Date.now() + 60_000 }
  try {
    box.accept(delivery); box.pump()
    expect(sends).toBe(0)
    expect(box.canWrite(delivery.id)).toBe(false)
    enabled = true; box.pump()
    expect(sends).toBe(1)
    expect(box.canWrite(delivery.id)).toBe(true)
    enabled = false; box.pump()
    expect(cancels).toBe(1)
    expect(box.canWrite(delivery.id)).toBe(false)
    expect(box.status(delivery.id)?.state).toBe('queued')
    box.stop(); box = create(); box.pump()
    expect(sends).toBe(1)
    expect(() => box.accept({ ...delivery, channel: undefined })).toThrow('different content')
    enabled = true; box.pump()
    expect(sends).toBe(2)
    box.observe({ sessionId: 'peer', deliveryId: delivery.id, state: 'started' })
    enabled = false; box.pump(); enabled = true; box.pump()
    expect(sends).toBe(2)
  } finally { box.stop(); rmSync(root, { recursive: true, force: true }) }
})
