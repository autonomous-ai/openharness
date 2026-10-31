import { describe, expect, it, vi } from 'vitest'
import type { CoreApi } from '../core/api.js'
import { fakeCore } from '../testing/fakeCore.js'
import { FIXTURE, ok, readFixture, refused, type BackendReply } from './fixtures/read/index.js'
import type { SuperTabHost } from './host.js'
import { superTabService } from './service.js'

type Json = Record<string, unknown>
const T = FIXTURE.tabId, M = FIXTURE.machineId
const owner = { local: true, owner: true }

/** The fixture Swarm on its own machine: the host form lists the Lead and the Builder, each reads its own view by parts. */
function swarm(extra: (method: string, path: string, body?: unknown) => BackendReply | undefined = () => undefined) {
  const call = vi.fn<CoreApi['account']['backend']>(async (method, path, body) => {
    const answer = extra(method, path, body)
    if (answer) return answer
    if (path.startsWith(`/api/super-tabs/hosts/${M}/changes`)) return ok(readFixture('host-full'))
    if (path === `/api/super-tabs/${T}/parts?asAgentId=${FIXTURE.leadId}`) return ok(readFixture('parts-lead'))
    if (path === `/api/super-tabs/${T}/parts?asAgentId=${FIXTURE.builderId}`) return ok(readFixture('parts-builder'))
    if (path.startsWith(`/api/super-tabs/${T}/changes?`)) return ok(readFixture('changes-reload'))
    return ok({ messages: [], next: null })
  })
  const core = fakeCore({ account: { backend: call }, daemon: { machineId: () => M } as never,
    agents: { byAgent: vi.fn((id: string) => ([FIXTURE.leadHarness, FIXTURE.builderHarness] as string[]).includes(id) ? { agentId: id } as never : undefined) } })
  const service = superTabService(core, { host: () => ({ machineId: M, start: vi.fn(), stop: vi.fn() }) as unknown as SuperTabHost })
  const reads = () => call.mock.calls.map(c => c[1]).filter(path => /\/parts|\/changes\?cursor|\/super-tabs\/[A-Za-z0-9]+\?/.test(path) && !path.includes('/hosts/'))
  return { call, core, ask: service.requests.super_tabs, reads }
}
/** What the status action printed before #1726, recorded from that code with the same Swarm; `revision` is gone now. */
const golden = (who: 'lead' | 'builder') => {
  const { value, ...rest } = readFixture<{ value: Json }>(`status-${who}`)
  const { revision: _revision, ...kept } = value
  return { ...rest, value: { ...kept, lastChangedAt: 1793010101002 } }
}

describe('status from parts', () => {
  it('prints for a Lead what it printed before, with lastChangedAt in place of revision', async () => {
    expect(await swarm().ask({ action: 'status', tabId: T, agentId: FIXTURE.leadId }, owner)).toEqual(golden('lead'))
  })
  it('prints for a Builder what it printed before, with lastChangedAt in place of revision', async () => {
    expect(await swarm().ask({ action: 'status', tabId: T, agentId: FIXTURE.builderId }, owner)).toEqual(golden('builder'))
  })
  it('finds the caller by its harness, as the roster lists it on this machine', async () => {
    const s = swarm()
    expect(await s.ask({ action: 'status', tabId: T, harnessId: FIXTURE.builderHarness }, owner)).toEqual(golden('builder'))
  })
})

describe('what each action reads of the Swarm', () => {
  it.each([
    ['messages', { conversationId: FIXTURE.workGroup }],
    ['message', { conversationId: FIXTURE.workGroup, messageId: 'f00000000000000000000001' }],
    ['terminalResult', { terminalRequestId: 'r1' }],
    ['startStatus', { startId: FIXTURE.startId }],
    ['attachment', { conversationId: FIXTURE.workGroup, step: 'sent', operationId: 'op-1' }],
    ['command', { operationId: 'op-2', command: { type: 'message.send', conversationId: FIXTURE.workGroup, text: 'Hi', replyTo: null, recipientIds: [] } }],
    ['help', {}],
    ['decisions', { state: 'open' }],
  ])('reads nothing of it for %s', async (action, payload) => {
    const s = swarm()
    const answer = await s.ask({ action, tabId: T, agentId: FIXTURE.builderId, ...payload }, owner)
    expect(answer).not.toHaveProperty('error')
    expect(s.reads()).toEqual([])
  })
  it('reads the people only for a post that tags someone', async () => {
    const s = swarm()
    await s.ask({ action: 'command', tabId: T, agentId: FIXTURE.leadId, operationId: 'op-3',
      command: { type: 'message.send', conversationId: FIXTURE.leadGroup, text: 'Please decide', replyTo: null, recipientIds: [], mentions: ['dev@example.com'] } }, owner)
    expect(s.reads()).toEqual([`/api/super-tabs/${T}/parts?asAgentId=${FIXTURE.leadId}`])
    expect(s.call).toHaveBeenCalledWith('POST', `/api/super-tabs/${T}/commands`, expect.objectContaining({
      command: expect.objectContaining({ mentions: [FIXTURE.collaboratorId] }) }))
  })
  // Project instructions, phase 4: every agent reads the same help, with --mention.
  it('offers every agent the same help, without reading the Swarm', async () => {
    const s = swarm()
    const lead = await s.ask({ action: 'help', tabId: T, agentId: FIXTURE.leadId }, owner)
    const builder = await s.ask({ action: 'help', tabId: T, agentId: FIXTURE.builderId }, owner)
    expect(String(object(lead.help).post)).toContain('--mention')
    expect(builder.help).toEqual(lead.help)
    for (const help of [lead.help, builder.help]) expect(String(object(help).react)).toMatch(/^react GROUP MESSAGE_ID EMOJI OPERATION_ID \[--off\]: .*eyes.*check.*rocket/)
    expect(s.reads()).toEqual([])
  })
  it('reads the roster as it is now for every call, so an agent started a moment ago is known at once', async () => {
    let started = false
    const s = swarm((_method, path) => path.startsWith(`/api/super-tabs/hosts/${M}/changes`) && !started
      ? ok({ ...readFixture<Json>('host-full'), tabs: [] }) : undefined)
    expect(await s.ask({ action: 'messages', tabId: T, agentId: FIXTURE.builderId, conversationId: FIXTURE.workGroup }, owner)).toMatchObject({ error: 'AGENT_UNAVAILABLE' })
    started = true
    expect(await s.ask({ action: 'messages', tabId: T, agentId: FIXTURE.builderId, conversationId: FIXTURE.workGroup }, owner)).toMatchObject({ ok: true })
    expect(s.call.mock.calls.map(c => c[1]).filter(path => path.includes('/hosts/')))
      .toEqual([`/api/super-tabs/hosts/${M}/changes?full=1`, `/api/super-tabs/hosts/${M}/changes?cursor=eyJ2IjoyLCJ0IjoxNzkzMDEwMDc0Mzc1LCJlIjowfQ`])
  })
  // The server leaves an agent off the roster when this machine has no access or billing for it: the error says where to look.
  it('refuses a caller the roster does not list here, or whose session is not running, saying which', async () => {
    const s = swarm()
    expect(await s.ask({ action: 'messages', tabId: T, agentId: 'a0000000000000000000000z', conversationId: FIXTURE.workGroup }, owner))
      .toEqual({ error: 'AGENT_UNAVAILABLE', detail: 'This agent is not on this machine\'s Swarm roster right now. That can mean this machine has no access to it, or its billing does not allow it. Check how this machine is shared.' })
    vi.mocked(s.core.agents.byAgent).mockReturnValue(undefined)
    expect(await s.ask({ action: 'messages', tabId: T, agentId: FIXTURE.builderId, conversationId: FIXTURE.workGroup }, owner))
      .toEqual({ error: 'AGENT_UNAVAILABLE', detail: 'This agent is not a running contribution on this machine.' })
  })
  it('tells the person to update Harness when the server needs a newer one', async () => {
    const s = swarm((_method, path) => path.includes('/parts') ? { status: 426, body: { success: false, error: { code: 'UPDATE_REQUIRED' } } } : undefined)
    expect(await s.ask({ action: 'status', tabId: T, agentId: FIXTURE.leadId }, owner))
      .toEqual({ error: 'UPDATE_REQUIRED', detail: 'Update Harness to keep using this Swarm.', status: 426 })
  })
})

const object = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}

// Design 3.6: groups number their messages apart, so a Lead's report names how far it read in each group, not one revision.
describe('the project report a Lead is shown how to send', () => {
  it('names how far it read in each group, never one revision of the Swarm', async () => {
    const { help } = await swarm().ask({ action: 'help' }, owner) as { help: { commands: Json[] } }
    const report = help.commands.find(c => c.type === 'project.report')
    expect(report).toEqual({ type: 'project.report', projectId: 'PROJECT', through: { GROUP: 214031 },
      text: 'What changed, what is blocked, and what comes next. Use null when nothing merits repeating.' })
    expect(JSON.stringify(help)).not.toContain('throughRevision')
  })
})

// Review round 1: a group that left the active set (archived, or finished and idle) is not in the cached parts, yet its own
// Lead still reads its route history. The group is read by id, as the backend serves an active or a dormant one.
describe('route history of a group outside the active set', () => {
  const DORMANT = 'c0000000000000000000000d'
  const history = (leadId: string | null) => swarm((_method, path) => {
    if (path.startsWith(`/api/super-tabs/${T}/groups/${DORMANT}?`)) return leadId === null
      ? { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'No such group.' } } }
      : ok({ group: { key: DORMANT, version: 214200, changedAt: 1, data: { id: DORMANT, leadId, agentIds: [leadId], archived: true, dormant: true } } })
    if (path.includes('/route-decisions') || path.includes('/attempts')) return ok([])
    return undefined
  })
  const ask = (s: ReturnType<typeof swarm>, agentId: string) => s.ask({ action: 'routeHistory', tabId: T, agentId, conversationId: DORMANT }, owner)
  const logReads = (s: ReturnType<typeof swarm>) => s.call.mock.calls.filter(c => c[1].includes('/route-decisions')).length

  it('gives a dormant group\'s own Lead its history', async () => {
    const s = history(FIXTURE.leadId)
    expect(await ask(s, FIXTURE.leadId)).toEqual({ ok: true, value: { decisions: [], attempts: [] } })
    expect(s.call).toHaveBeenCalledWith('GET', `/api/super-tabs/${T}/groups/${DORMANT}?asAgentId=${FIXTURE.leadId}`, undefined)
  })
  // Project instructions, phase 4: any agent of the project routes, so any agent that can read the group reads its history.
  it('gives any agent that can read it its history, and refuses only a group the caller cannot read', async () => {
    const other = history(FIXTURE.leadId)
    expect(await ask(other, FIXTURE.builderId)).toEqual({ ok: true, value: { decisions: [], attempts: [] } })
    expect(logReads(other)).toBe(1)
    const unreadable = history(null)
    expect(await ask(unreadable, FIXTURE.leadId)).toMatchObject({ error: 'NOT_FOUND', status: 404 })
    expect(logReads(unreadable)).toBe(0)
  })
})

describe('route history when the group cannot be read for another reason', () => {
  it('says so, rather than calling the caller no Lead', async () => {
    const s = swarm((_method, path) => path.includes('/groups/') ? { status: 503, body: { success: false, error: { code: 'SWARM_BUSY', message: 'Busy' } } } : undefined)
    expect(await s.ask({ action: 'routeHistory', tabId: T, agentId: FIXTURE.leadId, conversationId: FIXTURE.workGroup }, owner))
      .toEqual({ error: 'SWARM_BUSY', detail: 'Busy', status: 503 })
  })
})

describe('decisions', () => {
  it('reads the decisions the caller asked, open or answered, as that agent', async () => {
    const listed = { decisions: [{ id: 'd1', question: 'Ship how?', options: ['Behind a flag', 'To everyone'], recommended: 0, choice: null }] }
    for (const state of ['open', 'answered']) {
      const s = swarm((method, path) => path.startsWith(`/api/super-tabs/${T}/decisions?`) ? ok(listed) : undefined)
      expect(await s.ask({ action: 'decisions', tabId: T, agentId: FIXTURE.leadId, state }, owner)).toEqual({ ok: true, value: listed })
      expect(s.call).toHaveBeenCalledWith('GET', `/api/super-tabs/${T}/decisions?state=${state}&asAgentId=${FIXTURE.leadId}`, undefined)
    }
  })
})

describe('instructions', () => {
  const document = { projectId: FIXTURE.projectId, revision: 3, hash: 'h', text: 'Work by this.', template: false, coordinatorName: 'Ana', notesRevision: 1, notes: [] }
  const instructionsPath = (projectId: string, agentId: string) => `/api/super-tabs/${T}/projects/${projectId}/instructions?asAgentId=${agentId}`
  const NO_ROUTE = 'This Swarm has no project instructions yet: work by the swarm skill Harness gave you at start.'

  it('reads the project the agent leads, or else the project of its open groups, as that agent', async () => {
    for (const agentId of [FIXTURE.leadId, FIXTURE.builderId]) {
      const s = swarm((_method, path) => path === instructionsPath(FIXTURE.projectId, agentId) ? ok(document) : undefined)
      expect(await s.ask({ action: 'instructions', tabId: T, agentId }, owner)).toEqual({ ok: true, value: document })
    }
  })
  // Final review: an agent just started (before work.assign) or added to the project chat from Desktop leads nothing and has
  // no assignment; it was told it is in no project and fell back to the old role text.
  describe('of an agent with no assignment yet', () => {
    /** The Builder's own view, with the groups it is listed in and its agent's project set by [shape]. */
    const builderView = (shape: (agents: Json[], groups: Json[]) => void) => {
      const parts = readFixture<Json>('parts-builder')
      const data = (list: unknown) => (list as Json[]).map(part => part.data as Json)
      for (const group of data(parts.groups)) {
        group.agentIds = (group.agentIds as string[]).filter(id => id !== FIXTURE.builderId)
        if (object(group.assignment).agentId === FIXTURE.builderId) group.assignment = null
      }
      const groups = data(parts.groups)
      shape(data(parts.agents), groups)
      return { ...parts, groups: groups.map(group => ({ key: group.id, version: 1, changedAt: 1, data: group })) }
    }
    const ask = (parts: Json, projectId: string) => {
      const s = swarm((_method, path) => path === `/api/super-tabs/${T}/parts?asAgentId=${FIXTURE.builderId}` ? ok(parts)
        : path === instructionsPath(projectId, FIXTURE.builderId) ? ok({ ...document, projectId }) : undefined)
      return s.ask({ action: 'instructions', tabId: T, agentId: FIXTURE.builderId }, owner)
    }
    it('reads the project its agent belongs to', async () => {
      const parts = builderView(agents => { agents.find(a => a.id === FIXTURE.builderId)!.projectId = 'p3' })
      expect(await ask(parts, 'p3')).toMatchObject({ ok: true, value: { projectId: 'p3' } })
    })
    it('else the project of an open group that lists it, before an archived one', async () => {
      const parts = builderView((agents, groups) => {
        delete agents.find(a => a.id === FIXTURE.builderId)!.projectId
        groups.unshift({ ...groups[0], id: 'c0000000000000000000000a', projectId: 'old', agentIds: [FIXTURE.builderId], archived: true })
        groups.push({ ...groups[0], id: 'c0000000000000000000000b', projectId: 'p4', agentIds: [FIXTURE.builderId], archived: false })
      })
      expect(await ask(parts, 'p4')).toMatchObject({ ok: true, value: { projectId: 'p4' } })
    })
  })
  it('names who asked for each note, as the status read has them, and keeps the id of one it does not', async () => {
    const notes = [{ id: 'n1', text: 'Ship Fridays.', askedBy: FIXTURE.collaboratorId, at: 1, expiresAt: null },
      { id: 'n2', text: 'Ask Ana.', askedBy: '6a000000000000000000000f', at: 2, expiresAt: null }]
    const s = swarm((_method, path) => path === instructionsPath('p2', FIXTURE.leadId) ? ok({ ...document, projectId: 'p2', notes }) : undefined)
    expect(await s.ask({ action: 'instructions', tabId: T, agentId: FIXTURE.leadId, projectId: 'p2' }, owner)).toMatchObject({ ok: true, value: { notes: [
      { id: 'n1', askedBy: FIXTURE.collaboratorId, askedByName: 'dev@example.com' }, { id: 'n2', askedBy: '6a000000000000000000000f' }] } })
    const value = (await s.ask({ action: 'instructions', tabId: T, agentId: FIXTURE.leadId, projectId: 'p2' }, owner)) as { value: { notes: Json[] } }
    expect(value.value.notes[1]).not.toHaveProperty('askedByName')
  })
  it('reads the project it is given', async () => {
    const s = swarm((_method, path) => path === instructionsPath('p2', FIXTURE.leadId) ? ok({ ...document, projectId: 'p2' }) : undefined)
    expect(await s.ask({ action: 'instructions', tabId: T, agentId: FIXTURE.leadId, projectId: 'p2' }, owner)).toMatchObject({ ok: true, value: { projectId: 'p2' } })
  })
  it('answers INSTRUCTIONS_UNAVAILABLE for the 404 of a backend without the route', async () => {
    // Fastify's own 404 body: no code of the backend's.
    const s = swarm((_method, path) => path.includes('/instructions') ? { status: 404, body: { message: 'Route GET:/x not found', error: 'Not Found', statusCode: 404 } } : undefined)
    expect(await s.ask({ action: 'instructions', tabId: T, agentId: FIXTURE.leadId }, owner)).toEqual({ error: 'INSTRUCTIONS_UNAVAILABLE', detail: NO_ROUTE })
  })
  it('passes the backend\'s own NOT_FOUND through unchanged', async () => {
    const s = swarm((_method, path) => path.includes('/instructions') ? refused(404, 'NOT_FOUND', 'No such project.') : undefined)
    expect(await s.ask({ action: 'instructions', tabId: T, agentId: FIXTURE.leadId }, owner)).toEqual({ error: 'NOT_FOUND', detail: 'No such project.', status: 404 })
  })
  it('passes the backend\'s own transient 503 through with its own detail, never sending the agent to its role file', async () => {
    const detail = 'The project instructions cannot be read now. Try again in a moment.'
    const s = swarm((_method, path) => path.includes('/instructions') ? refused(503, 'INSTRUCTIONS_UNAVAILABLE', detail) : undefined)
    expect(await s.ask({ action: 'instructions', tabId: T, agentId: FIXTURE.leadId }, owner)).toEqual({ error: 'INSTRUCTIONS_UNAVAILABLE', detail, status: 503 })
  })
  it('refuses an unsafe project id, and lists the command in help', async () => {
    const s = swarm()
    expect(await s.ask({ action: 'instructions', tabId: T, agentId: FIXTURE.leadId, projectId: '../x' }, owner)).toMatchObject({ error: 'INVALID_REQUEST' })
    expect(((await s.ask({ action: 'help', tabId: T, agentId: FIXTURE.builderId }, owner)) as { help: { instructions?: string } }).help.instructions).toMatch(/^instructions \[PROJECT\]: print your project's instructions/)
  })
})

describe('costs', () => {
  it('reads a project\'s CI load as that agent, and nothing for a malformed project id', async () => {
    const load = { state: 'read', load: { running: 3, queued: 0, macosRunning: 1, macosQueued: 0 } }
    const s = swarm((_method, path) => path.startsWith(`/api/super-tabs/${T}/projects/lead/ci-load?`) ? ok(load) : undefined)
    expect(await s.ask({ action: 'ciLoad', tabId: T, agentId: FIXTURE.leadId, projectId: 'lead' }, owner)).toEqual({ ok: true, value: load })
    expect(s.call).toHaveBeenCalledWith('GET', `/api/super-tabs/${T}/projects/lead/ci-load?asAgentId=${FIXTURE.leadId}`, undefined)
    expect(await s.ask({ action: 'ciLoad', tabId: T, agentId: FIXTURE.leadId, projectId: '../x' }, owner)).not.toHaveProperty('ok', true)
    expect(s.call.mock.calls.filter(c => String(c[1]).includes('ci-load'))).toHaveLength(1)
  })
  it('reads the cost summary of the period as that agent, and lists it in help', async () => {
    const summary = { days: 30, rows: [], totals: { attempts: 0 }, prices: [] }
    const s = swarm((_method, path) => path.startsWith(`/api/super-tabs/${T}/costs?`) ? ok(summary) : undefined)
    expect(await s.ask({ action: 'costs', tabId: T, agentId: FIXTURE.leadId, days: 30 }, owner)).toEqual({ ok: true, value: summary })
    expect(s.call).toHaveBeenCalledWith('GET', `/api/super-tabs/${T}/costs?days=30&asAgentId=${FIXTURE.leadId}`, undefined)
    expect(((await s.ask({ action: 'help', tabId: T, agentId: FIXTURE.leadId }, owner)) as { help: { costs?: string } }).help.costs).toMatch(/^costs \[--days N\]/)
  })
})
