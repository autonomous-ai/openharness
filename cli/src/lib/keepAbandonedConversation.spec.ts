import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createKeepAbandonedConversation } from './keepAbandonedConversation.js'
import type { RegisteredSession } from './registry.js'
import { StoppedAgentStore } from './stoppedAgents.js'
import * as publication from './sessionPublication.js'

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
  afterEach(async () => { await store.close(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })

  it('keeps it as a stopped harness of its own, without the live process, and tells the windows', async () => {
    // The agent's own record, which follows it into the new conversation: it is not the one kept.
    await store.save(left())
    await createKeepAbandonedConversation({ stoppedAgents: store, publishStoppedAgent: publish })(left())
    const kept = (await store.list()).find((saved) => saved.agentId !== 'agent-1')!
    expect(kept).toMatchObject({ sessionId: 'session-0', engine: 'codex', transcriptPath: '/work/rollout.jsonl', processIdentity: null, active: false })
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ agentId: kept.agentId, sessionId: 'session-0' }))
    expect(console.log).toHaveBeenCalledWith(`[agent] agent-1 kept the conversation it left, session-, as stopped harness ${kept.agentId.slice(0, 8)}`)
  })

  it('keeps it once, keeps the same id under another Codex profile, and keeps nothing without a conversation', async () => {
    const keep = createKeepAbandonedConversation({ stoppedAgents: store, publishStoppedAgent: publish })
    await keep(left())
    await keep(left())
    expect((await store.list())).toHaveLength(1)
    await keep(left({ codexHome: '/profile' }))
    expect((await store.list())).toHaveLength(2)
    await keep(left({ sessionId: '' }))
    expect((await store.list())).toHaveLength(2)
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('does not publish a duplicate when a peer archive arrives during preparation', async () => {
    await store.save(left({ agentId: 'peer' }))
    const peerFile = join(dir, 'saved', 'peer.json'), peer = readFileSync(peerFile)
    rmSync(peerFile)
    const prepare = publication.prepareSessionPublication
    vi.spyOn(publication, 'prepareSessionPublication').mockImplementationOnce(async (...args) => {
      const prepared = await prepare(...args)
      // An older cooperative writer does not take the current child's write lease.
      writeFileSync(peerFile, peer, { mode: 0o600 })
      return prepared
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await createKeepAbandonedConversation({ stoppedAgents: store, publishStoppedAgent: publish })(left())
    expect((await store.list()).map(row => row.agentId)).toEqual(['peer'])
    expect(publish).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalled()
  })

  it.each(['unsafe', 'replaced'] as const)('refuses an %s archive container at the keep action', async state => {
    const saved = join(dir, 'saved')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    if (state === 'unsafe') {
      mkdirSync(join(dir, 'elsewhere'), { mode: 0o700 })
      symlinkSync(join(dir, 'elsewhere'), saved)
    } else {
      const query = store.query.bind(store)
      vi.spyOn(store, 'query').mockImplementationOnce(async (...args) => {
        const answer = await query(...args)
        renameSync(saved, join(dir, 'original'))
        mkdirSync(saved, { mode: 0o700 })
        return answer
      })
    }
    await createKeepAbandonedConversation({ stoppedAgents: store, publishStoppedAgent: publish })(left())
    expect(publish).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalled()
    if (state === 'replaced') expect(await store.list()).toEqual([])
  })

  it('does not confirm a saved row if its live authority is lost during directory sync', async () => {
    let current = true
    const prepare = publication.prepareSessionPublication
    vi.spyOn(publication, 'prepareSessionPublication').mockImplementationOnce(async (...args) => {
      const prepared = await prepare(...args)
      const sync = prepared.sync
      prepared.sync = async () => { await sync(); current = false }
      return prepared
    })
    await expect(store.save(left(), () => current)).rejects.toMatchObject({ constructor: expect.objectContaining({ name: 'AtomicWriteUnconfirmed' }) })
    expect((await store.get('agent-1'))?.sessionId).toBe('session-0')
  })

  it('does not confirm a peer replacement of the published target during directory sync', async () => {
    const prepare = publication.prepareSessionPublication
    vi.spyOn(publication, 'prepareSessionPublication').mockImplementationOnce(async (...args) => {
      const prepared = await prepare(...args), sync = prepared.sync
      prepared.sync = async () => {
        await sync()
        const file = join(dir, 'saved', 'agent-1.json')
        const row = JSON.parse(readFileSync(file, 'utf8'))
        row.session.cwd = '/peer-replacement'
        writeFileSync(file, JSON.stringify(row))
      }
      return prepared
    })
    await expect(store.save(left())).rejects.toMatchObject({ constructor: expect.objectContaining({ name: 'AtomicWriteUnconfirmed' }) })
    expect((await store.get('agent-1'))?.cwd).toBe('/peer-replacement')
  })

  it('says why it could not, and is never in the way; a window that cannot be told is not an error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const full = { prepareSave: () => {}, query: async () => ({ matches: [false], current: () => true, witness: 'fixture' }), get: async () => null, save: vi.fn<(row: RegisteredSession) => Promise<void>>(async () => { throw new Error('ENOSPC') }) }
    const keep = createKeepAbandonedConversation({ stoppedAgents: full, publishStoppedAgent: publish })
    await expect(keep(left())).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[agent] agent-1 could not keep the conversation it left, session- · ENOSPC')
    full.save.mockImplementationOnce(async () => { throw 'locked' })
    await keep(left())
    expect(warn).toHaveBeenCalledWith('[agent] agent-1 could not keep the conversation it left, session- · locked')
    // Saved, but it did not read back: nothing to tell the windows.
    full.save.mockImplementationOnce(async () => {})
    await keep(left())
    expect(publish).not.toHaveBeenCalled()

    publish.mockRejectedValueOnce(new Error('no window'))
    await createKeepAbandonedConversation({ stoppedAgents: store, publishStoppedAgent: publish })(left())
    expect(publish).toHaveBeenCalledTimes(1)
  })
})
