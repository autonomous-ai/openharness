import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Daemon } from '../agentClient/daemon.js'
import { fakeCore } from '../testing/fakeCore.js'
import { FIXTURE, readFixture } from './fixtures/read/index.js'
import { LeadSwitchRequests, profileSignedIn, switchChangeId, type SwitchRow } from './leadSwitchRequest.js'

const request = { id: 'sw1', engine: 'claude', profileId: 'p1' }
const row = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}): SwitchRow => ({ tabId: 'tab', ledConversationId: 'conv1', roleName: 'Product Manager',
  agent: { id: 'a1', harnessId: 'h1', switchRequest: request, ...over }, ...top })
const NOW = 1_800_000_000_000
const PM = { agentId: 'h1', engine: 'codex', cwd: '/work', permissionMode: 'ask', bypassPermission: false, defaultName: 'PM', startedBy: 'agent',
  swarmSkill: { role: 'coordinator', key: 'swarm-lead', mode: 'orchestration', github: true } }

function writeRecord(dataDir: string, changeId: string, at: number) {
  const dir = join(dataDir, 'super-tabs', 'lead-switch')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, `${createHash('sha256').update('h1').digest('hex')}.json`), JSON.stringify({ version: 1, agentId: 'h1', changeId, targetEngine: 'claude', at }), { mode: 0o600 })
}

function setup(options: { claim?: boolean; home?: string | null; team?: boolean; refuse?: string; live?: boolean; resultStale?: boolean; old?: Record<string, unknown>; signedIn?: boolean;
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
  const profiles = vi.fn(() => options.home === undefined ? '/home/p1' : options.home)
  const switches = new LeadSwitchRequests(core, 'm1', { now: () => clock.now, home: () => home, signedIn: async () => options.signedIn !== false,
    open: async () => daemon, profiles: profiles as never, team: () => options.team === true,
    readHandoff: () => 'Earlier project state.' })
  return { switches, calls, posted, daemon, profiles, operationIds, home, dataDir, clock, reopen: () => { live = true } }
}

describe('a PM host carrying out a switch the Swarm asked for', () => {
  it('claims, prepares the handoff, closes with the change id, creates with creationId = changeId and the profile home, completes the handoff', async () => {
    const t = setup()
    await t.switches.serve(row())
    expect(t.posted.map(c => c.type)).toEqual(['agent.switchClaim'])
    expect(t.calls.map(c => c[0])).toEqual(['agent_handoff_prepare', 'agent_close', 'agent_create', 'agent_handoff_complete'])
    const changeId = String(t.calls[0][1].changeId)
    expect(changeId).toMatch(/^[0-9a-f]{32}$/)
    expect(t.calls[1][1]).toEqual({ agentId: 'h1', mode: 'now', changeId })
    expect(t.calls[2][1]).toMatchObject({ engine: 'claude', cwd: '/work', creationId: changeId, claudeHome: '/home/p1', permissionMode: 'ask', name: 'PM' })
    expect(String(t.calls[2][1].prompt)).toContain(`.harness/handoff/h1-${changeId}.md`)
    expect(t.calls[3][1]).toEqual({ agentId: 'h1', replacementId: 'h2', changeId, targetEngine: 'claude' })
  })

  it('recreates the PM as a Swarm PM: its role, skill mode, GitHub token, start prompt, then the handoff', async () => {
    const t = setup()
    await t.switches.serve(row())
    const create = t.calls.find(c => c[0] === 'agent_create')![1]
    expect(create).toMatchObject({ swarmRole: 'lead', swarmSkillMode: 'orchestration', swarmGitHub: true, startedBy: 'agent', name: 'PM' })
    const prompt = String(create.prompt)
    expect(prompt.startsWith('You are the Product Manager of the project whose conversation is conv1')).toBe(true)
    expect(prompt).toContain('Harness GitHub App token')
    expect(prompt.indexOf('Context handoff')).toBeGreaterThan(prompt.indexOf('Harness GitHub App token'))
  })

  it('keeps a PM without GitHub off the token and names the role the row gives', async () => {
    const t = setup({ old: { swarmSkill: { role: 'coordinator', key: 'swarm-lead' } } })
    await t.switches.serve(row({}, { roleName: 'Lead dev' }))
    const create = t.calls.find(c => c[0] === 'agent_create')![1]
    expect(create).toMatchObject({ swarmRole: 'lead' })
    expect(create).not.toHaveProperty('swarmGitHub')
    expect(create).not.toHaveProperty('swarmSkillMode')
    expect(String(create.prompt)).toContain('as its Lead dev')
  })

  it('refuses before closing a PM that has no Swarm skill or no conversation to rebuild its prompt from', async () => {
    for (const [t, r] of [[setup({ old: { swarmSkill: undefined } }), row()], [setup(), row({}, { ledConversationId: undefined })]] as const) {
      await t.switches.serve(r)
      expect(t.posted.at(-1)).toMatchObject({ type: 'agent.switchResult', ok: false, error: 'the handoff could not be prepared' })
      expect(t.calls).toEqual([])
    }
  })

  it('asks the machine for offered accounts only, so one the owner never offered is refused as gone', async () => {
    const t = setup({ home: null })
    await t.switches.serve(row({ switchRequest: { id: 'sw1', engine: 'claude', profileId: 'abcdef0123456789' } }))
    expect(t.profiles).toHaveBeenCalledWith('claude', 'abcdef0123456789', expect.anything(), { offeredOnly: true })
  })

  it('maps a permission mode the target engine lacks to ask, as Desktop does, and bypass follows the mode', async () => {
    const t = setup({ old: { permissionMode: 'acceptEdits', bypassPermission: true } })
    await t.switches.serve(row({ switchRequest: { id: 'sw1', engine: 'codex', profileId: 'p1' } }))
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

  it('rebuilds the prompt from the chat the backend\'s own host row names', async () => {
    const t = setup()
    const real = readFixture<{ tabs: Array<{ roster: Array<Record<string, unknown>> }> }>('host-full').tabs[0].roster.find(r => r.lead === true)!
    await t.switches.serve({ ...real, tabId: 'tab', agent: { id: 'a1', harnessId: 'h1', switchRequest: request } } as unknown as SwitchRow)
    expect(String(t.calls.find(c => c[0] === 'agent_create')![1].prompt)).toContain(`conversation is ${FIXTURE.leadGroup}`)
  })

  it('refuses a signed-out default account before closing the PM, outside Team only', async () => {
    const t = setup({ home: 'default', signedIn: false })
    await t.switches.serve(row())
    expect(t.posted.at(-1)).toMatchObject({ type: 'agent.switchResult', ok: false, error: 'that account is signed out' })
    expect(t.calls).toEqual([])
    const team = setup({ home: 'default', signedIn: false, team: true })
    await team.switches.serve(row())
    expect(team.calls.map(c => c[0])).toContain('agent_close')
  })

  it('refuses a signed-out account without closing the PM', async () => {
    const t = setup({ signedIn: false })
    await t.switches.serve(row())
    expect(t.posted.at(-1)).toMatchObject({ type: 'agent.switchResult', ok: false, error: 'that account is signed out' })
    expect(t.calls).toEqual([])
  })

  it('a Team daemon switches to its default account (the hex id counts), and a Codex PM keeps an engine home of its own', async () => {
    const t = setup({ team: true, home: 'default' })
    await t.switches.serve(row({ switchRequest: { id: 'sw1', engine: 'codex', profileId: 'abcdef0123456789' } }))
    const create = t.calls.find(c => c[0] === 'agent_create')![1]
    const changeId = String(create.creationId)
    expect(create).toMatchObject({ engine: 'codex', codexHome: join(t.home, '.harness-pm-homes', changeId, 'codex') })
    expect(create).not.toHaveProperty('claudeHome')
    const c = setup({ team: true, home: 'default' })
    await c.switches.serve(row())
    expect(c.calls.find(x => x[0] === 'agent_create')![1]).not.toHaveProperty('claudeHome')
  })

  it('refuses a gone profile without closing the PM, and a Team daemon any profile but the default', async () => {
    for (const t of [setup({ home: null }), setup({ team: true })]) {
      await t.switches.serve(row())
      expect(t.posted.at(-1)).toMatchObject({ type: 'agent.switchResult', ok: false, error: 'that account is no longer on this machine' })
      expect(t.calls).toEqual([])
    }
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
    expect(t.posted.at(-1)).toMatchObject({ agentId: 'h1', switchId: 'sw1', handoffChangeId: changeId, note: 'Earlier project state.' })
    expect(t.calls.map(c => c[0])).toEqual(['agent_handoff_prepare'])
    expect(t.calls.some(c => c[0] === 'agent_close' || c[0] === 'agent_create')).toBe(false)

    await t.switches.serve(row({ switchRequest: undefined, switchLanded: { id: 'sw1', candidateAgentId: 'm2-h2' } }))
    expect(t.calls.map(c => c[0])).toEqual(['agent_handoff_prepare', 'agent_close'])
    expect(t.calls.at(-1)![1]).toEqual({ agentId: 'h1', mode: 'now', changeId })
    expect(t.posted.at(-1)).toMatchObject({ type: 'agent.switchResult', ok: true })
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

describe('whether a profile folder holds a sign-in', () => {
  it('reads the default account where its engine keeps it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lead-switch-default-'))
    const keychain = (raw: string | null) => ({ home, platform: 'linux' as const, readKeychain: async () => raw })
    const good = JSON.stringify({ claudeAiOauth: { accessToken: 't', expiresAt: NOW + 1000 } })
    expect(await profileSignedIn('claude', 'default', NOW, keychain(null), {})).toBe(false)
    expect(await profileSignedIn('claude', 'default', NOW, keychain(good), {})).toBe(true)
    expect(await profileSignedIn('claude', 'default', NOW, keychain(null), { ANTHROPIC_API_KEY: 'k' })).toBe(true)
    expect(await profileSignedIn('codex', 'default', NOW, { home }, {})).toBe(false)
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'k' }))
    expect(await profileSignedIn('codex', 'default', NOW, { home }, {})).toBe(true)
  })

  const folder = () => mkdtempSync(join(tmpdir(), 'profile-signed-in-'))
  const claude = (oauth: unknown) => ({ platform: 'linux' as const, readKeychain: async () => JSON.stringify({ claudeAiOauth: oauth }) })
  const jwt = (claims: Record<string, unknown>) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.')
  const codex = (tokens: unknown) => { const dir = folder(); writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens })); return dir }

  it('Claude: a token that has not expired, or one its refresh token renews, is signed in; none is not', async () => {
    expect(await profileSignedIn('claude', folder(), NOW, { platform: 'linux', readKeychain: async () => null })).toBe(false)
    expect(await profileSignedIn('claude', folder(), NOW, claude({ refreshToken: 'r' }))).toBe(false)
    expect(await profileSignedIn('claude', folder(), NOW, claude({ accessToken: 'a' }))).toBe(true)
    expect(await profileSignedIn('claude', folder(), NOW, claude({ accessToken: 'a', expiresAt: NOW + 1 }))).toBe(true)
    expect(await profileSignedIn('claude', folder(), NOW, claude({ accessToken: 'a', expiresAt: NOW - 1, refreshToken: 'r' }))).toBe(true)
    expect(await profileSignedIn('claude', folder(), NOW, claude({ accessToken: 'a', expiresAt: NOW - 1 }))).toBe(false)
  })

  it('Codex: the same rule over auth.json and the token\'s own expiry', async () => {
    expect(await profileSignedIn('codex', folder(), NOW)).toBe(false)
    expect(await profileSignedIn('codex', codex({}), NOW)).toBe(false)
    expect(await profileSignedIn('codex', codex({ access_token: 'opaque' }), NOW)).toBe(true)
    expect(await profileSignedIn('codex', codex({ access_token: jwt({ exp: NOW / 1000 + 60 }) }), NOW)).toBe(true)
    expect(await profileSignedIn('codex', codex({ access_token: jwt({ exp: NOW / 1000 - 60 }), refresh_token: 'r' }), NOW)).toBe(true)
    expect(await profileSignedIn('codex', codex({ access_token: jwt({ exp: NOW / 1000 - 60 }) }), NOW)).toBe(false)
  })

  it('a switch to a profile asks the real reader by default', async () => {
    const t = setup()
    const switches = new LeadSwitchRequests(fakeCore({ dataDir: t.dataDir, account: { backend: vi.fn(async () => ({ status: 200, body: { success: true, data: { result: {} } } })) },
      agents: { byAgent: vi.fn(() => ({ ...PM }) as never) } }), 'm1',
      { now: () => NOW, profiles: (() => folder()) as never, credentials: { platform: 'linux', readKeychain: async () => null } })
    await switches.serve(row())
    // Nothing signed in under that folder: refused before anything is closed.
    expect(vi.mocked(switches['core'].account.backend).mock.calls.at(-1)![2]).toMatchObject({ command: { type: 'agent.switchResult', ok: false, error: 'that account is signed out' } })
  })
})
