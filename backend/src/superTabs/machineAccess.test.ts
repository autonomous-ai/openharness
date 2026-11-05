import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { type ContributedMachine, type MachinePrivacy } from './machines.js'
import { createSuperTab, SuperTabError, visibleState, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'

// Task #3047, phase 1 of docs/design/2026-11-05-machine-access.md: what each machine can reach. Each risk the design's
// section 7 names for phase 1 has a test here. Team accounts are required everywhere, the strictest setting.
beforeEach(() => { process.env.SWARM_TEAM_ACCOUNT_REQUIRED = '1' })
afterEach(() => { delete process.env.SWARM_TEAM_ACCOUNT_REQUIRED })

const NOW = 50_000_000_000
const DAY = 24 * 60 * 60_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const gray: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'gray', email: 'gray@example.com' }
const mate: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'mate', email: 'mate@example.com' }
const config: AgentConfiguration = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const requirements = { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false }
const resources = { cpuPercent: 1, memoryTotalBytes: 8, memoryUsedBytes: 1, diskFreeBytes: 8, diskTotalBytes: 8, projectDiskFreeBytes: 8,
  deviceType: null, chip: null, os: null, gpuPercent: null }
const PASSED: MachinePrivacy = { mode: 'account', passed: true, checkedAt: NOW - 60_000 }
type Reading = NonNullable<ContributedMachine['observation']>
const reading = (sessionKind: 'team' | 'computer', privacy?: MachinePrivacy): Reading => ({ generation: 'g1', receivedAt: NOW, sessionKind, resources,
  tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [], ...(privacy ? { privacy: { ...privacy, seenAt: NOW } } : {}) })
const refusal = (body: () => unknown): SuperTabError | null => {
  try { body(); return null } catch (error) { if (error instanceof SuperTabError) return error; throw error }
}
/** What the store loads for a command's askedIn (store.ts): who wrote the message, whether it is a system row, and when. */
const said = (id: string, createdAt = NOW - 1000) => ({ askedIn: { author: { kind: 'person', id } as never, source: false, createdAt } })

/** The owner's Swarm with two teammates. Gray's Mac was added as Gray joined (teamAccountOnly), with its Harness Team
 *  account, whose privacy check passed. The owner's Mac has no Team account. Projects: the owner's 'lead', and Gray's own. */
function swarm() {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = gray, context: Partial<CommandContext> = {}) => {
    const teamMachines = (state.machines ?? []).filter(m => m.observation?.sessionKind === 'team').map(m => m.machineId)
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, teamMachines, ...context })
    state = effects.state
    return effects
  }
  for (const person of [gray, mate]) {
    const invited = run({ type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' }, owner)
    run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, person)
  }
  const generation = (userId: string) => state.people.find(p => p.id === userId)!.generation
  const joined = { contribution: { machineOwnerId: 'gray', contributorId: 'gray', hostGrant: null } }
  run({ type: 'machine.contribute', machineId: 'gray-mac', name: 'Gray\'s Mac', cwd: '/swarm', scope: 'swarm', engines: ['codex'], maxAgents: 4,
    teamAccountOnly: true }, gray, joined)
  state.machines!.find(m => m.machineId === 'gray-mac')!.observation = reading('computer')
  state.machines!.push({ machineId: 'gray-team', name: 'Gray\'s Mac', contributorId: 'gray', membershipGeneration: generation('gray'), generation: 'g1',
    cwd: '/team-swarm', scope: 'swarm', engines: ['codex'], maxAgents: 4, paused: false, hostMachineId: 'gray-mac', observation: reading('team', PASSED) })
  state.machines!.push({ machineId: 'owner-mac', name: 'Owner Mac', contributorId: 'owner', membershipGeneration: generation('owner'), generation: 'g1',
    cwd: '/swarm', scope: 'swarm', engines: ['codex'], maxAgents: 4, paused: false, observation: reading('computer') })
  const grays = String(run({ type: 'project.create', name: 'Gray\'s', visibility: 'public', brief: '' }, gray).result.projectId)
  // The project's Lead (the PM), on the owner's Mac.
  const leadId = String(run({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: 'lead', name: 'Lead', configuration: config, lead: true },
    owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).result.agentId)
  const leadActor: Actor = { kind: 'agent', agentId: leadId, machineOwnerId: 'owner' }
  const machine = (machineId: string) => state.machines!.find(m => m.machineId === machineId)!
  const access = (body: Record<string, unknown>, actor: Actor = gray, context: Partial<CommandContext> = {}, machineId = 'gray-mac') =>
    run({ type: 'machine.access', machineId, ...body } as Command, actor, context)
  const add = (name: string, extra: Record<string, unknown> = {}, actor: Actor = gray, context: Partial<CommandContext> = {}) =>
    String(access({ action: 'add', name, ...extra }, actor, context).result.entryId)
  const entry = (name: string) => machine('gray-mac').access?.find(e => e.name === name)
  /** An agent of the Swarm on [machineId], by Gray's grant there. */
  const agent = (id: string, machineId = 'gray-mac', extra: Record<string, unknown> = {}): Actor => {
    state.agents.push({ id, machineId, harnessId: `harness-${id}`, projectId: 'lead', machineOwnerId: 'gray', contributorId: 'gray',
      membershipGeneration: generation('gray'), hostGrant: null, name: id, configuration: config, ...extra })
    return { kind: 'agent', agentId: id, machineOwnerId: 'gray' }
  }
  const group = (projectId = 'lead', actor: Actor = owner, requires?: Record<string, unknown>) => String(run({ type: 'conversation.create', projectId, title: 'Work',
    ...(requires ? { task: { goal: 'Test on a lamp.', changes: 'Firmware.', constraints: 'None.', owns: ['fw'], requires } } : { brief: 'Build it.' }),
    checks: [] } as Command, actor).result.conversationId)
  const start = (conversationId: string, actor: Actor = owner, projectId = 'lead') =>
    run({ type: 'agent.start', request: { conversationId, machineId: 'gray-mac', engine: 'codex', name: 'Builder', cwd: `/swarm/${projectId}`, worktree: true,
      requirements } }, actor, joined)
  return { run, machine, access, add, entry, agent, group, start, joined, grays, leadActor, generation, get state() { return state }, set state(s) { state = s } }
}

describe('the access list and machine.access', () => {
  it('takes an entry from the machine\'s owner, ok at once, with who added it and when', () => {
    const f = swarm()
    const id = f.add('Fusion 360')
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(f.entry('Fusion 360')).toEqual({ id, name: 'Fusion 360', account: 'own', state: 'ok', addedBy: 'gray', addedAt: new Date(NOW).toISOString() })
    f.add('Lamp', { account: 'team', production: true, note: 'connection info in ~/.lamp/config', check: 'lamp-mcp' })
    expect(f.entry('Lamp')).toMatchObject({ account: 'team', production: true, note: 'connection info in ~/.lamp/config', check: 'lamp-mcp' })
  })

  it('holds at most 32 entries, and one name once per account, whatever its case', () => {
    const f = swarm()
    for (let i = 0; i < 32; i++) f.add(`Thing ${i}`)
    expect(refusal(() => f.add('One more'))?.code).toBe('ACCESS_FULL')
    const g = swarm()
    g.add('Lamp')
    expect(refusal(() => g.add('  lamp '))?.code).toBe('ACCESS_EXISTS')
    // The same name in the other account is another entry.
    g.add('Lamp', { account: 'team' })
    expect(g.machine('gray-mac').access).toHaveLength(2)
  })

  it('keeps a Team account\'s entries on its Mac, and none on a Mac without a Team account', () => {
    const f = swarm()
    expect(refusal(() => f.access({ action: 'add', name: 'Lamp' }, gray, {}, 'gray-team'))?.code).toBe('NOT_FOUND')
    expect(refusal(() => f.access({ action: 'add', name: 'Lamp', account: 'team' }, owner, {}, 'owner-mac'))?.code).toBe('NO_TEAM_ACCOUNT')
    expect(f.machine('gray-team').access).toBeUndefined()
  })

  it('refuses a name or note that looks like a secret, and takes where the secret lives', () => {
    const f = swarm()
    for (const secret of ['ghp_Xk9mQ2vL7pR4tY8wZ3nB6cF1hJ5dS0aE2gK', 'sk-ant-api03-Xk9mQ2vL7pR4tY8wZ3nB6cF1', 'admin:hunter2@db.internal',
      '-----BEGIN OPENSSH PRIVATE KEY-----', 'AKIAIOSFODNN7EXAMPLE', 'key Xk9mQ2vL7pR4tY8wZ3nB6c here', 'xoxb-1234-5678-abcdef']) {
      expect(refusal(() => f.add(secret))?.code, secret).toBe('ACCESS_SECRET')
      expect(refusal(() => f.add('Prod DB', { note: secret }))?.code, secret).toBe('ACCESS_SECRET')
    }
    expect(f.machine('gray-mac').access ?? []).toEqual([])
    f.add('Email (dee@)', { note: 'connection info in ~/.argocd/config' })
    f.add('Prod DB read-only', { note: 'env file /Users/gray/Library/Application Support/harness/prod-read.env' })
    expect(f.machine('gray-mac').access).toHaveLength(2)
  })

  it('is changed by nobody else: not the Swarm\'s owner, a teammate, an agent on its own word, or a Buddy', () => {
    const f = swarm()
    const worker = f.agent('gray-worker')
    const buddy = f.agent('gray-buddy', 'gray-mac', { buddyOf: 'gray', buddyScope: 'swarm' })
    for (const actor of [owner, mate, worker, f.leadActor, buddy]) {
      expect(['OWNER_REQUIRED', 'BUDDY_FORBIDDEN'], JSON.stringify(actor)).toContain(refusal(() => f.add('Lamp', {}, actor))?.code)
    }
    expect(f.machine('gray-mac').access).toBeUndefined()
  })

  it('takes the Lead passing on the owner\'s own message from the last day, in a chat it leads, as ok', () => {
    const f = swarm()
    const askedIn = { conversationId: 'lead', messageId: 'm-gray' }
    f.add('ArgoCD', { note: 'connection info in ~/.argocd/config', askedIn }, f.leadActor, said('gray'))
    expect(f.entry('ArgoCD')).toMatchObject({ state: 'ok', addedBy: 'gray', askedIn })
  })

  it('keeps what anyone else said, an old message or one from a chat it does not lead, unconfirmed', () => {
    const askedIn = { conversationId: 'lead', messageId: 'm-1' }
    for (const [context, saidBy] of [[said('owner'), 'owner'], [said('gray', NOW - 2 * DAY), 'gray']] as const) {
      const f = swarm()
      f.add('Email', { askedIn }, f.leadActor, context)
      expect(f.entry('Email')).toMatchObject({ state: 'unconfirmed', saidBy, askedIn, addedBy: saidBy })
    }
    // A chat it does not lead: Gray's own message in a task's chat.
    const f = swarm()
    const task = f.group()
    // Its chat names another Lead.
    f.state.conversations.find(c => c.id === task)!.leadId = 'someone-else'
    f.add('Email', { askedIn: { conversationId: task, messageId: 'm-2' } }, f.leadActor, said('gray'))
    expect(f.entry('Email')).toMatchObject({ state: 'unconfirmed', saidBy: 'gray' })
    // Only a Lead records what people say: any other agent passing on even the owner's message is refused.
    expect(refusal(() => f.add('Slack', { askedIn }, f.agent('gray-worker'), said('gray')))?.code).toBe('OWNER_REQUIRED')
    // With no message behind it, or a system row, an agent records nothing.
    expect(refusal(() => f.add('Slack', {}, f.leadActor))?.code).toBe('OWNER_REQUIRED')
    expect(refusal(() => f.add('Slack', { askedIn }, f.leadActor, { askedIn: { author: { kind: 'person', id: 'gray' } as never, source: true, createdAt: NOW } }))?.code)
      .toBe('OWNER_REQUIRED')
  })

  it('lets only the owner\'s own session share an entry with teammates; the Lead may only stop sharing', () => {
    const f = swarm()
    const askedIn = { conversationId: 'lead', messageId: 'm-gray' }
    expect(refusal(() => f.add('Fusion 360', { teammates: true, askedIn }, f.leadActor, said('gray')))?.code).toBe('OWNER_SESSION_REQUIRED')
    const id = f.add('Fusion 360')
    expect(refusal(() => f.access({ action: 'change', entryId: id, teammates: true, askedIn }, f.leadActor, said('gray')))?.code).toBe('OWNER_SESSION_REQUIRED')
    expect(f.entry('Fusion 360')!.teammates).toBeUndefined()
    f.access({ action: 'change', entryId: id, teammates: true })
    expect(f.entry('Fusion 360')!.teammates).toBe(true)
    f.access({ action: 'change', entryId: id, teammates: false, askedIn }, f.leadActor, said('gray'))
    expect(f.entry('Fusion 360')!.teammates).toBeUndefined()
    // Never on a Team account's entry: it always runs teammates' work.
    const team = f.add('Lamp', { account: 'team' })
    expect(refusal(() => f.access({ action: 'change', entryId: team, teammates: true }))?.code).toBe('TEAM_ACCOUNT_ENTRY')
  })

  it('lets only the owner\'s own session rename a shared entry, so sharing never moves to another name (security review 1)', () => {
    const f = swarm()
    const askedIn = { conversationId: 'lead', messageId: 'm-gray' }
    const id = f.add('Lamp')
    f.access({ action: 'change', entryId: id, teammates: true })
    expect(refusal(() => f.access({ action: 'change', entryId: id, name: 'Email (dee@)', askedIn }, f.leadActor, said('gray')))?.code).toBe('OWNER_SESSION_REQUIRED')
    expect(f.entry('Lamp')).toMatchObject({ teammates: true })
    expect(f.entry('Email (dee@)')).toBeUndefined()
    // An entry nobody shared is renamed on the owner's word, as before; the owner renames a shared one themselves.
    const other = f.add('Fusion')
    f.access({ action: 'change', entryId: other, name: 'Fusion 360', askedIn }, f.leadActor, said('gray'))
    expect(f.entry('Fusion 360')).toBeDefined()
    f.access({ action: 'change', entryId: id, name: 'Desk lamp' })
    expect(f.entry('Desk lamp')).toMatchObject({ teammates: true })
  })

  it('never lets an agent mark a production entry as not production', () => {
    const f = swarm()
    const askedIn = { conversationId: 'lead', messageId: 'm-gray' }
    const id = f.add('Prod DB read-only', { production: true })
    expect(refusal(() => f.access({ action: 'change', entryId: id, production: false, askedIn }, f.leadActor, said('gray')))?.code).toBe('OWNER_SESSION_REQUIRED')
    expect(f.entry('Prod DB read-only')!.production).toBe(true)
    f.access({ action: 'change', entryId: id, production: false })
    expect(f.entry('Prod DB read-only')!.production).toBeUndefined()
  })

  it('is confirmed by the owner, in Machines or by the Lead passing on their word', () => {
    const askedIn = { conversationId: 'lead', messageId: 'm-1' }
    for (const confirm of ['owner', 'lead'] as const) {
      const f = swarm()
      const id = f.add('Email', { askedIn }, f.leadActor, said('owner'))
      // Anyone else's word does not confirm it.
      expect(refusal(() => f.access({ action: 'confirm', entryId: id, askedIn }, f.leadActor, said('mate')))?.code).toBe('OWNER_REQUIRED')
      if (confirm === 'owner') f.access({ action: 'confirm', entryId: id })
      else f.access({ action: 'confirm', entryId: id, askedIn }, f.leadActor, said('gray'))
      expect(f.entry('Email')).toMatchObject({ state: 'ok', addedBy: 'gray' })
      expect(f.entry('Email')!.saidBy).toBeUndefined()
    }
  })

  it('is removed by the owner; the Lead removes an unconfirmed entry, but an ok one only on the owner\'s word', () => {
    const f = swarm()
    const askedIn = { conversationId: 'lead', messageId: 'm-1' }
    const ok = f.add('Fusion 360')
    const waiting = f.add('Email', { askedIn }, f.leadActor, said('owner'))
    f.access({ action: 'remove', entryId: waiting }, f.leadActor)
    expect(f.entry('Email')).toBeUndefined()
    expect(refusal(() => f.access({ action: 'remove', entryId: ok }, f.leadActor))?.code).toBe('OWNER_REQUIRED')
    f.access({ action: 'remove', entryId: ok, askedIn }, f.leadActor, said('gray'))
    expect(f.machine('gray-mac').access).toBeUndefined()
    expect(refusal(() => f.access({ action: 'remove', entryId: ok }))?.code).toBe('NOT_FOUND')
  })

  it('drops an unconfirmed entry 7 days after it was added', () => {
    const f = swarm()
    f.add('Email', { askedIn: { conversationId: 'lead', messageId: 'm-1' } }, f.leadActor, said('owner'))
    f.add('Fusion 360')
    f.machine('gray-mac').access!.forEach(e => { e.addedAt = new Date(NOW - 7 * DAY).toISOString() })
    f.add('Lamp')
    expect(f.machine('gray-mac').access!.map(e => e.name)).toEqual(['Fusion 360', 'Lamp'])
  })

  it('survives Desktop saving the contribution again, and goes with the machine', () => {
    const f = swarm()
    f.add('Fusion 360')
    f.run({ type: 'machine.contribute', machineId: 'gray-mac', name: 'Gray\'s Mac', cwd: '/swarm', scope: 'swarm', engines: ['codex'], maxAgents: 2,
      teamAccountOnly: true }, gray, f.joined)
    expect(f.machine('gray-mac').access).toHaveLength(1)
    f.machine('gray-mac').observation = { ...reading('computer'), receivedAt: 0 }
    f.machine('gray-team').observation = { ...reading('team', PASSED), receivedAt: 0 }
    f.run({ type: 'machine.remove', machineId: 'gray-mac' }, gray)
    for (const cleanup of f.state.machineCleanups ?? []) cleanup.requestedAt = new Date(NOW - 60 * 60_000).toISOString()
    f.run({ type: 'machine.contribute', machineId: 'gray-mac', name: 'Gray\'s Mac', cwd: '/swarm', scope: 'swarm', engines: ['codex'], maxAgents: 4,
      teamAccountOnly: true }, gray, f.joined)
    expect(f.machine('gray-mac').access).toBeUndefined()
  })
})

describe('who reads what (design section 4)', () => {
  /** Gray's Mac with an own-account entry and a Team-account entry, both with a note and a check. */
  function listed() {
    const f = swarm()
    f.add('ArgoCD', { note: 'connection info in ~/.argocd/config', check: 'argocd' })
    f.add('Lamp', { account: 'team', note: 'lamp MCP server, port 7000', check: 'lamp-mcp' })
    const read = (actor: Actor) => visibleState(f.state, actor, NOW).machines!.find(m => m.machineId === 'gray-mac')!.access!
    const named = (actor: Actor, name: string) => read(actor).find(e => e.name === name)!
    return { f, read, named }
  }

  it('gives the machine\'s owner everything: the note and the check', () => {
    const { named } = listed()
    expect(named(gray, 'ArgoCD')).toMatchObject({ note: 'connection info in ~/.argocd/config', check: 'argocd' })
    expect(named(gray, 'Lamp')).toMatchObject({ note: 'lamp MCP server, port 7000', check: 'lamp-mcp' })
  })

  it('gives every other member the names, account and state, never a note or a check', () => {
    const { read } = listed()
    for (const reader of [owner, mate]) {
      const entries = read(reader)
      expect(entries.map(e => [e.name, e.account, e.state])).toEqual([['ArgoCD', 'own', 'ok'], ['Lamp', 'team', 'ok']])
      for (const e of entries) {
        expect(e.note, JSON.stringify(reader)).toBeUndefined()
        expect(e.check, JSON.stringify(reader)).toBeUndefined()
      }
    }
  })

  it('gives an agent on that machine, in that entry\'s account, the note and never the check', () => {
    const { f, named } = listed()
    const onMac = f.agent('mac-worker', 'gray-mac')
    const onTeam = f.agent('team-worker', 'gray-team')
    expect(named(onMac, 'ArgoCD')).toMatchObject({ note: 'connection info in ~/.argocd/config' })
    expect(named(onMac, 'ArgoCD').check).toBeUndefined()
    expect(named(onMac, 'Lamp').note).toBeUndefined()
    expect(named(onTeam, 'Lamp')).toMatchObject({ note: 'lamp MCP server, port 7000' })
    expect(named(onTeam, 'Lamp').check).toBeUndefined()
    expect(named(onTeam, 'ArgoCD').note).toBeUndefined()
  })

  it('gives an agent of the owner on another machine, and the Lead that recorded it, no note', () => {
    const { f, named } = listed()
    // Gray's own agent, but on the owner's Mac: owner rights are the owner's own session only.
    const elsewhere = f.agent('gray-elsewhere', 'owner-mac')
    for (const reader of [elsewhere, f.leadActor]) {
      for (const name of ['ArgoCD', 'Lamp']) {
        expect(named(reader, name).note, `${JSON.stringify(reader)} ${name}`).toBeUndefined()
        expect(named(reader, name).check, `${JSON.stringify(reader)} ${name}`).toBeUndefined()
      }
    }
  })

  it('gives agents no note of an entry waiting for its owner to confirm, and the note once confirmed (security review 1)', () => {
    const f = swarm()
    f.add('Email', { note: 'run the mail tool in ~/bin', askedIn: { conversationId: 'lead', messageId: 'm-1' } }, f.leadActor, said('mate'))
    const onMac = f.agent('mac-worker', 'gray-mac')
    const read = (actor: Actor) => visibleState(f.state, actor, NOW).machines!.find(m => m.machineId === 'gray-mac')!.access!.find(e => e.name === 'Email')!
    expect(read(onMac).note).toBeUndefined()
    // Its owner reads what was said, to confirm it or not.
    expect(read(gray).note).toBe('run the mail tool in ~/bin')
    f.access({ action: 'confirm', entryId: f.entry('Email')!.id })
    expect(read(onMac).note).toBe('run the mail tool in ~/bin')
  })

  it('leaves the stored list whole', () => {
    const { f, read } = listed()
    read(mate)
    expect(f.entry('ArgoCD')).toMatchObject({ note: 'connection info in ~/.argocd/config', check: 'argocd' })
  })
})

describe('requires.access and the start check (design section 3)', () => {
  const candidate = (id: string, machineId: string) => ({ id, kind: 'new', machineId, engine: 'codex', model: 'default', effort: 'default',
    quality: 3, cost: 2, title: `${id} on ${machineId}`, label: `Label ${id}` })
  const record = (candidates: unknown[]) => ({ assessment: { difficulty: 'medium', risk: 'low', why: 'A lamp test.' }, candidates, excluded: [],
    floor: 2, notes: false, via: 'instructions', p: null, belowFloor: false, why: 'Instructions.' })
  const lastStart = (f: ReturnType<typeof swarm>) => f.state.starts!.at(-1)!.request

  it('keeps a task\'s access, trimmed', () => {
    const f = swarm()
    const work = f.group('lead', owner, { access: ['Lamp', '  Fusion 360 '] })
    expect(f.state.conversations.find(c => c.id === work)!.task!.requires).toEqual({ access: ['Lamp', 'Fusion 360'] })
    expect(() => f.group('lead', owner, { access: ['x'.repeat(61)] })).toThrow('expected string to have <=60 characters')
  })

  it('refuses a start that names no access (an older CLI) where the task\'s access is missing', () => {
    const f = swarm()
    const work = f.group('lead', owner, { access: ['Lamp'] })
    expect(refusal(() => f.start(work))).toMatchObject({ code: 'ACCESS_MISSING', message: 'No Lamp here.' })
    expect(f.state.starts ?? []).toEqual([])
  })

  it('never counts the owner\'s unshared own-account entry for a teammate\'s task, nor the Team account for it', () => {
    const f = swarm()
    f.add('Lamp')
    // The Swarm owner's project is a teammate's on Gray's Mac: it runs in the Team account, which has no Lamp.
    const work = f.group('lead', owner, { access: ['Lamp'] })
    expect(refusal(() => f.start(work))).toMatchObject({ code: 'ACCESS_MISSING', message: 'Lamp is in gray\'s own account, not shared with teammates.' })
  })

  it('keeps a teammate\'s start on the Mac, in the owner\'s account, when the owner shared that entry', () => {
    const f = swarm()
    const id = f.add('Lamp')
    f.access({ action: 'change', entryId: id, teammates: true })
    const work = f.group('lead', owner, { access: ['Lamp'] })
    const started = f.start(work)
    expect(lastStart(f).machineId).toBe('gray-mac')
    expect(started.result.moved).toBeUndefined()
    // A task that needs nothing shared still goes to the Team account, as before.
    f.start(f.group('lead', owner))
    expect(lastStart(f).machineId).toBe('gray-team')
  })

  it('starts a recorded route\'s Mac candidate on the Mac only for a task that names the shared entry (security review 2)', () => {
    const f = swarm()
    const id = f.add('Lamp')
    f.access({ action: 'change', entryId: id, teammates: true })
    const named = f.group('lead', owner, { access: ['Lamp'] })
    const routed = f.run({ type: 'route.record', conversationId: named, decision: record([candidate('c0', 'gray-mac')]) } as Command, owner)
    expect(routed.routeDecisions[0]).toMatchObject({ op: 'create', record: { candidates: [{ id: 'c0' }], excluded: [] } })
    f.start(named)
    expect(lastStart(f).machineId).toBe('gray-mac')
    // Named in the route alone, not the task: the start goes to the Team account, which the route offers in its place.
    f.start(f.group('lead', owner))
    expect(lastStart(f).machineId).toBe('gray-team')
  })

  it('sends Team-written code to the Team account even for a shared entry, and refuses it there', () => {
    const f = swarm()
    const id = f.add('Lamp')
    f.access({ action: 'change', entryId: id, teammates: true })
    const work = f.group('lead', owner, { access: ['Lamp'] })
    f.state.conversations.find(c => c.id === work)!.teamWritten = true
    expect(refusal(() => f.start(work))?.code).toBe('ACCESS_MISSING')
    expect(f.state.starts ?? []).toEqual([])
  })

  it('refuses a start on a machine off the Machines list, which lists nothing it can reach', () => {
    const f = swarm()
    const work = f.group('lead', owner, { access: ['Lamp'] })
    expect(refusal(() => f.run({ type: 'agent.start', request: { conversationId: work, machineId: 'owner-laptop', engine: 'codex', name: 'Builder',
      cwd: '/somewhere', worktree: true, requirements } }, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })))
      .toMatchObject({ code: 'ACCESS_MISSING', message: 'No Lamp here.' })
  })

  it('refuses an entry waiting for its owner to confirm', () => {
    const f = swarm()
    f.add('Lamp', { account: 'team', askedIn: { conversationId: 'lead', messageId: 'm-1' } }, f.leadActor, said('owner'))
    const work = f.group('lead', owner, { access: ['Lamp'] })
    expect(refusal(() => f.start(work))).toMatchObject({ code: 'ACCESS_MISSING', message: 'Lamp on Gray\'s Mac is waiting for gray to confirm.' })
  })

  it('refuses the owner\'s own task needing a Team-account entry: that account runs only teammates\' work', () => {
    const f = swarm()
    f.add('Lamp', { account: 'team' })
    const work = f.group(f.grays, gray, { access: ['Lamp'] })
    expect(refusal(() => f.start(work, gray, f.grays))).toMatchObject({ code: 'ACCESS_MISSING',
      message: 'Lamp is in the Harness Team account on Gray\'s Mac, which runs only teammates\' work.' })
    // Its own-account entry is the owner's to use.
    f.add('Lamp')
    f.start(work, gray, f.grays)
    expect(lastStart(f).machineId).toBe('gray-mac')
  })

  it('takes a project\'s former owner for a teammate: their own-account entry needs sharing (with #3073\'s ownsProject)', () => {
    const f = swarm()
    f.add('Lamp')
    const work = f.group(f.grays, gray, { access: ['Lamp'] })
    // Gray left and came back: the project is no longer theirs to run in their own account.
    f.state.projects!.find(p => p.id === f.grays)!.ownerGeneration = 'an-earlier-membership'
    expect(refusal(() => f.start(work, gray, f.grays))).toMatchObject({ code: 'ACCESS_MISSING', message: 'Lamp is in gray\'s own account, not shared with teammates.' })
  })

  it('matches names without case or spacing, and leaves a start with no requirement as it was', () => {
    const f = swarm()
    f.add('Lamp', { account: 'team' })
    f.start(f.group('lead', owner, { access: ['  lamp '] }))
    expect(lastStart(f).machineId).toBe('gray-team')
    const g = swarm()
    g.start(g.group('lead', owner))
    expect(g.state.starts!.at(-1)!.request.machineId).toBe('gray-team')
  })

  it('leaves a machine without the access out of a recorded route, and refuses it as the only choice', () => {
    const f = swarm()
    const work = f.group('lead', owner, { access: ['Lamp'] })
    f.add('Lamp', { account: 'team' })
    expect(refusal(() => f.run({ type: 'route.record', conversationId: work, decision: record([candidate('c0', 'owner-mac')]) } as Command, owner)))
      .toMatchObject({ code: 'ACCESS_MISSING', message: 'No Lamp here. Route again.' })
    const routed = f.run({ type: 'route.record', conversationId: work, decision: record([candidate('c0', 'owner-mac'), candidate('c1', 'gray-mac')]) } as Command, owner)
    expect(routed.routeDecisions[0]).toMatchObject({ op: 'create', record: { candidates: [{ id: 'c1' }],
      excluded: [{ title: 'c0 on owner-mac', reason: 'No Lamp here.' }] } })
  })
})
