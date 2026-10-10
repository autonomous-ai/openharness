import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { liveFor } from '../../engines/live.js'
import { runtime as claudeRuntime } from '../../engines/claude/runtimeProfile.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { RuntimeProfileState } from '../../lib/runtimeProfileState.js'
import { createAttach } from './attach.js'
import { createSessionNormalizers } from './normalizers.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'attach-profile-'))
  roots.push(root)
  const path = join(root, 'session.jsonl')
  writeFileSync(path, `${JSON.stringify({ type: 'assistant', version: '2.1.209',
    message: { role: 'assistant', model: 'claude-opus-5', content: [] } })}\n`)
  const session = { agentId: 'agent', sessionId: 'session', engine: 'claude', cwd: root,
    transcriptPath: path, cliVersion: '2.1.100', model: 'claude-sonnet-4-6' } as RegisteredSession
  let finish!: (effort: string) => void, fail!: (error: Error) => void
  const configuredEffort = vi.fn(() => new Promise<string>((resolve, reject) => { finish = resolve; fail = reject }))
  const profiles = new RuntimeProfileState(() => ({ ...claudeRuntime, configuredEffort }), () => session)
  profiles.hydrate(session, [])
  profiles.confirmEffort(session.sessionId, 'high')
  const before = profiles.getState(session.sessionId)
  const normalizers = createSessionNormalizers()
  const oldParser = liveFor('claude')!.create(session)
  normalizers.liveParsers.set(session.sessionId, oldParser)
  const hold = { offset: statSync(path).size, expired: false, release: vi.fn() }
  const emit = vi.fn(), addSession = vi.fn(async () => {})
  const attach = createAttach({ setInterpretationHold: () => false, announceSession: vi.fn(), liveFor, normalizers, runtimeProfiles: profiles, resolve: () => session,
    terminalGone: async () => false, watcher: { removeSession: async () => {}, pollSession: async () => {}, hold: async () => hold, tails: () => true, addSession },
    cursorDiscovery: { add: async () => {} }, device: () => undefined,
    captureTerminal: async () => null, emit, announceTurnAborted: vi.fn(),
    questionWatcher: { start: vi.fn() }, terminalLabel: () => 'private fixture',
    dbs: { opencode: join(root, 'o.db'), kilo: join(root, 'k.db'), devin: join(root, 'd.db') },
    devinHome: root, hermesDb: async () => join(root, 'h.db'), concurrency: 1,
  })
  const attaching = attach.attachSession(session, true)
  return { session, profiles, before, normalizers, oldParser, hold, emit, addSession, configuredEffort,
    attaching, finish: (effort: string) => finish(effort), fail: (error: Error) => fail(error) }
}

it.each(['expired', 'superseded', 'failed', 'installed'] as const)(
  'publishes the local parser and profile together after config: %s', async outcome => {
    const p = setup()
    await vi.waitFor(() => expect(p.configuredEffort).toHaveBeenCalledOnce())
    // Reading history and waiting for config must expose neither its version nor its model.
    expect(p.profiles.getState(p.session.sessionId)).toEqual(p.before)
    expect(p.session.cliVersion).toBe('2.1.100')
    expect(p.normalizers.liveParsers.get(p.session.sessionId)).toBe(p.oldParser)
    if (outcome === 'expired') p.hold.expired = true
    if (outcome === 'superseded') p.profiles.confirmEffort(p.session.sessionId, 'high')
    if (outcome === 'failed') p.fail(new Error('private config unavailable'))
    else p.finish('low')
    expect(await p.attaching).toBe(true)
    expect(p.hold.release).toHaveBeenCalled()
    if (outcome === 'installed') {
      expect(p.profiles.getState(p.session.sessionId)).toMatchObject({ model: 'claude-opus-5', effort: 'low', cliVersion: '2.1.209' })
      expect(p.session.cliVersion).toBe('2.1.209')
      expect(p.normalizers.liveParsers.get(p.session.sessionId)).not.toBe(p.oldParser)
    } else {
      expect(p.profiles.getState(p.session.sessionId)).toMatchObject({ ...p.before, observedAt: expect.any(Number) })
      expect(p.session.cliVersion).toBe('2.1.100')
      expect(p.normalizers.liveParsers.get(p.session.sessionId)).toBe(p.oldParser)
      expect(p.emit).not.toHaveBeenCalled()
      expect(p.addSession).not.toHaveBeenCalled()
    }
    p.profiles.forget(p.session.sessionId)
  },
)
