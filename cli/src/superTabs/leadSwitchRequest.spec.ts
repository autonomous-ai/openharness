import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Daemon } from '../agentClient/daemon.js'
import { profileId } from '../lib/claudeProfiles.js'
import { fakeCore } from '../testing/fakeCore.js'
import { readFixture } from './fixtures/read/index.js'
// Each trust fixture moves the engine homes; do not reuse a login-shell snapshot captured by another fixture.
vi.mock('../engines/kit/launchExecutable.js', async original => ({ ...await original<object>(),
  launchEnvironment: async () => Object.fromEntries(['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) }))
import type { EngineStatusRun } from '../lib/engineAccount.js'
import { LeadSwitchRequests, profileSignedIn, switchChangeId, type SwitchRow } from './leadSwitchRequest.js'

afterEach(() => { vi.unstubAllEnvs() })

const request = { id: 'sw1', engine: 'claude', profileId: 'default' }
const row = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}): SwitchRow => ({ tabId: 'tab', ledConversationId: 'conv1',
  agent: { id: 'a1', harnessId: 'h1', switchRequest: request, ...over }, ...top })
const NOW = 1_800_000_000_000
const PM = { agentId: 'h1', sessionId: 'native-old', registeredAt: NOW, engine: 'codex', cwd: '/work', permissionMode: 'ask', bypassPermission: false, defaultName: 'PM', startedBy: 'agent',
  swarmSkill: { role: 'coordinator', key: 'swarm-lead', mode: 'orchestration', github: true } }

function writeRecord(dataDir: string, changeId: string, at: number) {
  const dir = join(dataDir, 'super-tabs', 'lead-switch')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, `${createHash('sha256').update('h1').digest('hex')}.json`), JSON.stringify({ version: 1, agentId: 'h1', changeId, targetEngine: 'claude', at }), { mode: 0o600 })
}

function setup(options: { claim?: boolean; refuse?: string; live?: boolean; resultStale?: boolean; old?: Record<string, unknown>; signedIn?: boolean;
  claimGate?: Promise<void>; claimFails?: boolean; createTimesOut?: boolean; createHeld?: boolean; noRecord?: boolean } = {}) {
  const clock = { now: NOW }
  const dataDir = mkdtempSync(join(tmpdir(), 'lead-switch-'))
  const calls: Array<[string, Record<string, unknown>]> = []
  const posted: Array<Record<string, unknown>> = []
  const operationIds: string[] = []
  const home = mkdtempSync(join(tmpdir(), 'lead-switch-home-'))
  let live = options.live ?? true
  const backend = vi.fn(async (_method: string, _path: string, body: unknown) => {
    operationIds.push((body as { operationId: string }).operationId)
    const command = (body as { command: Record<string, unknown> }).command
    posted.push(command)
    if (command.type === 'agent.switchClaim' && options.claimGate) await options.claimGate
    if (command.type === 'agent.switchClaim' && options.claimFails) throw new Error('offline')
    if (command.type === 'agent.switchClaim' && options.claim === false) return { status: 403, body: { success: false, error: { code: 'STALE_SWITCH', message: 'no' } } }
    if (command.type === 'agent.switchResult' && options.resultStale) return { status: 403, body: { success: false, error: { code: 'STALE_SWITCH', message: 'settled' } } }
    return { status: 200, body: { success: true, data: { result: {} } } }
  })
  const daemon: Daemon = { machineId: 'm1', close: vi.fn(), request: vi.fn(async (type, payload = {}) => {
    calls.push([type, payload])
    if (type === 'agent_handoff_prepare') {
      return { agentId: 'h1', file: `.harness/handoff/h1-${payload.changeId}.md`, gitRepo: true, cwd: '/work', degraded: [] }
    }
    if (type === 'agent_close') {
      live = false
      // What the real close does once its stop went through (leadSwitch.ts leadSwitchEnded): the hold starts.
      if (!options.noRecord) writeRecord(dataDir, String(payload.changeId), clock.now)
      return { closed: true }
    }
    if (type === 'agent_create' && options.createTimesOut) throw new Error('timed out')
    if (type === 'agent_create' && options.createHeld) return { creationId: payload.creationId, state: 'pending' }
    if (type === 'agent_create') return options.refuse ? { error: options.refuse } : { agent: { id: 'h2' } }
    return {}
  }) }
  const core = fakeCore({ dataDir, account: { backend },
    agents: { byAgent: vi.fn((id: string) => id === 'h1' && live ? { ...PM, ...options.old } as never : undefined) } })
  const switches = new LeadSwitchRequests(core, 'm1', { now: () => clock.now, signedIn: async () => options.signedIn !== false,
    open: async () => daemon,
    readHandoff: () => 'Earlier project state.' })
  return { core, switches, calls, posted, daemon, operationIds, home, dataDir, clock, reopen: () => { live = true } }
}

describe('a PM host carrying out a switch the Swarm asked for', () => {
  it('claims, prepares the handoff, closes with the change id, creates with creationId = changeId on the default account, completes the handoff', async () => {
    const t = setup()
    await t.switches.serve(row())
    expect(t.posted.map(c => c.type)).toEqual(['agent.switchClaim'])
    expect(t.calls.map(c => c[0])).toEqual(['agent_handoff_prepare', 'agent_close', 'agent_create', 'agent_handoff_complete'])
    const changeId = String(t.calls[0][1].changeId)
    expect(changeId).toMatch(/^[0-9a-f]{32}$/)
    expect(t.calls[1][1]).toEqual({ agentId: 'h1', sessionId: 'native-old', createdAt: '2027-01-15T08:00:00.000Z', mode: 'now', changeId })
    expect(t.calls[2][1]).toMatchObject({ engine: 'claude', cwd: '/work', creationId: changeId, permissionMode: 'ask', name: 'PM' })
    expect(t.calls[2][1]).not.toHaveProperty('claudeHome')
    expect(String(t.calls[2][1].prompt)).toContain(`.harness/handoff/h1-${changeId}.md`)
    expect(t.calls[3][1]).toEqual({ agentId: 'h1', replacementId: 'h2', changeId, targetEngine: 'claude' })
  })

  // The PM's row still holds the GitHub App flag and the skill mode it was saved with (PM above): the replacement reads them
  // as nothing (the skill modes are gone, PM 2026-11-11).
  it('recreates the PM as a Swarm PM: its role, start prompt, then the handoff, with no GitHub App or skill mode', async () => {
    const t = setup()
    await t.switches.serve(row())
    const create = t.calls.find(c => c[0] === 'agent_create')![1]
    expect(create).toMatchObject({ swarmRole: 'lead', startedBy: 'agent', name: 'PM' })
    expect(create).not.toHaveProperty('swarmGitHub')
    expect(create).not.toHaveProperty('swarmSkillMode')
    const prompt = String(create.prompt)
    // Its name alone, as at its first start: no manual and no command (superTabs/start.ts startNote).
    expect(prompt.startsWith('You are PM. ')).toBe(true)
    expect(prompt).not.toContain('super-tab')
    expect(prompt).not.toContain('GitHub App')
    expect(prompt.indexOf('Context handoff')).toBeGreaterThan(0)
  })

  it('starts a PM that has no name to give with its handoff alone, no line of it opening with a space', async () => {
    for (const name of [undefined, '', '  ']) {
      const t = setup({ old: { defaultName: name, swarmSkill: { role: 'coordinator', key: 'swarm-lead', mode: 'orchestration', github: true } } })
      await t.switches.serve(row())
      const prompt = String(t.calls.find(c => c[0] === 'agent_create')![1].prompt)
      expect(prompt, JSON.stringify(name)).toMatch(/^Context handoff:/)
    }
  })

  it('recreates a PM whose row names nothing more than its role', async () => {
    const t = setup({ old: { swarmSkill: { role: 'coordinator', key: 'swarm-lead' } } })
    await t.switches.serve(row())
    const create = t.calls.find(c => c[0] === 'agent_create')![1]
    expect(create).toMatchObject({ swarmRole: 'lead' })
    expect(create).not.toHaveProperty('swarmGitHub')
    expect(create).not.toHaveProperty('swarmSkillMode')
    expect(String(create.prompt)).toContain('You are PM.')
  })

  it('refuses before closing a PM that has no Swarm skill or no conversation to rebuild its prompt from', async () => {
    for (const [t, r] of [[setup({ old: { swarmSkill: undefined } }), row()], [setup(), row({}, { ledConversationId: undefined })]] as const) {
      await t.switches.serve(r)
      expect(t.posted.at(-1)).toMatchObject({ type: 'agent.switchResult', ok: false, error: 'the handoff could not be prepared' })
      expect(t.calls).toEqual([])
    }
  })

  // F9: offering an account to the Swarm went with Desktop's accounts page, so a PM moves to an engine's default account alone.
  it('refuses a switch to any other account, saying why, before closing the PM; the default by either name goes ahead', async () => {
    const other = setup()
    await other.switches.serve(row({ switchRequest: { id: 'sw1', engine: 'claude', profileId: 'abcdef0123456789' } }))
    expect(other.posted.at(-1)).toMatchObject({ type: 'agent.switchResult', ok: false, error: 'only the default account can take a PM now' })
    expect(other.calls).toEqual([])
    const byId = setup()
    await byId.switches.serve(row({ switchRequest: { id: 'sw1', engine: 'codex', profileId: profileId('m1', 'codex', 'default') } }))
    expect(byId.calls.map(c => c[0])).toContain('agent_create')
  })

  // The backend moves a PM left on another account back to the default one (backend pmAccount.ts): the new session takes no
  // folder of the old one's.
  it('starts a PM that ran in another account\'s folder on the default account', async () => {
    for (const old of [{ engine: 'claude', claudeHome: '/homes/work' }, { engine: 'codex', codexHome: '/homes/work-codex' }]) {
      const t = setup({ old })
      await t.switches.serve(row({ switchRequest: { id: 'sw1', engine: old.engine, profileId: profileId('m1', old.engine as 'claude' | 'codex', 'default') } }))
      const created = t.calls.find(c => c[0] === 'agent_create')![1]
      expect(created).toMatchObject({ engine: old.engine })
      expect(created).not.toHaveProperty('claudeHome')
      expect(created).not.toHaveProperty('codexHome')
    }
  })

  // A native Codex launch reports its home's path, which for the default home is the default account too (replacements.ts
  // accountId; profileHome took it before #3831).
  it('takes the default Codex home by the id of its path, on this machine', async () => {
    const t = setup()
    vi.stubEnv('CODEX_HOME', t.home)
    await t.switches.serve(row({ switchRequest: { id: 'sw1', engine: 'codex', profileId: profileId('m1', 'codex', realpathSync(t.home)) } }))
    expect(t.calls.map(c => c[0])).toContain('agent_create')
  })

  it('refuses an engine that cannot run a PM before closing it', async () => {
    const t = setup()
    await t.switches.serve(row({ switchRequest: { id: 'sw1', engine: 'gemini', profileId: 'default' } }))
    expect(t.posted.at(-1)).toMatchObject({ type: 'agent.switchResult', ok: false, error: 'a PM runs on Claude Code or Codex' })
    expect(t.calls).toEqual([])
  })

  it('maps a permission mode the target engine lacks to ask, as Desktop does, and bypass follows the mode', async () => {
    const t = setup({ old: { permissionMode: 'acceptEdits', bypassPermission: true } })
    await t.switches.serve(row({ switchRequest: { id: 'sw1', engine: 'codex', profileId: 'default' } }))
    expect(t.calls.find(c => c[0] === 'agent_create')![1]).toMatchObject({ engine: 'codex', permissionMode: 'ask', bypassPermission: false })
    const f = setup({ old: { permissionMode: 'full', bypassPermission: true } })
    await f.switches.serve(row())
    expect(f.calls.find(c => c[0] === 'agent_create')![1]).toMatchObject({ permissionMode: 'full', bypassPermission: true })
  })

  it('creates again without the model and effort when this machine refuses them, as a first start does', async () => {
    const t = setup()
    let creates = 0
    vi.mocked(t.daemon.request).mockImplementation(async (type, payload = {}) => {
      t.calls.push([type, { ...payload }])
      if (type === 'agent_handoff_prepare') return { agentId: 'h1', file: `.harness/handoff/h1-${payload.changeId}.md`, gitRepo: true, cwd: '/work', degraded: [] }
      if (type === 'agent_close') return { closed: true }
      if (type === 'agent_create') return ++creates === 1 ? { error: 'LAUNCH_MODEL_UNSUPPORTED' } : { agent: { id: 'h2' } }
      return {}
    })
    await t.switches.serve(row({ switchRequest: { ...request, model: 'opus', effort: 'high' } }))
    const creating = t.calls.filter(c => c[0] === 'agent_create')
    expect(creating).toHaveLength(2)
    expect(creating[0][1]).toMatchObject({ model: 'opus', effort: 'high' })
    expect(creating[1][1]).not.toHaveProperty('model')
    expect(creating[1][1]).not.toHaveProperty('effort')
    expect(t.calls.at(-1)![0]).toBe('agent_handoff_complete')
  })

  it('a second poll while the claim is in flight starts nothing and the run reports once', async () => {
    let release!: () => void
    const t = setup({ claimGate: new Promise<void>(r => { release = r }) })
    const first = t.switches.serve(row())
    await t.switches.serve(row())
    release()
    await first
    expect(t.posted.filter(c => c.type === 'agent.switchClaim')).toHaveLength(1)
    expect(t.calls.filter(c => c[0] === 'agent_handoff_prepare')).toHaveLength(1)
    await t.switches.serve({ tabId: 'tab', agent: { id: 'a1', harnessId: 'h2' } })
    expect(t.posted.filter(c => c.type === 'agent.switchResult')).toEqual([{ type: 'agent.switchResult', agentId: 'a1', switchId: 'sw1', ok: true }])
  })

  it('a claim that fails is not posted again on the next poll', async () => {
    const t = setup({ claimFails: true })
    await t.switches.serve(row())
    await t.switches.serve(row())
    expect(t.posted.filter(c => c.type === 'agent.switchClaim')).toHaveLength(1)
  })

  it('keeps the operation ids within the backend cap for a long switch id', async () => {
    const t = setup()
    const long = 'x'.repeat(160)
    await t.switches.serve(row({ switchRequest: { ...request, id: long } }))
    await t.switches.serve({ tabId: 'tab', agent: { id: 'a1', harnessId: 'h2' } })
    expect(t.operationIds.length).toBe(2)
    expect(t.operationIds.every(id => id.length <= 160)).toBe(true)
  })

  describe('after a restart of the host in the middle of a switch', () => {
    const record = (t: ReturnType<typeof setup>, at: number) => writeRecord(t.dataDir, switchChangeId('sw1'), at)
    it('does not claim or run again, and reports ok when the rebind lands', async () => {
      const t = setup({ live: false })
      record(t, NOW - 4 * 60_000)
      await t.switches.serve(row())
      expect(t.posted).toEqual([])
      expect(t.calls).toEqual([])
      await t.switches.serve({ tabId: 'tab', agent: { id: 'a1', harnessId: 'h2' } })
      expect(t.posted).toEqual([{ type: 'agent.switchResult', agentId: 'a1', switchId: 'sw1', ok: true }])
    })
    it('reports the failure, without running again, once the old PM was reopened past its hold', async () => {
      const t = setup()
      record(t, NOW - 5 * 60_000)
      await t.switches.serve(row())
      expect(t.posted).toEqual([{ type: 'agent.switchResult', agentId: 'a1', switchId: 'sw1', ok: false, error: 'the new session did not start in time' }])
      expect(t.calls).toEqual([])
    })
    it('starts normally when the record is older than the adoption window', async () => {
      const t = setup()
      record(t, NOW - 11 * 60_000)
      await t.switches.serve(row())
      expect(t.posted[0]).toMatchObject({ type: 'agent.switchClaim' })
    })
  })

  it('reports ok once agent.rebind is seen for the PM', async () => {
    const t = setup()
    await t.switches.serve(row())
    await t.switches.serve(row())
    expect(t.posted.map(c => c.type)).toEqual(['agent.switchClaim'])
    await t.switches.serve({ tabId: 'tab', agent: { id: 'a1', harnessId: 'h2' } })
    expect(t.posted.at(-1)).toEqual({ type: 'agent.switchResult', agentId: 'a1', switchId: 'sw1', ok: true })
  })

  describe('a switch that failed after closing the PM', () => {
    const HOLD = 3 * 60_000
    const failure = { type: 'agent.switchResult', agentId: 'a1', switchId: 'sw1', ok: false, error: 'the new session could not start' }
    const results = (t: ReturnType<typeof setup>) => t.posted.filter(c => c.type === 'agent.switchResult')

    it('says nothing while the old PM is still closed, and reports once it is back past its hold', async () => {
      const t = setup({ refuse: 'SPAWN_LIMIT' })
      await t.switches.serve(row())
      expect(t.calls.map(c => c[0])).toEqual(['agent_handoff_prepare', 'agent_close', 'agent_create'])
      expect(results(t)).toEqual([])
      t.clock.now += HOLD + 1000
      await t.switches.serve(row())
      expect(results(t)).toEqual([])
      t.reopen()
      await t.switches.serve(row())
      expect(results(t)).toEqual([failure])
    })

    it('says the PM has not come back when it never reopened', async () => {
      const t = setup({ refuse: 'SPAWN_LIMIT' })
      await t.switches.serve(row())
      t.clock.now += 10 * 60_000 + 1000
      await t.switches.serve(row())
      expect(results(t)).toEqual([{ ...failure, down: true }])
    })

    for (const [name, option] of [['times out', { createTimesOut: true }], ['is held', { createHeld: true }]] as const) {
      it(`a create that ${name} can still start: no failure line, and the rebind reports ok`, async () => {
        const t = setup(option)
        await t.switches.serve(row())
        expect(results(t)).toEqual([])
        t.clock.now += 2 * 60_000
        await t.switches.serve({ tabId: 'tab', agent: { id: 'a1', harnessId: 'h2' } })
        expect(results(t)).toEqual([{ type: 'agent.switchResult', agentId: 'a1', switchId: 'sw1', ok: true }])
      })
    }

    it('a new switch right after a failed one is carried out, not read as the old one', async () => {
      const t = setup()
      writeRecord(t.dataDir, switchChangeId('earlier'), NOW - 4 * 60_000)
      await t.switches.serve(row())
      expect(t.posted[0]).toMatchObject({ type: 'agent.switchClaim', switchId: 'sw1' })
      expect(t.calls.map(c => c[0])).toContain('agent_close')
      expect(t.calls[1][1]).toMatchObject({ changeId: switchChangeId('sw1') })
    })
  })

  it('recreates the PM from the backend\'s own host row, which names the chat it leads', async () => {
    const t = setup()
    const real = readFixture<{ tabs: Array<{ roster: Array<Record<string, unknown>> }> }>('host-full').tabs[0].roster.find(r => r.lead === true)!
    await t.switches.serve({ ...real, tabId: 'tab', agent: { id: 'a1', harnessId: 'h1', switchRequest: request } } as unknown as SwitchRow)
    expect(String(t.calls.find(c => c[0] === 'agent_create')![1].prompt)).toContain('You are PM.')
  })

  it('refuses a signed-out default account before closing the PM', async () => {
    const t = setup({ signedIn: false })
    await t.switches.serve(row())
    expect(t.posted.at(-1)).toMatchObject({ type: 'agent.switchResult', ok: false, error: 'that account is signed out' })
    expect(t.calls).toEqual([])
  })

  it('does nothing for a request it cannot claim', async () => {
    const t = setup({ claim: false })
    await t.switches.serve(row())
    expect(t.posted.map(c => c.type)).toEqual(['agent.switchClaim'])
    expect(t.calls).toEqual([])
  })

  it('publishes a handoff for the destination, keeps the source alive, then stops only that source after promotion', async () => {
    const t = setup()
    const cross = row({ switchRequest: { ...request, targetMachineId: 'm2' } })
    await t.switches.serve(cross)
    const changeId = switchChangeId('sw1')
    expect(t.posted.map(c => c.type)).toEqual(['agent.switchClaim', 'agent.switchHandoff'])
    expect(t.posted.at(-1)).toMatchObject({ agentId: 'a1', switchId: 'sw1', handoffChangeId: changeId, note: 'Earlier project state.' })
    expect(t.calls.map(c => c[0])).toEqual(['agent_handoff_prepare'])
    expect(t.calls.some(c => c[0] === 'agent_close' || c[0] === 'agent_create')).toBe(false)

    await t.switches.serve(row({ switchRequest: undefined, switchLanded: { id: 'sw1', candidateAgentId: 'm2-h2' } }))
    expect(t.calls.map(c => c[0])).toEqual(['agent_handoff_prepare', 'agent_close'])
    expect(t.calls.at(-1)![1]).toEqual({ agentId: 'h1', sessionId: 'native-old', createdAt: '2027-01-15T08:00:00.000Z', mode: 'now', changeId })
    expect(t.posted.at(-1)).toMatchObject({ type: 'agent.switchResult', ok: true })
  })

  // Review of #3831: for a move the Swarm names the destination's default account (backend commands.ts defaultProfileId), and
  // that account is the destination's own to check: this machine's sign-in does not decide it.
  it('takes a move to another machine\'s default account, whatever this machine\'s own sign-in says', async () => {
    const t = setup({ signedIn: false })
    await t.switches.serve(row({ switchRequest: { id: 'sw1', engine: 'codex', profileId: profileId('m2', 'codex', 'default'), targetMachineId: 'm2' } }))
    expect(t.posted.map(c => c.type)).toEqual(['agent.switchClaim', 'agent.switchHandoff'])
  })

  it('keeps the source running when the backend clears a failed destination switch', async () => {
    const t = setup()
    await t.switches.serve(row({ switchRequest: { ...request, targetMachineId: 'm2' } }))
    await t.switches.serve(row({ switchRequest: undefined }))
    expect(t.calls.map(c => c[0])).toEqual(['agent_handoff_prepare'])
    expect(t.posted.map(c => c.type)).toEqual(['agent.switchClaim', 'agent.switchHandoff'])
  })

  it('treats a result the Swarm already settled as done', async () => {
    const t = setup({ resultStale: true })
    await t.switches.serve(row())
    await t.switches.serve({ tabId: 'tab', agent: { id: 'a1', harnessId: 'h2' } })
    const sent = t.posted.length
    await t.switches.serve(row())
    expect(t.posted.length).toBe(sent)
  })
})

describe('whether the default account holds a sign-in', () => {
  /** A fake `claude auth status --json` / `codex login status`, recording what it was asked. */
  const cli = (signedIn: boolean | null) => {
    const calls: Array<{ engine: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = []
    const run: EngineStatusRun = async (engine, args, env) => {
      calls.push({ engine, args, env })
      if (signedIn === null) return null
      return { code: signedIn ? 0 : 1, stdout: engine === 'claude' ? JSON.stringify({ loggedIn: signedIn, authMethod: 'claude.ai', apiProvider: 'firstParty' }) : '' }
    }
    return { run, calls }
  }
  it('asks the engine itself for the default account, under the daemon\'s own environment, or takes its key', async () => {
    const yes = cli(true)
    expect(await profileSignedIn('claude', { PATH: '/bin' }, yes.run)).toBe(true)
    expect(await profileSignedIn('codex', { PATH: '/bin', CODEX_HOME: '/mine' }, yes.run)).toBe(true)
    expect(yes.calls).toEqual([
      { engine: 'claude', args: ['auth', 'status', '--json'], env: { PATH: '/bin' } },
      { engine: 'codex', args: ['login', 'status'], env: { PATH: '/bin', CODEX_HOME: '/mine' } },
    ])
    const no = cli(false)
    expect(await profileSignedIn('claude', {}, no.run)).toBe(false)
    expect(await profileSignedIn('claude', { ANTHROPIC_API_KEY: 'k' }, no.run)).toBe(true)
    expect(no.calls).toHaveLength(1)
  })

  // Review of #3831: a host gives no sign-in check of its own, so a switch asks the engine through this one.
  it('is what a switch asks by default, of the default account', async () => {
    const t = setup()
    // The daemon's own environment, whatever this test runs under: no key of Claude's, its own CLAUDE_CONFIG_DIR.
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) vi.stubEnv(name, '')
    vi.stubEnv('CLAUDE_CONFIG_DIR', t.home)
    const no = cli(false)
    const switches = new LeadSwitchRequests(fakeCore({ dataDir: t.dataDir, account: { backend: vi.fn(async () => ({ status: 200, body: { success: true, data: { result: {} } } })) },
      agents: { byAgent: vi.fn(() => ({ ...PM }) as never) } }), 'm1', { now: () => NOW, run: no.run })
    await switches.serve(row())
    expect(no.calls.map(call => [call.engine, call.env.CLAUDE_CONFIG_DIR])).toEqual([['claude', t.home]])
    expect(vi.mocked(switches['core'].account.backend).mock.calls.at(-1)![2]).toMatchObject({ command: { type: 'agent.switchResult', ok: false, error: 'that account is signed out' } })
  })
})
