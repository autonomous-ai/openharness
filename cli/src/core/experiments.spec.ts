import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSettingsPath, readAgentSettings } from '../lib/agentSettings.js'
import type { AuthSession } from '../lib/authSession.js'
import { setAgentSettingsForTest, signedOutForTest } from '../testing/agentSettings.js'
import { EXPERIMENTS, type BackendNotice } from './api.js'
import { AGENT_SETTINGS_SIGNED_OUT, AGENT_SETTINGS_SYNC_MS, createAccountNotices, createAgentSettingsSync, createExperimentHooks, stateIsThere, wakeExperiments } from './experiments.js'

describe('the experiments on as the core starts', () => {
  let dataDir: string
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'experiments-')) })
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); signedOutForTest() })
  it('finds saved state by path, or by a file of its kind in its folder', () => {
    expect(stateIsThere(dataDir, ['agent-messages'])).toBe(false)
    expect(stateIsThere(dataDir, ['orchestrator/*.json'])).toBe(false)
    mkdirSync(join(dataDir, 'orchestrator'))
    // A folder made by a look, with no project in it, is not a project.
    writeFileSync(join(dataDir, 'orchestrator', 'notes.txt'), '')
    expect(stateIsThere(dataDir, ['orchestrator/*.json'])).toBe(false)
    writeFileSync(join(dataDir, 'orchestrator', `${'a'.repeat(32)}.json`), '{}')
    expect(stateIsThere(dataDir, ['orchestrator/*.json'])).toBe(true)
    mkdirSync(join(dataDir, 'agent-messages'))
    expect(stateIsThere(dataDir, ['nothing', 'agent-messages'])).toBe(true)
    expect(stateIsThere(dataDir, [])).toBe(false)
  })

  it('finds a file by a prefix and a suffix, as the Swarm host journal is named', () => {
    const journal = ['super-tabs/host-*.json']
    expect(stateIsThere(dataDir, journal)).toBe(false)
    mkdirSync(join(dataDir, 'super-tabs'))
    // Its other files in the folder are not a host.
    for (const name of ['native-m1.json', 'host-m1.txt', 'retained.json']) writeFileSync(join(dataDir, 'super-tabs', name), '{}')
    expect(stateIsThere(dataDir, journal)).toBe(false)
    writeFileSync(join(dataDir, 'super-tabs', `host-${'a'.repeat(32)}.json`), '{}')
    expect(stateIsThere(dataDir, journal)).toBe(true)
  })

  it('asks for each experiment in its own process that has saved state, and for no other', () => {
    mkdirSync(join(dataDir, 'orchestrator'))
    writeFileSync(join(dataDir, 'orchestrator', 'p.json'), '{}')
    writeFileSync(join(dataDir, 'harness-shares.json'), '[]')
    const want = vi.fn()
    const woken = wakeExperiments({
      dataDir,
      experiments: { orchestrator: { state: ['orchestrator/*.json'] }, sharing: { state: ['harness-shares.json'] }, messages: { state: ['agent-messages'] } },
      // Share runs in the core's process here: it is started there, not asked for.
      outOfProcess: new Set(['orchestrator', 'messages']),
      want,
    })
    expect(woken).toEqual(['orchestrator'])
    expect(want.mock.calls).toEqual([['orchestrator']])
  })

  it('asks for none on a fresh data folder, whatever the account\'s switches say: no switch starts an experiment', () => {
    // Agent Messages was the one a switch started, and left the experiments for the edge host (2026-10-12): its
    // agents' note no longer needs a process of its own started for it.
    expect(Object.keys(EXPERIMENTS)).not.toContain('messages')
    const outOfProcess = new Set([...Object.keys(EXPERIMENTS), 'messages'])
    for (const agentMessages of [true, false]) {
      setAgentSettingsForTest(dataDir, { agentMessages })
      const want = vi.fn()
      expect(wakeExperiments({ dataDir, experiments: EXPERIMENTS, outOfProcess, want })).toEqual([])
      expect(want).not.toHaveBeenCalled()
    }
  })

  it('hands the account\'s notices to each listener here, guarded, and to the experiments\' processes', () => {
    const tell = vi.fn()
    const log = vi.fn()
    const notices = createAccountNotices(tell, log)
    const heard = vi.fn()
    const stop = notices.onNotice(heard)
    notices.onNotice(() => { throw new Error('boom') })
    notices.onNotice(() => { throw 'odd' })
    notices.notice({ type: 'desk_changed', revision: 3 })
    stop()
    notices.notice({ type: 'desk_changed', revision: 4 })
    expect(heard.mock.calls).toEqual([[{ type: 'desk_changed', revision: 3 }]])
    expect(tell).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('odd'))
  })

  it('logs to the console when given no log of its own', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const notices = createAccountNotices(() => {})
      notices.onNotice(() => { throw new Error('boom') })
      notices.notice({ type: 'desk_changed', revision: 1 })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'))
    } finally {
      warn.mockRestore()
    }
  })

  it('asks for an experiment, and tells each experiment in its own process the account\'s notices', () => {
    const order: string[] = []
    const notify = vi.fn(() => true)
    const hooks = createExperimentHooks({
      want: (service) => order.push(`want ${service}`), notify, outOfProcess: new Set(['sharing']), experiments: ['orchestrator', 'sharing'],
    })
    hooks.want('sharing')
    hooks.want('orchestrator')
    expect(order).toEqual(['want sharing', 'want orchestrator'])
    const heard = vi.fn()
    hooks.onNotice(heard)
    hooks.notice({ type: 'desk_changed', revision: 5 })
    expect(heard).toHaveBeenCalledWith({ type: 'desk_changed', revision: 5 })
    expect(notify.mock.calls).toEqual([['sharing', { type: 'service_event', payload: { kind: 'notice', notice: { type: 'desk_changed', revision: 5 } } }]])
    createExperimentHooks({ want: vi.fn(), notify, outOfProcess: new Set(), experiments: [] }).want('x')
  })
})

describe('the account\'s agent experiments, kept for this computer', () => {
  let dataDir: string
  let session: AuthSession | null
  let answers: Array<(method: string, body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>>
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'agent-settings-sync-'))
    session = { version: 1, accessToken: 't', autonomousEnv: 'prod', computerId: 'c', machineId: 'm1', updatedAt: 0 }
    answers = []
  })
  afterEach(() => { vi.useRealTimers(); rmSync(dataDir, { recursive: true, force: true }) })

  const OFF = { agentsStartAgents: false, pullRequestLine: false, agentMessages: false, agentMessagesHideSummary: false, agentsTellAgents: false, programsReply: false }
  /** The account's answer, as backend routes/experimentalSettings.ts gives it. */
  const account = (features: Record<string, boolean>, accountId = 'acct') =>
    ({ status: 200, body: { success: true, data: { accountId, revision: 1, features: { share_button: false, ...features }, available: {} } } })

  function setup(over: { log?: (line: string) => void; dataDir?: string; everyMs?: number | null } = {}) {
    let listener: ((notice: BackendNotice) => void) | null = null
    const unsubscribe = vi.fn()
    const backend = vi.fn(async (method: string, path: string, body?: unknown) => {
      expect(path).toBe('/api/experimental-settings')
      const next = answers.shift()
      if (!next) throw new Error('nothing to answer')
      return next(method, body)
    })
    const want = vi.fn()
    const sync = createAgentSettingsSync({
      dataDir: over.dataDir ?? dataDir, backend, session: () => session, messagesChanged: want,
      ...(over.everyMs === null ? {} : { everyMs: over.everyMs ?? 1_000 }),
      onNotice: (l) => { listener = l; return unsubscribe },
      ...(over.log ? { log: over.log } : {}),
    })
    return { sync, backend, want, unsubscribe, notice: (notice: BackendNotice) => listener?.(notice) }
  }
  const answer = (reply: { status: number; body: Record<string, unknown> }) => answers.push(async () => reply)
  const kept = () => readAgentSettings(dataDir, session)

  it('reads them as the core starts, at desk_changed and every few minutes, and asks for one turned on', async () => {
    // Turned on from another computer: this one hears desk_changed (the backend publishes one), or reads them again
    // within AGENT_SETTINGS_SYNC_MS when it missed it.
    expect(AGENT_SETTINGS_SYNC_MS).toBe(5 * 60_000)
    vi.useFakeTimers()
    const t = setup()
    answer(account({ agent_messages: true }))
    t.sync.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.backend).toHaveBeenCalledExactlyOnceWith('GET', '/api/experimental-settings')
    expect(kept()).toEqual({ ...OFF, agentMessages: true })
    expect(JSON.parse(readFileSync(agentSettingsPath(dataDir), 'utf8'))).toMatchObject({ accountId: 'acct', machineId: 'm1', agentMessages: true })
    // Agent Messages is told now, so its agents get its note without waiting for a request or the next start (a fresh
    // Mac, 2026-10-12).
    expect(t.want).toHaveBeenCalledOnce()
    t.sync.start()
    // Another notice is not one of theirs; desk_changed is. Left on: not told again.
    t.notice({ type: 'zoo_changed', revision: 2 })
    answer(account({ agent_messages: true, agents_start_agents: true }))
    t.notice({ type: 'desk_changed', revision: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(t.backend).toHaveBeenCalledTimes(2)
    expect(kept()).toEqual({ ...OFF, agentMessages: true, agentsStartAgents: true })
    expect(t.want).toHaveBeenCalledTimes(1)
    // The safety net: turned off, and told so, so it withdraws its notes.
    answer(account({}))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(t.backend).toHaveBeenCalledTimes(3)
    expect(kept()).toEqual(OFF)
    expect(t.want).toHaveBeenCalledTimes(2)
    t.sync.stop()
    t.sync.stop()
    expect(t.unsubscribe).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.backend).toHaveBeenCalledTimes(3)
  })

  it('reads them again every five minutes when not told otherwise', async () => {
    vi.useFakeTimers()
    const t = setup({ everyMs: null })
    answer(account({}))
    answer(account({ agent_messages: true }))
    t.sync.start()
    await vi.advanceTimersByTimeAsync(AGENT_SETTINGS_SYNC_MS - 1)
    expect(t.backend).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.backend).toHaveBeenCalledTimes(2)
    expect(kept()).toEqual({ ...OFF, agentMessages: true })
    t.sync.stop()
  })

  it('reads nothing signed out, and keeps no answer for another sign-in, or a failed one', async () => {
    const log = vi.fn()
    const t = setup({ log })
    session = null
    await t.sync.sync()
    // Signed in, with no machine yet.
    session = { version: 1, accessToken: 't', autonomousEnv: 'prod', computerId: 'c', updatedAt: 0 }
    await t.sync.sync()
    expect(t.backend).not.toHaveBeenCalled()
    session = { version: 1, accessToken: 't', autonomousEnv: 'prod', computerId: 'c', machineId: 'm1', updatedAt: 0 }
    // Signed in to another account while it was asked (core rule 6): the answer may be that account's.
    answers.push(async () => { session = { ...session!, machineId: 'm2' }; return account({ agent_messages: true }) })
    await t.sync.sync()
    expect(readAgentSettings(dataDir, { ...session!, machineId: 'm1' })).toEqual(OFF)
    session = { ...session!, machineId: 'm1', signInAcct: 'acct' }
    // An answer for another account than the one this sign-in was made to.
    answer(account({ agent_messages: true }, 'other'))
    // The backend out of reach, or answering anything else.
    answer({ status: 401, body: { success: false, error: { code: 'UNAUTHORIZED', message: 'expired' } } })
    answers.push(async () => { throw new Error('offline') })
    answers.push(async () => { throw 'odd' })
    for (let i = 0; i < 4; i++) await t.sync.sync()
    expect(kept()).toEqual(OFF)
    expect(t.want).not.toHaveBeenCalled()
    expect(log.mock.calls).toEqual([[expect.stringContaining('offline')], [expect.stringContaining('odd')]])
  })

  it('says, rather than throws, when the copy cannot be kept', async () => {
    const log = vi.fn()
    const t = setup({ log, dataDir: join(dataDir, 'missing') })
    answer(account({ agent_messages: true }))
    await t.sync.sync()
    expect(log).toHaveBeenCalledWith(expect.stringContaining("the agents' settings could not be kept"))
    answers.push(async () => { throw 'odd' })
    await t.sync.sync()
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('odd'))
    expect(t.want).not.toHaveBeenCalled()
  })

  it('logs to the console when given no log of its own', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const t = setup()
      await t.sync.sync()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('nothing to answer'))
    } finally {
      warn.mockRestore()
    }
  })

  it('reads one at a time: one asked for meanwhile reads once more after it', async () => {
    const t = setup()
    let release!: () => void
    answers.push(() => new Promise((done) => { release = () => done(account({})) }))
    answer(account({ agent_messages: true }))
    const first = t.sync.sync()
    const second = t.sync.sync()
    const third = t.sync.sync()
    await Promise.resolve()
    expect(t.backend).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([first, second, third])
    // The one after saw the change the first answer predated.
    expect(t.backend).toHaveBeenCalledTimes(2)
    expect(kept()).toEqual({ ...OFF, agentMessages: true })
  })

  it('passes the windows\' reads and writes of the account\'s experiments through, and keeps what they say here at once', async () => {
    const t = setup()
    answer(account({ agent_pull_request_line: true }))
    expect(await t.sync.experimentalRead()).toEqual(account({ agent_pull_request_line: true }))
    expect(kept()).toEqual({ ...OFF, pullRequestLine: true })
    answers.push(async (method, body) => {
      expect([method, body]).toEqual(['PATCH', { accountId: 'acct', feature: 'agent_messages', enabled: true }])
      return account({ agent_pull_request_line: true, agent_messages: true })
    })
    expect((await t.sync.experimentalWrite({ accountId: 'acct', feature: 'agent_messages', enabled: true })).status).toBe(200)
    expect(kept()).toEqual({ ...OFF, pullRequestLine: true, agentMessages: true })
    expect(t.want).toHaveBeenCalledOnce()
    // A refusal is passed on as it is, and changes nothing here.
    const refused = { status: 409, body: { success: false, error: { code: 'ACCOUNT_CHANGED', message: 'Your account changed.' } } }
    answer(refused)
    expect(await t.sync.experimentalWrite({})).toEqual(refused)
    expect(kept()).toEqual({ ...OFF, pullRequestLine: true, agentMessages: true })
  })

  it('answers `harness settings` with the settings as kept here, and whether this computer is signed in', async () => {
    const t = setup()
    expect(await t.sync.settingsRead()).toEqual({ status: 200, body: { ...OFF, signedIn: true } })
    answer(account({ agents_start_agents: true }))
    await t.sync.sync()
    expect(await t.sync.settingsRead()).toEqual({ status: 200, body: { ...OFF, agentsStartAgents: true, signedIn: true } })
    session = null
    expect(await t.sync.settingsRead()).toEqual({ status: 200, body: { ...OFF, signedIn: false } })
  })

  it('writes the summary switch, stored inverted, through to the account like the others', async () => {
    const t = setup()
    const patches: unknown[] = []
    answer(account({}))
    answers.push(async (method, body) => { patches.push(body); return account({ agent_messages_hide_summary: true }) })
    expect(await t.sync.settingsWrite({ agentMessagesHideSummary: true }))
      .toEqual({ status: 200, body: { ...OFF, agentMessagesHideSummary: true, signedIn: true } })
    expect(patches).toEqual([{ accountId: 'acct', feature: 'agent_messages_hide_summary', enabled: true }])
  })

  it('writes `harness settings` and an older window\'s Settings ▸ Agents through to the account', async () => {
    const t = setup()
    const patches: unknown[] = []
    answer(account({}))
    answers.push(async (method, body) => { patches.push(body); return account({ agent_messages: true }) })
    answers.push(async (method, body) => { patches.push(body); return account({ agent_messages: true, agents_start_agents: true }) })
    expect(await t.sync.settingsWrite({ agentMessages: true, agentsStartAgents: true, other: true, pullRequestLine: 'on' }))
      .toEqual({ status: 200, body: { ...OFF, agentMessages: true, agentsStartAgents: true, signedIn: true } })
    expect(patches).toEqual([{ accountId: 'acct', feature: 'agent_messages', enabled: true }, { accountId: 'acct', feature: 'agents_start_agents', enabled: true }])
    expect(t.want).toHaveBeenCalledOnce()
  })

  it('names in its log the agent that turned one on with the person\'s yes, which is only its word', async () => {
    const lines: string[] = []
    const t = setup({ log: (line) => lines.push(line) })
    answer(account({}))
    answers.push(async () => account({ agents_tell_agents: true }))
    expect(await t.sync.settingsWrite({ agentsTellAgents: true, byAgent: 'Claude Code' }))
      .toEqual({ status: 200, body: { ...OFF, agentsTellAgents: true, signedIn: true } })
    expect(lines).toEqual(['[settings] agentsTellAgents on by Claude Code, which says the person said yes'])
    // The summary switch grants by turning off: the agent's word is named for it too.
    answer(account({ agent_messages_hide_summary: true }))
    answers.push(async () => account({}))
    await t.sync.settingsWrite({ agentMessagesHideSummary: false, byAgent: 'Codex' })
    expect(lines.at(-1)).toBe('[settings] agentMessagesHideSummary off by Codex, which says the person said yes')
    // Not for the person's own write, nor for a name that says nothing.
    answer(account({ agents_tell_agents: true }))
    answers.push(async () => account({}))
    await t.sync.settingsWrite({ agentsTellAgents: false, byAgent: ' ' })
    expect(lines).toHaveLength(2)
  })

  it('refuses a write with nothing in it, signed out, or with the account out of reach, and says why', async () => {
    const t = setup()
    for (const body of [null, 'on', { other: true }, { agentMessages: 'yes' }]) {
      expect(await t.sync.settingsWrite(body)).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } })
    }
    session = null
    expect(await t.sync.settingsWrite({ agentMessages: true })).toEqual({ status: 409, body: { error: { code: 'SIGNED_OUT', message: AGENT_SETTINGS_SIGNED_OUT } } })
    expect(AGENT_SETTINGS_SIGNED_OUT).toBe('Sign in to Harness to change this: what agents may do is an experiment of your account (Settings ▸ Experimental).')
    session = { version: 1, accessToken: 't', autonomousEnv: 'prod', computerId: 'c', machineId: 'm1', updatedAt: 0 }
    const unavailable = { status: 502, body: { error: { code: 'ACCOUNT_UNAVAILABLE', message: 'Harness could not reach your account to change this. Try again in a moment.' } } }
    answer({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } })
    expect(await t.sync.settingsWrite({ agentMessages: true })).toEqual(unavailable)
    answer({ status: 401, body: { success: false, error: { code: 'UNAUTHORIZED', message: '' } } })
    expect(await t.sync.settingsWrite({ agentMessages: true })).toEqual(unavailable)
    answer(account({}))
    answer({ status: 503, body: { success: false, error: { code: 'EXPERIMENT_UNAVAILABLE', message: 'This experiment is unavailable on this server.' } } })
    expect(await t.sync.settingsWrite({ agentMessages: true }))
      .toEqual({ status: 502, body: { error: { code: 'ACCOUNT_UNAVAILABLE', message: 'This experiment is unavailable on this server.' } } })
    expect(t.backend).toHaveBeenCalledTimes(4)
    expect(kept()).toEqual(OFF)
  })
})
