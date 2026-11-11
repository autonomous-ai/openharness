/** Swarm v4, the way a person meets it, across the components: the real backend, two computers of one person (two real daemons
 * with fake Claude Code engines and private tmux servers), and the calls Desktop makes. A throwaway repository stands in for the
 * team's, reached by its GitHub address through git's own URL rewrite, never over the network. Steps depend on the ones before
 * them, as the person's morning does: a project and its PM, two builders, a message typed to one, the agents talking to each
 * other in the project's channel, a daemon that restarts, a computer that goes away, an agent deleted.
 * Needs the backend's in-memory Mongo and Redis (HARNESS_E2E_SERVICES_DIR, see harness/realBackend.ts). */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, type TestContext } from 'vitest'
import { PM_BASICS, SWARM_BASICS } from '../src/lib/swarmSkills.js'
import { superTabCommand } from '../src/superTabs/command.js'
import { CLI_ROOT, until, type IsolatedDaemon } from './harness/daemon.js'
import type { LocalClient } from './harness/client.js'
import { account, signIn, startRealBackend, type RealBackend } from './harness/realBackend.js'

const owner = account('owner')
let backend: RealBackend
interface Computer { daemon: IsolatedDaemon; machineId: string; client: LocalClient }
const KEYS = { ANTHROPIC_API_KEY: 'fixture-not-a-credential', OPENAI_API_KEY: 'fixture-not-a-credential', HARNESS_SWARM: '' }
const CONFIG = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const tail = (text: string, lines: number) => text.split('\n').slice(-lines).join('\n')

/** A repository shaped like a team's: a default branch holding its agent files. Kept in a bare folder that a clone of its GitHub
 *  address reaches through git's `insteadOf`, so nothing here touches GitHub. */
function throwawayRepository(): { root: string; gitconfig: string; url: string } {
  const root = mkdtempSync(join(tmpdir(), 'v4-journey-repo-'))
  const bare = join(root, 'shop.git'), work = join(root, 'work')
  // None of the person's own git config, signing, hooks or templates: only what this repository needs.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=', ...args], { cwd, env, stdio: 'pipe' })
  git(root, 'init', '-q', '--bare', '--initial-branch=main', bare)
  git(root, 'clone', '-q', bare, work)
  writeFileSync(join(work, 'AGENTS.md'), '# The shop\n\nThe goal: a small shop.\n')
  writeFileSync(join(work, 'CLAUDE.md'), '@AGENTS.md\n')
  git(work, 'add', '.')
  git(work, 'commit', '-q', '-m', 'The shop')
  git(work, 'push', '-q', 'origin', 'HEAD:main')
  const gitconfig = join(root, 'gitconfig')
  // The address a clone asks for, with and without `.git`: the longer prefix wins when both match.
  writeFileSync(gitconfig, `[url "file://${bare}"]\n\tinsteadOf = https://github.com/throwaway-org/shop.git\n\tinsteadOf = https://github.com/throwaway-org/shop\n`)
  return { root, gitconfig, url: 'https://github.com/throwaway-org/shop' }
}

describe.skipIf(!process.env.HARNESS_E2E_SERVICES_DIR)('the Swarm v4 journey, on the real backend and two computers of one person', () => {
  let repository: ReturnType<typeof throwawayRepository>
  let A: Computer, B: Computer, tab: string
  const agents: Record<string, { id: string; harnessId: string; chat: string; on: Computer; folder?: string; cwd?: string }> = {}
  let channel: string
  /** The first step that failed: the steps after it build on it, so they are skipped rather than failing for its reason. */
  let failed: string | null = null
  /** Each step: skipped after a failed one, and on its own failure the daemons' and the backend's logs. */
  function step(context: TestContext): void {
    if (failed) context.skip(`an earlier step failed: ${failed}`)
    onTestFailed(() => {
      failed ??= context.task.name
      for (const [name, c] of [['computer A', A], ['computer B', B]] as const) if (c) console.log(`---- ${name}\n${tail(c.daemon.log(), 100)}`)
      if (backend) console.log(`---- backend\n${tail(readFileSync(backend.logPath, 'utf8'), 60)}`)
    })
  }

  beforeAll(async () => {
    repository = throwawayRepository()
    backend = await startRealBackend([owner], () => {})
    const computer = () => signIn(backend, owner, { ...KEYS, GIT_CONFIG_GLOBAL: repository.gitconfig }, daemon => {
      writeFileSync(join(daemon.engineConfig.codexHome, 'models_cache.json'),
        readFileSync(join(CLI_ROOT, 'src/lib/__fixtures__/codex-home-0.160/models_cache.json')))
    }, { submissionGate: true })
    A = await computer()
    B = await computer()
  // Longer than the rig's own deadlines (realBackend.ts), so its own error, with the backend's log, is the one that is seen.
  }, 600_000)
  afterAll(async () => {
    await backend?.stop()
    if (repository) rmSync(repository.root, { recursive: true, force: true })
  })

  const api = (path: string, method = 'GET', body?: unknown) => backend.api(owner, path, method, body)
  /** One command as the person's Desktop sends it; the receipt's result. */
  async function command(body: Record<string, unknown>): Promise<Record<string, any>> {
    const r = await api(`/api/super-tabs/${tab}/commands`, 'POST', { operationId: randomUUID(), command: body })
    expect(r.status, `${String(body.type)}: ${JSON.stringify(r.body)}`).toBe(200)
    return r.body.data.result as Record<string, any>
  }
  const messages = async (conversation: string) =>
    ((await api(`/api/super-tabs/${tab}/conversations/${conversation}/messages`)).body.data.messages as Array<Record<string, any>>)
  /** The lines of a file the fake engines append to, one JSON value a line; none before the first. Only a missing file is none: a
   *  line that does not parse fails the test, so a check that something was NOT typed never passes on a file it could not read. */
  const jsonLines = <T>(file: string): T[] => {
    let text: string
    try { text = readFileSync(file, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    // The last line may be half written while an engine appends it: only whole lines count.
    return text.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line) as T)
  }
  /** Every launch of an engine on [c], as the fake engine kept its argv: the first message and the instructions the agent was started with. */
  const launches = (c: Computer) => jsonLines<{ engine: string; args: string[] }>(join(c.daemon.root, 'launch-argv'))
  /** The launch whose first message is [text], when there is one. */
  const launchedWith = (c: Computer, text: string) => launches(c).find(l => l.args.includes(text))
  /** Everything typed into [name]'s session, in order: the user records of its own transcripts (the fake engine writes Claude
   *  Code's, one folder per working folder), so what is typed into the PM beside it on the same computer never counts. */
  function typedInto(name: string): string[] {
    const agent = agents[name]!
    // Named for the folder as the engine sees it, links resolved (/var is /private/var on a Mac).
    const folder = join(agent.on.daemon.engineConfig.claudeProjectsDir, realpathSync(agent.cwd!).replace(/[^a-zA-Z0-9]/g, '-'))
    let files: string[]
    try { files = readdirSync(folder).filter(f => f.endsWith('.jsonl')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    return files.flatMap(file => jsonLines<Record<string, any>>(join(folder, file)))
      .filter(r => r.type === 'user' && !r.isMeta && !r.isCompactSummary && typeof r.message?.content === 'string')
      .map(r => r.message.content as string)
  }
  /** What an agent on [c] runs: `harness super-tab --agent ID …` in its own pane, its printed answer and exit code. */
  async function superTab(c: Computer, agent: string, args: string[]): Promise<{ code: number; out: string }> {
    let out = ''
    // No pane of the runner's own (a run started in tmux): the agent is named by --agent, as from its own pane.
    const code = await superTabCommand(['--tab', tab, '--agent', agent, ...args],
      { where: () => ({ port: c.daemon.port, dataDir: c.daemon.dataDir, machineId: c.machineId }), env: {}, print: text => { out = text } })
    return { code, out }
  }
  /** An agent started on [c] the way Desktop starts one in a project folder: with a creation receipt, followed until it is made. */
  async function startSession(c: Computer, payload: Record<string, unknown>): Promise<Record<string, any>> {
    const creationId = `journey-${randomUUID()}`
    // The first start on a computer clones the repository; the next ones there are worktrees of that clone, as Desktop makes them.
    const folder = payload.projectSource ? {} : { projectSource: 'remote', repositoryUrl: repository.url }
    let created = await c.client.request('agent_create', { creationId, bypassPermission: true, ...folder, ...payload }, 120_000)
    if (created.state === 'pending') created = await until('the creation to finish', async () => {
      const status = await c.client.request('agent_create_status', { creationId }, 30_000)
      return status.state !== 'pending' ? status : null
    }, 120_000, 500)
    expect(created, JSON.stringify(created)).toMatchObject({ state: 'created', agent: { engine: 'claude' } })
    return created
  }
  /** Desktop's + New agent, on [c]: its chat, the session started with "You are <name>." and its person's request, the join. */
  async function newAgent(c: Computer, name: string, request: string): Promise<void> {
    const chat = (await command({ type: 'agent.new', kind: 'regular', machineId: c.machineId, engine: 'claude', name, local: true })).conversationId as string
    // On Faye's computer, a worktree of her clone; on the other, its first clone.
    const worktree = c === agents.Faye?.on ? { projectSource: 'worktree', gitSource: agents.Faye.folder, branchBase: 'default' } : {}
    const created = await startSession(c, { engine: 'claude', swarmRole: 'dev', prompt: `You are ${name}.\n\n${request}`, name, ...worktree })
    const row = await until(`${name} to bind its conversation`, async () => {
      const rows = (await c.client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents
      const found = rows.find(a => a.id === created.agent.id)
      return found?.sessionId && found.status === 'active' ? found : null
    }, 90_000, 500)
    const joined = await command({ type: 'agent.add', conversationId: chat, machineId: c.machineId, harnessId: created.agent.id, name, lead: false,
      configuration: CONFIG, initialMessage: request })
    agents[name] = { id: joined.agentId as string, harnessId: created.agent.id as string, chat, on: c, cwd: (row.project?.cwd ?? row.cwd) as string }
    expect(await c.client.request('super_tabs', { action: 'wake' })).toMatchObject({ ok: true })
  }

  it('a person makes a project on a repository, and its PM starts on their computer with the repository cloned', async context => {
    step(context)
    tab = (await api('/api/super-tabs', 'POST', { operationId: randomUUID(), name: 'Journey' })).body.data.id as string
    // As Desktop's New Project does on the person's own computer: the project, then the session, then its join.
    const project = await command({ type: 'project.create', name: 'Shop', visibility: 'public', brief: 'Build the shop.' })
    channel = project.conversationId as string
    const created = await startSession(A, { engine: 'claude', swarmRole: 'lead', prompt: 'You are Faye.\n\nBuild the shop.', name: 'Faye' })
    const running = await until('Faye to bind its conversation', async () => {
      const rows = (await A.client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents
      const row = rows.find(a => a.id === created.agent.id)
      return row?.sessionId && row.status === 'active' ? row : null
    }, 90_000, 500)
    // The repository was cloned into its folder, and Faye was started in it.
    const folder = (running.project?.cwd ?? running.cwd) as string
    expect(readFileSync(join(folder, 'AGENTS.md'), 'utf8')).toContain('The goal: a small shop.')
    const joined = await command({ type: 'agent.add', conversationId: channel, machineId: A.machineId, harnessId: created.agent.id, name: 'Faye', lead: true,
      project: { cwd: folder, repositoryUrl: repository.url }, configuration: CONFIG })
    agents.Faye = { id: joined.agentId as string, harnessId: created.agent.id as string, chat: channel, on: A, folder, cwd: folder }
    expect(await A.client.request('super_tabs', { action: 'wake' })).toMatchObject({ ok: true })
    // Plain: its first message is its name and its person's request, nothing else; the team's basics reach it in the engine's own
    // instructions, with the PM's part.
    const launch = launchedWith(A, 'You are Faye.\n\nBuild the shop.')
    expect(launch, JSON.stringify(launches(A))).toBeTruthy()
    expect(launch!.args.join('\n')).toContain(`${SWARM_BASICS}\n${PM_BASICS}`)
  }, 300_000)

  it('two builders start the way + New agent starts them, one on each computer, each with its own chat', async context => {
    step(context)
    await newAgent(A, 'Pip', 'Take the first task.')
    await newAgent(B, 'Kai', 'Review what Pip ships.')
    // Plain: their name and their person's request, as typed, and nothing else.
    for (const [c, name, request] of [[A, 'Pip', 'Take the first task.'], [B, 'Kai', 'Review what Pip ships.']] as const) {
      const launch = launchedWith(c, `You are ${name}.\n\n${request}`)
      expect(launch, JSON.stringify(launches(c))).toBeTruthy()
      expect(launch!.args.join('\n')).toContain(SWARM_BASICS)
      expect(launch!.args.join('\n')).not.toContain(PM_BASICS)
    }
    // Each its own chat with its person, apart from the project's channel and from each other.
    expect(new Set([agents.Pip.chat, agents.Kai.chat, channel]).size).toBe(3)
  }, 300_000)

  it('its person reads a builder\'s instructions on its computer: its own agents/<name>.md, saved there, and the project\'s AGENTS.md and CLAUDE.md beside it', async context => {
    step(context)
    const read = () => B.client.request<Record<string, any>>('agent_instructions_read', { agentId: agents.Kai.harnessId, name: 'Kai' }, 30_000)
    const first = await read()
    // No file of its own yet; the repository's own files, read-only, as Desktop's Instructions shows them beside it.
    expect(first).toMatchObject({ text: null, version: '' })
    // Each where it is and which engine loads it (#3729): Codex AGENTS.md, Claude Code CLAUDE.md.
    expect(first.shared).toEqual([{ name: 'AGENTS.md', path: 'AGENTS.md', loadedBy: ['codex'], text: '# The shop\n\nThe goal: a small shop.\n', truncated: false },
      { name: 'CLAUDE.md', path: 'CLAUDE.md', loadedBy: ['claude'], text: '@AGENTS.md\n', truncated: false }])
    const rule = 'Review every pull request within the hour.\n'
    const saved = await B.client.request<Record<string, any>>('agent_instructions_write', { agentId: agents.Kai.harnessId, name: 'Kai', text: rule, version: '' }, 30_000)
    expect(saved.error, JSON.stringify(saved)).toBeUndefined()
    expect(await read()).toMatchObject({ text: rule, version: saved.version })
    // Its one copy is the file in its own folder on its own computer.
    expect(readFileSync(join(agents.Kai.cwd!, 'agents', 'Kai.md'), 'utf8')).toBe(rule)
    // Its person's own CLAUDE.md on that computer, which Claude Code reads for every session there, in the folder its session
    // keeps its transcripts under, comes beside them (anh Dee, 2026-11-11: "show users what goes into the agent").
    const mine = 'Answer in plain words.\n', own = join(B.daemon.root, 'claude', 'CLAUDE.md')
    writeFileSync(own, mine)
    expect((await read()).personal).toEqual([{ name: 'CLAUDE.md', path: own.split(sep).join('/'), loadedBy: ['claude'], text: mine, truncated: false }])
    // And what Harness adds at every start, as the engine was started with it: the Swarm's basics, with the PM's part for the PM.
    expect(await B.client.request('super_tabs', { action: 'basics', harnessId: agents.Kai.harnessId })).toMatchObject({ ok: true, text: SWARM_BASICS })
    expect(await A.client.request('super_tabs', { action: 'basics', harnessId: agents.Faye.harnessId })).toMatchObject({ ok: true, text: `${SWARM_BASICS}\n${PM_BASICS}` })
  }, 120_000)

  it('a person types to a builder in its chat: the agent is typed exactly that, and its answer comes back into the chat once', async context => {
    step(context)
    const typed = 'Please say hello to the team, then wait.'
    await command({ type: 'message.send', conversationId: agents.Pip.chat, text: typed, replyTo: null, recipientIds: [] })
    await until('Pip to be typed what its person typed', () => typedInto('Pip').includes(typed) || null, 120_000, 500)
    const answer = await until('Pip\'s answer in its chat', async () =>
      (await messages(agents.Pip.chat)).find(m => m.author?.kind === 'agent' && String(m.text).includes(typed)) ?? null, 120_000, 1_000)
    expect(answer.author).toMatchObject({ kind: 'agent', id: agents.Pip.id })
  }, 300_000)

  it('agents talk in the project channel: a post lands as an agent\'s, an @name reaches the other agent as text, and its answer comes back', async context => {
    step(context)
    const free = await superTab(A, agents.Pip.id, ['post', channel, 'free: Pip', 'op-free-pip'])
    expect(free.code, free.out).toBe(0)
    const posted = await until('Pip\'s post in the channel', async () => (await messages(channel)).find(m => m.text === 'free: Pip') ?? null, 60_000, 500)
    expect(posted.author).toMatchObject({ kind: 'agent', id: agents.Pip.id })
    const asked = await superTab(A, agents.Pip.id, ['post', channel, '@Kai can you review #12?', 'op-ask-kai'])
    expect(asked.code, asked.out).toBe(0)
    const typedToKai = await until('Kai to be typed the line', () => typedInto('Kai').find(p => p.includes('@Kai can you review #12?')) ?? null, 120_000, 500)
    // Who wrote it and the words, then one line that says how to answer: in the channel, below the line, to Pip.
    expect(typedToKai).toContain('@Pip, to you:\n@Kai can you review #12?')
    const line = typedToKai.split('\n').find(l => l.startsWith('Answer: ')) ?? ''
    const question = (await messages(channel)).find(m => m.text === '@Kai can you review #12?')!
    expect(line).toContain(`post '${channel}' 'your message' UNIQUE_OPERATION_ID`)
    expect(line).toMatch(new RegExp(`--(answers|reply-to) '${question.id}' --to '${agents.Pip.id}'$`))
    // The agent's answer is its own post, as that line says: Harness posts an agent's turn only in its 1:1 chat.
    const flag = line.includes('--reply-to') ? '--reply-to' : '--answers'
    const answered = await superTab(B, agents.Kai.id, ['post', channel, 'Yes: reading #12 now.', 'op-kai-answers', flag, question.id, '--to', agents.Pip.id])
    expect(answered.code, answered.out).toBe(0)
    const answer = await until('Kai\'s answer in the channel', async () =>
      (await messages(channel)).find(m => m.text === 'Yes: reading #12 now.') ?? null, 60_000, 500)
    expect(answer.author).toMatchObject({ kind: 'agent', id: agents.Kai.id })
    // And it reaches Pip, typed once.
    await until('Pip to be typed Kai\'s answer', () => typedInto('Pip').some(p => p.includes('@Kai, to you:\nYes: reading #12 now.')) || null, 120_000, 500)
  }, 360_000)

  it('after its computer\'s daemon restarts, an agent is still typed what is said to it, once', async context => {
    step(context)
    // Nothing wakes the Swarm's service after the restart but the daemon itself (its saved state), as after an update.
    await B.daemon.restart()
    const asked = await superTab(A, agents.Pip.id, ['post', channel, '@Kai are you still there?', 'op-ask-kai-again'])
    expect(asked.code, asked.out).toBe(0)
    await until('Kai to be typed the line after the restart', () => typedInto('Kai').some(p => p.includes('@Kai are you still there?')) || null, 180_000, 1_000)
  }, 360_000)

  it('while a builder\'s computer is away, what is said to it waits, and is typed once when the computer is back', async context => {
    step(context)
    // Its daemon is down; its session, in tmux, runs on and nobody types into it.
    await B.daemon.stop()
    // Away as the person's apps see it: the backend no longer lists the computer online.
    await until('the backend to see computer B away', async () => {
      const machines = (await api('/api/machines')).body.data.machines as Array<Record<string, any>>
      const status = machines.find(m => m.machineId === B.machineId)?.status
      return status !== undefined && status !== 'online' ? status : null
    }, 120_000, 1_000)
    const asked = await superTab(A, agents.Pip.id, ['post', channel, '@Kai the build is red, can you look?', 'op-ask-kai-away'])
    expect(asked.code, asked.out).toBe(0)
    await B.daemon.start()
    await until('Kai to be typed the line once its computer is back', () => typedInto('Kai').some(p => p.includes('@Kai the build is red, can you look?')) || null, 180_000, 1_000)
  }, 360_000)

  it('nothing was typed or posted twice, now that everything after it has arrived', async context => {
    step(context)
    // Every later step's message has arrived by now, so a copy of an earlier one that was going to come would have.
    const once = (list: string[], text: string) => expect(list.filter(p => p.includes(text)), text).toHaveLength(1)
    once(typedInto('Pip'), 'Please say hello to the team, then wait.')
    once(typedInto('Pip'), 'Yes: reading #12 now.')
    for (const line of ['@Kai can you review #12?', '@Kai are you still there?', '@Kai the build is red, can you look?']) once(typedInto('Kai'), line)
    expect((await messages(agents.Pip.chat)).filter(m => m.author?.kind === 'agent' && String(m.text).includes('Please say hello to the team'))).toHaveLength(1)
    expect((await messages(channel)).filter(m => m.text === 'Yes: reading #12 now.')).toHaveLength(1)
  }, 120_000)

  it('its person deletes a builder: the Swarm lets go of it, and its computer stops its session', async context => {
    step(context)
    const active = async () => ((await A.client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents)
      .some(a => a.id === agents.Pip.harnessId && a.status === 'active')
    expect(await active()).toBe(true)
    await command({ type: 'agent.remove', agentId: agents.Pip.id })
    await until('Pip\'s session to stop on its computer', async () => (await active()) ? null : true, 120_000, 1_000)
    // Faye, on the same computer, runs on.
    expect(((await A.client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents)
      .some(a => a.id === agents.Faye.harnessId && a.status === 'active')).toBe(true)
  }, 300_000)
})
