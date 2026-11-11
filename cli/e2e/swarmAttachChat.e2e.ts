/** Desktop's Attach, end to end on the real backend (Swarm v4, anh Dee 2026-11-10: "why are you not catching these basic
 * bugs?"): a stopped session on its person's computer is resumed, joins their Swarm under its own name with a 1:1 chat, and a
 * message its person sends there is typed into it and answered in that chat. The commands are the ones Desktop sends
 * (desktop/lib/super_tabs/new_agent.dart swarmAttachAgent, controller.dart message.send), so a backend that answers them
 * otherwise fails here, not on a person's screen. The real backend, an isolated daemon and fake engines.
 * Needs the backend's in-memory Mongo and Redis (HARNESS_E2E_SERVICES_DIR, see harness/realBackend.ts). */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { storeOf } from '../src/superTabs/partsStore.js'
import { reassemble } from '../src/superTabs/reassemble.js'
import { until } from './harness/daemon.js'
import { account, signIn, startRealBackend, type RealBackend } from './harness/realBackend.js'

const person = account('dee')
let backend: RealBackend
const tail = (text: string, lines: number) => text.split('\n').slice(-lines).join('\n')

describe.skipIf(!process.env.HARNESS_E2E_SERVICES_DIR)('Attach a stopped session, then chat with it, real backend', () => {
  beforeAll(async () => { backend = await startRealBackend([person], () => {}) }, 180_000)
  afterAll(async () => { await backend?.stop() })

  it('resumes it, keeps its name, and its person\'s message is typed into it and answered in its chat', async () => {
    const me = await signIn(backend, person, { ANTHROPIC_API_KEY: 'fixture-not-a-credential', OPENAI_API_KEY: 'fixture-not-a-credential',
      HARNESS_SWARM: '' })
    onTestFailed(() => {
      console.log(`---- daemon\n${tail(me.daemon.log(), 150)}`)
      console.log(`---- backend\n${tail(readFileSync(backend.logPath, 'utf8'), 80)}`)
    })
    const api = async (path: string, method = 'GET', body?: unknown) => {
      const r = await backend.api(person, path, method, body)
      expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBe(200)
      return r.body.data
    }
    // Desktop reads a Swarm as its parts (client.dart readSnapshot): the whole-state read answers UPDATE_REQUIRED since v4.
    const swarm = async (tab: string) => reassemble(storeOf({ ...(await api(`/api/super-tabs/${tab}/parts`)), tabId: tab })) as Record<string, any>
    const rows = async () => (await me.client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents

    // A session its person started in a folder, which talked once and was stopped: "juno" in Dee's sandbox.
    const cwd = join(me.daemon.projectsDir, 'swarm-sandbox'); mkdirSync(cwd, { recursive: true })
    const created = await me.client.request('agent_create', { engine: 'claude', cwd, bypassPermission: false, name: 'juno' }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const harnessId = created.agent.id as string
    const bound = await until('juno to bind its conversation', async () => (await rows()).find(a => a.id === harnessId && a.sessionId && a.status === 'active') ?? null, 60_000, 500)
    const ended = me.client.next(f => f.type === 'turn_ended' && f.agentId === harnessId && !f.replay, 60_000, 'first turn')
    me.client.send('message', { agentId: harnessId, content: 'look around' })
    await ended
    // Desktop's Stop (app_state.dart closeAgent): the session is saved and its process released.
    const closing = (await rows()).find(a => a.id === harnessId)!
    const closed = await me.client.request('agent_close', { agentId: harnessId, sessionId: closing.sessionId, createdAt: closing.createdAt, mode: 'now' }, 60_000)
    expect(closed.error, JSON.stringify(closed)).toBeUndefined()
    const stopped = await until('juno to stop', async () => (await rows()).find(a => a.id === harnessId && a.status === 'stopped') ?? null, 45_000, 500)
    expect(stopped.sessionId).toBe(bound.sessionId)
    const ownName = String(stopped.name ?? '').trim()
    expect(ownName.toLowerCase()).toBe('juno')

    // Its person's Swarm, with this computer in it, as Desktop has it before Attach.
    const tab = (await api('/api/super-tabs', 'POST', { operationId: randomUUID(), name: 'Personal' })).id as string
    expect((await me.client.request('super_tabs', { action: 'wake' }))).toMatchObject({ ok: true })

    // Attach, in Desktop's order: resume (agent_resume), read the Swarm, agent.new (local), agent.add, wake the host.
    const resumed = await me.client.request('agent_resume', { agentId: harnessId, creationId: randomUUID() }, 90_000)
    expect(resumed.error, JSON.stringify(resumed)).toBeUndefined()
    const running = await until('juno to run again', async () => (await rows()).find(a => a.id === harnessId && a.status === 'active' && a.sessionId) ?? null, 60_000, 500)
    expect(running.sessionId).toBe(bound.sessionId)
    const before = await swarm(tab)
    expect((before.agents ?? []).map((a: any) => String(a.displayName ?? a.name).toLowerCase())).not.toContain('juno')
    const creationId = randomUUID()
    const command = async (step: string, body: Record<string, unknown>) =>
      (await api(`/api/super-tabs/${tab}/commands`, 'POST', { operationId: `${creationId}-${step}`, command: body })).result as Record<string, any>
    const chat = await command('chat', { type: 'agent.new', kind: 'regular', machineId: me.machineId, engine: 'claude', name: ownName, local: true })
    expect(chat.conversationId, JSON.stringify(chat)).toEqual(expect.any(String))
    const added = await command('join', { type: 'agent.add', conversationId: chat.conversationId, machineId: me.machineId, harnessId,
      name: ownName, lead: false, configuration: { engine: 'claude', model: running.modelName ?? null, effort: running.modelEffort ?? null,
        contextWindow: null, engineVersion: null } })
    expect(added.agentId, JSON.stringify(added)).toEqual(expect.any(String))
    expect((await me.client.request('super_tabs', { action: 'wake' }))).toMatchObject({ ok: true })

    // It is in Your Team under its own name, its chat its own.
    const after = await swarm(tab)
    const member = (after.agents as Array<Record<string, any>>).find(a => a.id === added.agentId)
    expect(member, JSON.stringify(after.agents)).toBeDefined()
    expect(member!.displayName ?? member!.name).toBe(ownName)
    expect(member!.harnessId).toBe(harnessId)
    // Another session of the same name is refused with the code Desktop then picks a name of the Swarm's on (new_agent.dart
    // _nameRefusals), in any case.
    const twin = await backend.api(person, `/api/super-tabs/${tab}/commands`, 'POST', { operationId: randomUUID(),
      command: { type: 'agent.new', kind: 'regular', machineId: me.machineId, engine: 'claude', name: 'JUNO', local: true } })
    expect(twin.status, JSON.stringify(twin.body)).toBe(409)
    expect(twin.body.error.code).toBe('AGENT_NAME_TAKEN')

    // Its person writes in its chat; the very words are typed into it, and its answer lands in the chat, once.
    const typed = 'Please read the README and tell me what this repo is.'
    await api(`/api/super-tabs/${tab}/commands`, 'POST', { operationId: randomUUID(), command: { type: 'message.send',
      conversationId: chat.conversationId, text: typed, replyTo: null, recipientIds: [added.agentId] } })
    const messages = async () => (await api(`/api/super-tabs/${tab}/conversations/${chat.conversationId}/messages`)).messages as Array<Record<string, any>>
    const answer = await until('its answer in the chat', async () =>
      (await messages()).find(m => m.author?.kind === 'agent' && String(m.text).includes(typed) && !m.agentOnly) ?? null, 90_000, 500)
    expect(answer.author.id).toBe(added.agentId)
    expect((await messages()).filter(m => m.author?.kind === 'agent' && String(m.text).includes(typed))).toHaveLength(1)
  }, 6 * 60_000)

  // anh Dee, 2026-11-10: the agents Attach had renamed are deleted from Your Team, and the sessions attached again by name.
  it('Delete, then Attach again: the session is still there to attach, and it gets its own name back', async () => {
    const me = await signIn(backend, person, { ANTHROPIC_API_KEY: 'fixture-not-a-credential', OPENAI_API_KEY: 'fixture-not-a-credential',
      HARNESS_SWARM: '' })
    onTestFailed(() => {
      console.log(`---- daemon\n${tail(me.daemon.log(), 150)}`)
      console.log(`---- backend\n${tail(readFileSync(backend.logPath, 'utf8'), 80)}`)
    })
    const api = async (path: string, method = 'GET', body?: unknown) => {
      const r = await backend.api(person, path, method, body)
      expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBe(200)
      return r.body.data
    }
    const swarm = async (tab: string) => reassemble(storeOf({ ...(await api(`/api/super-tabs/${tab}/parts`)), tabId: tab })) as Record<string, any>
    const rows = async () => (await me.client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents
    const cwd = join(me.daemon.projectsDir, 'sandbox'); mkdirSync(cwd, { recursive: true })
    const created = await me.client.request('agent_create', { engine: 'claude', cwd, bypassPermission: false, name: 'pip' }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const harnessId = created.agent.id as string
    await until('pip to bind its conversation', async () => (await rows()).find(a => a.id === harnessId && a.sessionId && a.status === 'active') ?? null, 60_000, 500)
    const tab = (await api('/api/super-tabs', 'POST', { operationId: randomUUID(), name: 'Personal' })).id as string
    expect((await me.client.request('super_tabs', { action: 'wake' }))).toMatchObject({ ok: true })
    const attach = async (name: string) => {
      const creationId = randomUUID()
      const command = async (step: string, body: Record<string, unknown>) =>
        (await api(`/api/super-tabs/${tab}/commands`, 'POST', { operationId: `${creationId}-${step}`, command: body })).result as Record<string, any>
      const chat = await command('chat', { type: 'agent.new', kind: 'regular', machineId: me.machineId, engine: 'claude', name, local: true })
      const added = await command('join', { type: 'agent.add', conversationId: chat.conversationId, machineId: me.machineId, harnessId, name,
        lead: false, configuration: { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null } })
      return added.agentId as string
    }
    // Attached under a name it was not given, as Desktop before 1.4.15 did.
    const cade = await attach('Cade')
    expect((await swarm(tab)).agents.map((a: any) => a.displayName ?? a.name)).toContain('Cade')

    // Delete (delete_agent.dart): the Swarm lets go of it.
    await api(`/api/super-tabs/${tab}/commands`, 'POST', { operationId: randomUUID(), command: { type: 'agent.remove', agentId: cade } })
    await until('Cade to leave Your Team', async () => (await swarm(tab)).agents.every((a: any) => a.id !== cade) || null, 30_000, 500)
    // Its session is on its computer still, running or stopped, for Attach to find (swarm_screen.dart _attachContext).
    // Running still: the Swarm's removal stops nothing on the computer (backend agent.remove); Desktop's Delete stops it first (#3791).
    const after = await until('the session to settle', async () => (await rows()).find(a => a.id === harnessId) ?? null, 30_000, 500)
    if (after.status === 'stopped') {
      const resumed = await me.client.request('agent_resume', { agentId: harnessId, creationId: randomUUID() }, 90_000)
      expect(resumed.error, JSON.stringify(resumed)).toBeUndefined()
      await until('pip to run again', async () => (await rows()).find(a => a.id === harnessId && a.status === 'active') ?? null, 60_000, 500)
    }

    // Attached again by its own name: the name its deleted row had is free.
    const pip = await attach('pip')
    const member = (await swarm(tab)).agents.find((a: any) => a.id === pip)
    expect(member?.displayName ?? member?.name).toBe('pip')
    expect(member?.harnessId).toBe(harnessId)
  }, 6 * 60_000)

  it('+ New agent: its chat opens first, the session Desktop starts with its launch line joins it, its first answer is in its chat, and it answers there', async () => {
    const me = await signIn(backend, person, { ANTHROPIC_API_KEY: 'fixture-not-a-credential', OPENAI_API_KEY: 'fixture-not-a-credential',
      HARNESS_SWARM: '' })
    onTestFailed(() => {
      console.log(`---- daemon\n${tail(me.daemon.log(), 150)}`)
      console.log(`---- backend\n${tail(readFileSync(backend.logPath, 'utf8'), 80)}`)
    })
    const api = async (path: string, method = 'GET', body?: unknown) => {
      const r = await backend.api(person, path, method, body)
      expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBe(200)
      return r.body.data
    }
    const tab = (await api('/api/super-tabs', 'POST', { operationId: randomUUID(), name: 'Personal' })).id as string
    const creationId = randomUUID()
    const command = async (step: string, body: Record<string, unknown>) =>
      (await api(`/api/super-tabs/${tab}/commands`, 'POST', { operationId: `${creationId}-${step}`, command: body })).result as Record<string, any>
    // Desktop's order (new_agent.dart swarmNewAgent): the chat, then the session on this computer, then agent.add.
    const chat = await command('chat', { type: 'agent.new', kind: 'regular', machineId: me.machineId, engine: 'claude', name: 'Orion', local: true })
    const cwd = join(me.daemon.projectsDir, 'orion'); mkdirSync(cwd, { recursive: true })
    // Its launch line as Desktop writes it (launch_prompt.dart): its name, then its person's request, which the join records as
    // their first words in its chat (initialMessage).
    const request = 'Tidy the docs.'
    const created = await me.client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true, swarmRole: 'dev',
      prompt: `You are Orion.\n\n${request}` }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const added = await command('join', { type: 'agent.add', conversationId: chat.conversationId, machineId: me.machineId,
      harnessId: created.agent.id, name: 'Orion', lead: false,
      configuration: { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }, initialMessage: request })
    expect((await me.client.request('super_tabs', { action: 'wake' }))).toMatchObject({ ok: true })

    // Its person writes at once, as anh Dee did (2026-11-10: "in the terminal i can see that arlo has the first message but i didn't
    // see it in the chat. my "hi" was the first message in the chat"): by the time anything reads the transcript, its last turn is
    // theirs, and the answer to its launch line is still posted, once, as the agent.
    const typed = 'Add a line to the README saying hello.'
    await api(`/api/super-tabs/${tab}/commands`, 'POST', { operationId: randomUUID(), command: { type: 'message.send',
      conversationId: chat.conversationId, text: typed, replyTo: null, recipientIds: [added.agentId] } })
    const messages = async () => (await api(`/api/super-tabs/${tab}/conversations/${chat.conversationId}/messages`)).messages as Array<Record<string, any>>
    const answer = await until('its answer in the chat', async () =>
      (await messages()).find(m => m.author?.kind === 'agent' && String(m.text).includes(typed) && !m.agentOnly) ?? null, 90_000, 500)
    expect(answer.author.id).toBe(added.agentId)
    const first = await until('its answer to its launch line in the chat', async () =>
      (await messages()).find(m => m.author?.kind === 'agent' && String(m.text).includes('You are Orion.') && !m.agentOnly) ?? null, 90_000, 500)
    expect(first.author.id).toBe(added.agentId)
    const all = await messages()
    expect(all.filter(m => m.author?.kind === 'agent' && String(m.text).includes('You are Orion.'))).toHaveLength(1)
    expect(all.filter(m => m.author?.kind === 'person').map(m => m.text)).toEqual(expect.arrayContaining([request, typed]))
  }, 6 * 60_000)
})
