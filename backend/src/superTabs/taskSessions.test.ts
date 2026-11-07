import { describe, expect, it } from 'vitest'
import type { Command } from './commands.js'
import type { Actor } from './model.js'
import { canReadGroup, agentProjectId } from './projects.js'
import { applyMemberSetUp } from './taskSessions.js'
import { endBesidePrivate } from './liveness.js'
import { applyDiskReport } from './machines.js'
import { code, config, mate, NOW, own, swarm, type Swarm } from './taskSessions.test-support.js'

// Task #4543 (spec #4489 section 2, build task 6): a Member is one agent to its person, with a chat session that talks with
// them and never runs a task, and a task session per project that does the work, bound to that project alone by the server.
// Until build task 9 makes every agent a Member, a person's main Swarm Buddy on a host that says memberProjects is one.

/** mate's host carries out [startId] as a host does: dispatch, then the session runs as [harnessId]. */
function host(f: Swarm, startId: string, harnessId: string): string {
  f.run({ type: 'agent.startDispatch', startId }, mate, own('mate'))
  const agentId = f.run({ type: 'agent.started', startId, harnessId, configuration: config }, mate, own('mate')).result.agentId as string
  f.run({ type: 'agent.startSettled', startId, warning: null } as Command, mate, own('mate'))
  f.machine().observation!.runningHarnessIds.push(harnessId)
  return agentId
}
const assign = (f: Swarm, task: string, asPm: Actor) => f.run({ type: 'work.assign', conversationId: task, agentId: f.buddy }, asPm)
const finish = (f: Swarm, task: string, by: string) => f.run({ type: 'work.status', conversationId: task, assignmentId: f.group(task).assignment!.id,
  status: 'done', result: 'Done.' } as Command, { kind: 'agent', agentId: by, machineOwnerId: 'mate' })

describe('a Member\'s task', () => {
  it('starts the Member\'s task session for that project, which takes the task; the chat session never does', () => {
    const f = swarm()
    const app = f.project('app')
    const assigned = assign(f, app.task, app.asPm)
    const start = f.state.starts!.find(s => s.id === assigned.result.startId)!
    expect(start.request).toMatchObject({ conversationId: app.task, machineId: 'mate-mac', memberOf: f.buddy,
      memberProject: { id: app.projectId, name: 'app' }, worktree: true, cwd: `/swarm/${app.projectId}` })
    expect(start.request.buddyOf).toBeUndefined()
    // Held for its session while it starts.
    expect(f.group(app.task).assignment).toBeNull()
    expect(f.group(app.task).sessionStart).toMatchObject({ startId: start.id, memberId: f.buddy })
    const session = host(f, start.id, 'h-app')
    expect(f.agent(session)).toMatchObject({ memberOf: f.buddy, projectId: app.projectId })
    expect(f.agent(session).buddyOf).toBeUndefined()
    expect(f.group(app.task).assignment).toMatchObject({ agentId: session, status: 'working' })
    expect(f.group(app.task).sessionStart).toBeUndefined()
    expect(f.agent(f.buddy).projectsHeld).toEqual([app.projectId])
    // The chat session neither joins the task nor reads it as an agent of it; its task session is that project's alone.
    expect(f.group(app.task).agentIds).not.toContain(f.buddy)
    expect(agentProjectId(f.state, f.agent(session))).toBe(app.projectId)
  })

  it('goes to the same task session for a later task in that project, and to a new one in another project', () => {
    const f = swarm()
    const app = f.project('app'), docs = f.project('docs')
    const session = host(f, assign(f, app.task, app.asPm).result.startId as string, 'h-app')
    finish(f, app.task, session)
    const next = app.newTask('second')
    const again = assign(f, next, app.asPm)
    expect(again.result.startId).toBeUndefined()
    expect(f.group(next).assignment).toMatchObject({ agentId: session })
    finish(f, next, session)
    const other = host(f, assign(f, docs.task, docs.asPm).result.startId as string, 'h-docs')
    expect(other).not.toBe(session)
    expect(f.agent(other)).toMatchObject({ memberOf: f.buddy, projectId: docs.projectId })
    expect(f.agent(f.buddy).projectsHeld).toEqual([app.projectId, docs.projectId])
    // Its session reads only its own project.
    const asDocs: Actor = { kind: 'agent', agentId: other, machineOwnerId: 'mate' }
    expect(canReadGroup(f.state, asDocs, f.group(docs.task))).toBe(true)
    expect(canReadGroup(f.state, asDocs, f.group(next))).toBe(false)
  })

  it('is refused by name in a private project, on a computer holding a private project\'s files, while busy, and on an older host', () => {
    const f = swarm()
    const app = f.project('app'), secret = f.project('secret', 'private')
    const person = f.state.people.find(p => p.id === 'mate')!
    f.state.projects!.find(p => p.id === secret.projectId)!.members.push({ id: person.id, generation: person.generation } as never)
    // Its Lead never sees a Member there; its own person, who reads it, is refused by name.
    expect(code(() => assign(f, secret.task, secret.asPm))).toBe('AGENT_UNAVAILABLE')
    expect(code(() => assign(f, secret.task, mate))).toBe('MEMBER_PRIVATE')
    f.machine().privateOnDisk = [secret.projectId]
    expect(code(() => assign(f, app.task, app.asPm))).toBe('MEMBER_PRIVATE_ON_DISK')
    delete f.machine().privateOnDisk
    assign(f, app.task, app.asPm)
    expect(code(() => assign(f, app.newTask('second'), app.asPm))).toBe('MEMBER_BUSY')
    const older = swarm(['regularAgent', 'swarmBuddy'])
    const there = older.project('app')
    expect(code(() => assign(older, there.task, there.asPm))).toBe('AGENT_UNAVAILABLE')
    expect(code(() => assign(older, there.task, mate))).toBe('BUDDY_NOT_ASSIGNABLE')
    expect(older.state.starts ?? []).toEqual([])
  })

  it('is refused in a project its person cannot read', () => {
    const f = swarm()
    const secret = f.project('secret', 'private')
    expect(code(() => assign(f, secret.task, secret.asPm))).not.toBeNull()
    expect(f.state.starts ?? []).toEqual([])
  })

  it('for a sixth project names the one used longest ago for its host to drop, and stops that session once the new one runs', () => {
    const f = swarm()
    const projects = ['a', 'b', 'c', 'd', 'e'].map(name => f.project(name))
    const sessions = projects.map(p => { const s = host(f, assign(f, p.task, p.asPm).result.startId as string, `h-${p.projectId}`); finish(f, p.task, s); return s })
    // b used again: a is now the oldest.
    const b = projects[1]!, bAgain = b.newTask('again')
    assign(f, bAgain, b.asPm)
    finish(f, bAgain, sessions[1]!)
    const sixth = f.project('f')
    const sixthStart = assign(f, sixth.task, sixth.asPm).result.startId
    const start = f.state.starts!.find(s => s.id === sixthStart)!
    expect(start.request.dropProjectId).toBe(projects[0]!.projectId)
    host(f, start.id, 'h-sixth')
    expect(f.agent(f.buddy).projectsHeld).toEqual([projects[2]!, projects[3]!, projects[4]!, b, sixth].map(p => p.projectId))
    expect(f.agent(sessions[0]!).workDecision).toBe('stop')
  })

  it('is not taken again by its task session when someone else took the task while it started', () => {
    const f = swarm()
    const app = f.project('app')
    const startId = assign(f, app.task, app.asPm).result.startId as string
    const other = f.run({ type: 'agent.add', conversationId: app.conversationId, machineId: 'app-mac', harnessId: 'h-other', name: 'Other',
      configuration: config, lead: false }, { kind: 'person', userId: 'owner', email: 'owner@example.com' }, own('owner')).result.agentId as string
    f.run({ type: 'work.assign', conversationId: app.task, agentId: other }, app.asPm)
    expect(f.group(app.task).sessionStart).toBeUndefined()
    const session = host(f, startId, 'h-app')
    expect(f.group(app.task).assignment).toMatchObject({ agentId: other })
    expect(f.agent(session).memberOf).toBe(f.buddy)
  })

  it('waits again when its task session\'s start fails, saying why in the task', () => {
    const f = swarm()
    const app = f.project('app')
    const startId = assign(f, app.task, app.asPm).result.startId as string
    f.run({ type: 'agent.startDispatch', startId }, mate, own('mate'))
    const failed = f.run({ type: 'agent.startFailed', startId, error: 'The oldest project folder still has unpushed work.' } as Command, mate, own('mate'))
    expect(failed.messages.some(m => m.conversationId === app.task && m.text.startsWith('Could not start Bo'))).toBe(true)
    expect(f.group(app.task).sessionStart).toBeUndefined()
    expect(f.group(app.task).assignment).toBeNull()
    // Free again: a new assignment starts it again.
    expect(assign(f, app.task, app.asPm).result.startId).toBeDefined()
  })
})

describe('what a Member\'s host reports set up', () => {
  /** mate's Member with its task session in [name], running. */
  function working(f: Swarm, name: string) {
    const p = f.project(name)
    const session = host(f, assign(f, p.task, p.asPm).result.startId as string, `h-${name}`)
    return { ...p, session }
  }
  const report = (f: Swarm, setUp: Record<string, string[]>, at = 0) => applyMemberSetUp(f.state, 'mate-mac', setUp, NOW + at)

  it('tells the project\'s Lead, as the task session, once, that it is ready after its first set-up there', () => {
    const f = swarm()
    const app = working(f, 'app')
    const rows = report(f, { [f.buddy]: [app.projectId] })
    expect(rows).toEqual([expect.objectContaining({ conversationId: app.conversationId, text: 'Ready to work on app.', recipients: [app.pm],
      author: expect.objectContaining({ kind: 'agent', id: app.session }) })])
    expect(f.agent(f.buddy).setUp).toEqual([{ projectId: app.projectId, at: NOW }])
    expect(report(f, { [f.buddy]: [app.projectId] }, 5_000)).toEqual([])
    expect(f.agent(f.buddy).setUp).toEqual([{ projectId: app.projectId, at: NOW }])
  })

  it('drops a project its host no longer holds from set-up and held, but not one whose task session is starting again', () => {
    const f = swarm()
    const app = working(f, 'app')
    finishAll(f)
    const docs = working(f, 'docs')
    finishAll(f)
    report(f, { [f.buddy]: [app.projectId, docs.projectId] })
    // app's session went down; its next task starts it again, in the worktree its host still holds.
    f.agent(app.session).downSince = new Date(NOW).toISOString()
    assign(f, app.newTask('again'), app.asPm)
    report(f, { [f.buddy]: [] }, 1_000)
    expect(f.agent(f.buddy).setUp).toBeUndefined()
    expect(f.agent(f.buddy).projectsHeld).toEqual([app.projectId])
    // Reported for an agent that is no Member here, nothing changes and nothing is written.
    expect(report(f, { nobody: [app.projectId], [app.session]: [app.projectId] })).toEqual([])
  })

  /** Every task of mate's Member's sessions done. */
  function finishAll(f: Swarm) {
    for (const c of f.state.conversations.filter(c => c.assignment?.status === 'working')) finish(f, c.id, c.assignment!.agentId)
  }
})

// Security review 2 of #3553: every way a task session gets work meets its Member's checks, and private files that reach its
// computer later end its public work there before they arrive, or as soon as its host says they are there.
describe('a task session beside a private project\'s files', () => {
  /** mate's Member with its task session in app, which has finished its first task; and a private project mate reads. */
  function beside() {
    const f = swarm()
    const app = f.project('app'), secret = f.project('secret', 'private')
    const person = f.state.people.find(p => p.id === 'mate')!
    f.state.projects!.find(p => p.id === secret.projectId)!.members.push({ id: person.id, generation: person.generation } as never)
    const session = host(f, assign(f, app.task, app.asPm).result.startId as string, 'h-app')
    finish(f, app.task, session)
    return { f, app, secret, session }
  }

  it('is refused by its own id as by its Member\'s: private files there, or its Member busy', () => {
    const { f, app, secret, session } = beside()
    f.machine().privateOnDisk = [secret.projectId]
    expect(code(() => f.run({ type: 'work.assign', conversationId: app.newTask('by id'), agentId: session }, app.asPm))).toBe('MEMBER_PRIVATE_ON_DISK')
    delete f.machine().privateOnDisk
    const docs = f.project('docs')
    assign(f, docs.task, docs.asPm)
    expect(code(() => f.run({ type: 'work.assign', conversationId: app.newTask('busy'), agentId: session }, app.asPm))).toBe('MEMBER_BUSY')
  })

  it('loses its task and stops once its host reports a private project\'s files there', () => {
    const { f, app, secret, session } = beside()
    const next = app.newTask('next')
    f.run({ type: 'work.assign', conversationId: next, agentId: f.buddy }, app.asPm)
    expect(f.group(next).assignment).toMatchObject({ agentId: session, status: 'working' })
    applyDiskReport(f.state, f.machine(), { ...f.machine().observation!, projectsOnDisk: [secret.projectId] })
    const rows = endBesidePrivate(f.state, 'mate-mac', NOW)
    expect(f.group(next).assignment!.status).toBe('lost')
    expect(f.agent(session).workDecision).toBe('stop')
    expect(rows.some((r: { conversationId: string }) => r.conversationId === next)).toBe(true)
  })

  it('makes a private project\'s start there wait until its public task sessions are down, which stop for it', () => {
    const { f, secret, session } = beside()
    const start = f.run({ type: 'agent.start', request: { conversationId: secret.task, machineId: 'mate-mac', engine: 'claude', name: 'Secret worker',
      cwd: `/swarm/${secret.projectId}`, worktree: true, requirements: { memoryBytes: 1, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } } as Command,
      mate, own('mate')).result.startId as string
    expect(code(() => f.run({ type: 'agent.startDispatch', startId: start }, mate, own('mate')))).toBe('PRIVATE_WAITS')
    endBesidePrivate(f.state, 'mate-mac', NOW)
    expect(f.agent(session).workDecision).toBe('stop')
    f.agent(session).downSince = new Date(NOW).toISOString()
    f.run({ type: 'agent.startDispatch', startId: start }, mate, own('mate'))
    expect(f.machine().privateOnDisk).toEqual([secret.projectId])
  })

  it('does not take its held task when private files reached its computer while it started', () => {
    const f = swarm()
    const app = f.project('app'), secret = f.project('secret', 'private')
    const startId = assign(f, app.task, app.asPm).result.startId as string
    f.machine().privateOnDisk = [secret.projectId]
    const session = host(f, startId, 'h-app')
    expect(f.group(app.task).assignment).toBeNull()
    expect(f.agent(session).workDecision).toBe('stop')
  })

  it('tells nobody of a private project, or one it has no task session in, in its Member\'s set-up', () => {
    const { f, app, secret } = beside()
    const docs = f.project('docs')
    applyMemberSetUp(f.state, 'mate-mac', { [f.buddy]: [app.projectId, secret.projectId, docs.projectId] }, NOW)
    expect(f.agent(f.buddy).setUp!.map(e => e.projectId)).toEqual([app.projectId])
  })

  it('takes no task until its host said what is on its disk, nor where a private project\'s own folder or another Swarm is', () => {
    const { f, app, secret } = beside()
    delete f.machine().observation!.projectsOnDisk
    expect(code(() => assign(f, app.newTask('unread'), app.asPm))).toBe('MEMBER_DISK_UNREAD')
    f.machine().observation!.projectsOnDisk = []
    f.state.projects!.find(p => p.id === secret.projectId)!.repository = { machineId: 'mate-mac', cwd: '/Users/mate/secret' } as never
    expect(code(() => assign(f, app.newTask('own folder'), app.asPm))).toBe('MEMBER_PRIVATE_ON_DISK')
    delete f.state.projects!.find(p => p.id === secret.projectId)!.repository
    f.machine().observation!.otherSwarms = true
    expect(code(() => assign(f, app.newTask('other swarm'), app.asPm))).toBe('MEMBER_PRIVATE_ON_DISK')
    delete f.machine().observation!.otherSwarms
    f.machine().observation!.projectsOnDisk = ['another-swarms-project']
    expect(code(() => assign(f, app.newTask('unknown'), app.asPm))).toBe('MEMBER_PRIVATE_ON_DISK')
  })

  it('stops when its own project is made private', () => {
    const { f, app, session } = beside()
    f.state.projects!.find(p => p.id === app.projectId)!.visibility = 'private'
    endBesidePrivate(f.state, 'mate-mac', NOW)
    expect(f.agent(session).workDecision).toBe('stop')
  })
})
