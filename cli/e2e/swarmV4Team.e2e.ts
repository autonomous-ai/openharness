/** Swarm v4 for a team of two people, each on their own computer and their own account: the real backend, two daemons signed in
 * as two people, fake Claude Code engines and private tmux servers. The owner makes the project and its PM; a teammate is invited,
 * joins, and starts a builder on their own computer; the PM and the builder talk across the two people in the project's channel;
 * the owner pauses the teammate's builder and the teammate resumes it. What one person's Swarm already proves (swarmV4Journey) is
 * not proved again: here, what changes when the agents are two people's (anh Dee, 2026-11-11: a first team uses the Swarm
 * tomorrow). Needs the backend's in-memory Mongo and Redis (HARNESS_E2E_SERVICES_DIR, see harness/realBackend.ts). */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, type TestContext } from 'vitest'
import { superTabCommand } from '../src/superTabs/command.js'
import { CLI_ROOT, until, type IsolatedDaemon } from './harness/daemon.js'
import type { LocalClient } from './harness/client.js'
import { account, signIn, startRealBackend, type Account, type RealBackend } from './harness/realBackend.js'

const owner = account('owner'), teammate = account('teammate')
let backend: RealBackend
interface Computer { daemon: IsolatedDaemon; machineId: string; client: LocalClient }
const KEYS = { ANTHROPIC_API_KEY: 'fixture-not-a-credential', OPENAI_API_KEY: 'fixture-not-a-credential', HARNESS_SWARM: '' }
const CONFIG = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const tail = (text: string, lines: number) => text.split('\n').slice(-lines).join('\n')

/** A repository shaped like a team's, reached by its GitHub address through git's `insteadOf`: nothing here touches GitHub. */
function throwawayRepository(): { root: string; gitconfig: string; url: string } {
  const root = mkdtempSync(join(tmpdir(), 'v4-team-repo-'))
  const bare = join(root, 'shop.git'), work = join(root, 'work')
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=', ...args], { cwd, env, stdio: 'pipe' })
  git(root, 'init', '-q', '--bare', '--initial-branch=main', bare)
  git(root, 'clone', '-q', bare, work)
  writeFileSync(join(work, 'AGENTS.md'), '# The shop\n\nThe goal: a small shop.\n')
  git(work, 'add', '.')
  git(work, 'commit', '-q', '-m', 'The shop')
  git(work, 'push', '-q', 'origin', 'HEAD:main')
  const gitconfig = join(root, 'gitconfig')
  writeFileSync(gitconfig, `[url "file://${bare}"]\n\tinsteadOf = https://github.com/throwaway-org/shop.git\n\tinsteadOf = https://github.com/throwaway-org/shop\n`)
  return { root, gitconfig, url: 'https://github.com/throwaway-org/shop' }
}

describe.skipIf(!process.env.HARNESS_E2E_SERVICES_DIR)('the Swarm v4 team: two people, each on their own computer and account', () => {
  let repository: ReturnType<typeof throwawayRepository>
  let A: Computer, B: Computer, tab: string, channel: string
  const agents: Record<string, { id: string; harnessId: string; chat: string; on: Computer; cwd: string }> = {}
  let failed: string | null = null
  function step(context: TestContext): void {
    if (failed) context.skip(`an earlier step failed: ${failed}`)
    onTestFailed(() => {
      failed ??= context.task.name
      for (const [name, c] of [['owner\'s computer', A], ['teammate\'s computer', B]] as const) if (c) console.log(`---- ${name}\n${tail(c.daemon.log(), 100)}`)
      if (backend) console.log(`---- backend\n${tail(readFileSync(backend.logPath, 'utf8'), 60)}`)
    })
  }

  beforeAll(async () => {
    repository = throwawayRepository()
    backend = await startRealBackend([owner, teammate], () => {})
    const computer = (who: Account) => signIn(backend, who, { ...KEYS, GIT_CONFIG_GLOBAL: repository.gitconfig }, daemon => {
      writeFileSync(join(daemon.engineConfig.codexHome, 'models_cache.json'),
        readFileSync(join(CLI_ROOT, 'src/lib/__fixtures__/codex-home-0.160/models_cache.json')))
    }, { submissionGate: true })
    A = await computer(owner)
    B = await computer(teammate)
  }, 600_000)
  afterAll(async () => {
    await backend?.stop()
    if (repository) rmSync(repository.root, { recursive: true, force: true })
  })

  /** One command as [who]'s Desktop sends it, in the Swarm: the receipt's result, or, refused, its status and error. */
  async function attempt(body: Record<string, unknown>, who: Account): Promise<{ status: number; body: Record<string, any> }> {
    return backend.api(who, `/api/super-tabs/${tab}/commands`, 'POST', { operationId: randomUUID(), command: body })
  }
  async function command(body: Record<string, unknown>, who: Account = owner): Promise<Record<string, any>> {
    const r = await attempt(body, who)
    expect(r.status, `${String(body.type)}: ${JSON.stringify(r.body)}`).toBe(200)
    return r.body.data.result as Record<string, any>
  }
  const messages = async (conversation: string, who: Account = owner) =>
    ((await backend.api(who, `/api/super-tabs/${tab}/conversations/${conversation}/messages`)).body.data.messages as Array<Record<string, any>>)
  const jsonLines = <T>(file: string): T[] => {
    let text: string
    try { text = readFileSync(file, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    return text.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line) as T)
  }
  /** Everything typed into [name]'s session, as its fake engine's own transcripts keep it. */
  function typedInto(name: string): string[] {
    const agent = agents[name]!
    const folder = join(agent.on.daemon.engineConfig.claudeProjectsDir, realpathSync(agent.cwd).replace(/[^a-zA-Z0-9]/g, '-'))
    let files: string[]
    try { files = readdirSync(folder).filter(f => f.endsWith('.jsonl')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    return files.flatMap(file => jsonLines<Record<string, any>>(join(folder, file)))
      .filter(r => r.type === 'user' && !r.isMeta && !r.isCompactSummary && typeof r.message?.content === 'string')
      .map(r => r.message.content as string)
  }
  /** What an agent on [c] runs: `harness super-tab --agent ID …`, its printed answer and exit code. */
  async function superTab(c: Computer, agent: string, args: string[]): Promise<{ code: number; out: string }> {
    let out = ''
    const code = await superTabCommand(['--tab', tab, '--agent', agent, ...args],
      { where: () => ({ port: c.daemon.port, dataDir: c.daemon.dataDir, machineId: c.machineId }), env: {}, print: text => { out = text } })
    return { code, out }
  }
  /** An agent started on [c] the way Desktop starts one: a clone of the repository, followed until it is made and bound. */
  async function started(c: Computer, payload: Record<string, unknown>): Promise<{ harnessId: string; cwd: string }> {
    const creationId = `team-${randomUUID()}`
    let created = await c.client.request('agent_create', { creationId, bypassPermission: true, projectSource: 'remote', repositoryUrl: repository.url, ...payload }, 120_000)
    if (created.state === 'pending') created = await until('the creation to finish', async () => {
      const status = await c.client.request('agent_create_status', { creationId }, 30_000)
      return status.state !== 'pending' ? status : null
    }, 120_000, 500)
    expect(created, JSON.stringify(created)).toMatchObject({ state: 'created', agent: { engine: 'claude' } })
    const row = await until('the session to bind its conversation', async () => {
      const rows = (await c.client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents
      const found = rows.find(a => a.id === created.agent.id)
      return found?.sessionId && found.status === 'active' ? found : null
    }, 90_000, 500)
    return { harnessId: created.agent.id as string, cwd: (row.project?.cwd ?? row.cwd) as string }
  }

  it('the owner makes a project on a repository, and its PM starts on the owner\'s computer', async context => {
    step(context)
    tab = (await backend.api(owner, '/api/super-tabs', 'POST', { operationId: randomUUID(), name: 'Team' })).body.data.id as string
    const project = await command({ type: 'project.create', name: 'Shop', visibility: 'public', brief: 'Build the shop.' })
    channel = project.conversationId as string
    const pm = await started(A, { engine: 'claude', swarmRole: 'lead', prompt: 'You are Faye.\n\nBuild the shop.', name: 'Faye' })
    const joined = await command({ type: 'agent.add', conversationId: channel, machineId: A.machineId, harnessId: pm.harnessId, name: 'Faye', lead: true,
      project: { cwd: pm.cwd, repositoryUrl: repository.url }, configuration: CONFIG })
    agents.Faye = { id: joined.agentId as string, harnessId: pm.harnessId, chat: channel, on: A, cwd: pm.cwd }
    expect(await A.client.request('super_tabs', { action: 'wake' })).toMatchObject({ ok: true })
  }, 300_000)

  it('the owner invites a teammate, who joins and starts a builder on their own computer, under their own account', async context => {
    step(context)
    const invitation = await command({ type: 'invite.create', email: teammate.email, role: 'collaborator', conversationId: channel })
    await command({ type: 'invite.accept', inviteId: invitation.inviteId }, teammate)
    const chat = (await command({ type: 'agent.new', kind: 'regular', machineId: B.machineId, engine: 'claude', name: 'Gus', local: true }, teammate)).conversationId as string
    const builder = await started(B, { engine: 'claude', swarmRole: 'dev', prompt: 'You are Gus.\n\nTake the tasks you are given.', name: 'Gus' })
    const joined = await command({ type: 'agent.add', conversationId: chat, machineId: B.machineId, harnessId: builder.harnessId, name: 'Gus', lead: false,
      configuration: CONFIG, initialMessage: 'Take the tasks you are given.' }, teammate)
    agents.Gus = { id: joined.agentId as string, harnessId: builder.harnessId, chat, on: B, cwd: builder.cwd }
    expect(await B.client.request('super_tabs', { action: 'wake' })).toMatchObject({ ok: true })
    // Both read the project's channel, where their agents talk.
    for (const who of [owner, teammate]) {
      expect((await backend.api(who, `/api/super-tabs/${tab}/conversations/${channel}/messages`)).status, who.name).toBe(200)
    }
  }, 300_000)

  it('the owner\'s PM and the teammate\'s builder talk in the project\'s channel, each typed what the other says, once', async context => {
    step(context)
    const asked = await superTab(A, agents.Faye.id, ['post', channel, '@Gus can you take #1?'])
    expect(asked.code, asked.out).toBe(0)
    const typed = await until('Gus to be typed the line', () => typedInto('Gus').find(p => p.includes('@Gus can you take #1?')) ?? null, 120_000, 500)
    expect(typed).toContain('@Faye, to you:\n@Gus can you take #1?')
    // The line names no agent and asks for no operation: the agent's pane says who it is, and each post makes its own.
    const line = typed.split('\n').find(l => l.startsWith('Answer: ')) ?? ''
    expect(line).not.toContain('--agent')
    expect(line).not.toContain('UNIQUE_OPERATION_ID')
    const question = (await messages(channel)).find(m => m.text === '@Gus can you take #1?')!
    const flag = line.includes('--reply-to') ? '--reply-to' : '--answers'
    // The teammate's builder answers as the line says, with no operation of its own.
    const answered = await superTab(B, agents.Gus.id, ['post', channel, 'Yes: taking #1 now.', flag, question.id, '--to', agents.Faye.id])
    expect(answered.code, answered.out).toBe(0)
    const answer = await until('Gus\'s answer in the channel', async () => (await messages(channel, teammate)).find(m => m.text === 'Yes: taking #1 now.') ?? null, 60_000, 500)
    expect(answer.author).toMatchObject({ kind: 'agent', id: agents.Gus.id })
    await until('Faye to be typed Gus\'s answer', () => typedInto('Faye').some(p => p.includes('@Gus, to you:\nYes: taking #1 now.')) || null, 120_000, 500)
    // Once each, however long it waits.
    await new Promise(resolve => setTimeout(resolve, 5_000))
    expect(typedInto('Gus').filter(p => p.includes('@Gus can you take #1?'))).toHaveLength(1)
    expect(typedInto('Faye').filter(p => p.includes('Yes: taking #1 now.'))).toHaveLength(1)
  }, 360_000)

  // A builder no project holds is its person's own (backend projects.ts canReadAgent, task #4116): its person pauses and resumes
  // it; the owner, who does not see it, cannot; and a teammate cannot pause the owner's PM.
  it('the teammate pauses and resumes their builder; the owner cannot pause it, nor the teammate the owner\'s PM', async context => {
    step(context)
    const pausedAt = async (who: Account) => {
      const data = (await backend.api(who, `/api/super-tabs/${tab}/parts`)).body.data
      const rows = (data?.parts?.agents ?? data?.agents ?? []) as Array<Record<string, any>>
      return rows.map(row => row.data ?? row).find(agent => agent.id === agents.Gus.id)?.pausedAt
    }
    await command({ type: 'agent.pause', agentId: agents.Gus.id, paused: true }, teammate)
    await until('the teammate to see Gus paused', async () => typeof await pausedAt(teammate) === 'string' || null, 30_000, 500)
    expect((await attempt({ type: 'agent.pause', agentId: agents.Gus.id, paused: false }, owner)).status).toBe(404)
    await command({ type: 'agent.pause', agentId: agents.Gus.id, paused: false }, teammate)
    await until('the teammate to see Gus resumed', async () => await pausedAt(teammate) === undefined || null, 30_000, 500)
    const refused = await attempt({ type: 'agent.pause', agentId: agents.Faye.id, paused: true }, teammate)
    expect(refused.status, JSON.stringify(refused.body)).toBe(403)
  }, 120_000)
})
