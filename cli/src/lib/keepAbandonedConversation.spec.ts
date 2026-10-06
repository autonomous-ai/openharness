import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createKeepAbandonedConversation } from './keepAbandonedConversation.js'
import type { RegisteredSession } from './registry.js'
import { StoppedAgentStore } from './stoppedAgents.js'

const pane = { backend: 'tmux' as const, paneId: '%4' }
/** The agent's row as it was in the conversation it left: its conversation, pane and live process. */
const left = (over: Partial<RegisteredSession> = {}) => ({
  schemaVersion: 2, agentId: 'agent-1', sessionId: 'session-0', engine: 'codex', codexHome: null, cwd: '/work',
  transcriptPath: '/work/rollout.jsonl', projectDir: 'work', runtimes: [pane], primaryRuntimeKey: '', tmuxPane: '%4',
  processIdentity: { pid: 7, startMarker: 'Mon Oct  5 03:00:00 2026', executable: 'codex' }, active: true,
  registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1, boundAt: 1, ...over,
}) as unknown as RegisteredSession

describe('keeping a conversation the daemon left for a new one', () => {
  let dir: string
  let store: StoppedAgentStore
  let publish: ReturnType<typeof vi.fn<(saved: RegisteredSession) => Promise<void>>>
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'keep-abandoned-'))
    store = new StoppedAgentStore(join(dir, 'saved'))
    publish = vi.fn<(saved: RegisteredSession) => Promise<void>>(async () => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })

  it('keeps it as a stopped harness of its own, without the live process, and tells the windows', () => {
    // The agent's own record, which follows it into the new conversation: it is not the one kept.
    store.save(left())
    createKeepAbandonedConversation({ stoppedAgents: store, publishStoppedAgent: publish })(left())
    const kept = store.list().find((saved) => saved.agentId !== 'agent-1')!
    expect(kept).toMatchObject({ sessionId: 'session-0', engine: 'codex', transcriptPath: '/work/rollout.jsonl', processIdentity: null, active: false })
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ agentId: kept.agentId, sessionId: 'session-0' }))
    expect(console.log).toHaveBeenCalledWith(`[agent] agent-1 kept the conversation it left, session-, as stopped harness ${kept.agentId.slice(0, 8)}`)
  })

  it('keeps it once, keeps the same id under another Codex profile, and keeps nothing without a conversation', () => {
    const keep = createKeepAbandonedConversation({ stoppedAgents: store, publishStoppedAgent: publish })
    keep(left())
    keep(left())
    expect(store.list()).toHaveLength(1)
    keep(left({ codexHome: '/profile' }))
    expect(store.list()).toHaveLength(2)
    keep(left({ sessionId: '' }))
    expect(store.list()).toHaveLength(2)
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('says why it could not, and is never in the way; a window that cannot be told is not an error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const full = { list: () => [], get: () => null, save: vi.fn<(row: RegisteredSession) => void>(() => { throw new Error('ENOSPC') }) }
    const keep = createKeepAbandonedConversation({ stoppedAgents: full, publishStoppedAgent: publish })
    expect(() => keep(left())).not.toThrow()
    expect(warn).toHaveBeenCalledWith('[agent] agent-1 could not keep the conversation it left, session- · ENOSPC')
    full.save.mockImplementationOnce(() => { throw 'locked' })
    keep(left())
    expect(warn).toHaveBeenCalledWith('[agent] agent-1 could not keep the conversation it left, session- · locked')
    // Saved, but it did not read back: nothing to tell the windows.
    full.save.mockImplementationOnce(() => {})
    keep(left())
    expect(publish).not.toHaveBeenCalled()

    publish.mockRejectedValueOnce(new Error('no window'))
    createKeepAbandonedConversation({ stoppedAgents: store, publishStoppedAgent: publish })(left())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(publish).toHaveBeenCalledTimes(1)
  })
})
