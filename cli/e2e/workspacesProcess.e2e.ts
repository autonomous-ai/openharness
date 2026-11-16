/**
 * Workspaces in their own process, the edge host (harnessd/services.ts `SERVICE_HOSTS`), on the real daemon
 * (`HARNESSD_SERVICES=workspaces`: the edge host running workspaces alone; here also with search and the
 * viewers): the branch Harness made up for a worktree takes its session's name, renamed by the workspaces
 * process and shown on the agent's frame by the core. Whatever happens to the process costs workspaces alone. Stopped,
 * hung, killed or crashing on every start, the core never restarts, agents keep working, and frames keep their branch
 * names, which the core reads itself. A core that restarts leaves the process running. Nothing removes a worktree on a
 * timer (#4166): the person's list of leftover worktrees and their clean are answered there, with the folders in use
 * asked of the core as each request arrives.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

/** Git as the test runs it: the daemon's throwaway home, never this machine's configuration. */
const git = (d: IsolatedDaemon, cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { env: { ...process.env, HOME: d.env.HOME, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' }).trim()

/** A repository with one commit, in the daemon's projects folder. */
function repository(d: IsolatedDaemon): string {
  const dir = join(d.projectsDir, 'repo')
  mkdirSync(dir, { recursive: true })
  git(d, dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), 'a repository\n')
  git(d, dir, 'add', 'README.md')
  git(d, dir, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '-m', 'start')
  return dir
}
/** A worktree where Harness keeps them (`~/harnesses/worktrees/<repo>/<name>`), on its own branch;
 *  `placeholder` marks the branch as the made-up name Harness gives one at Start. */
function worktree(d: IsolatedDaemon, repo: string, name: string, placeholder = false): string {
  const path = join(d.env.HOME!, 'harnesses', 'worktrees', 'repo', name)
  git(d, repo, 'worktree', 'add', '-q', '-b', name, path)
  if (placeholder) git(d, repo, 'config', `branch.${name}.harness`, 'placeholder')
  return path
}
/** The workspaces process the master runs now, the edge host: the last one it said it started. Read from
 *  its log, never from the process table, where another daemon's services could be. */
const workspacesPid = (d: IsolatedDaemon): number | null => {
  const started = [...d.log().matchAll(/\[harnessd\] service edge started \(pid (\d+)\)/g)]
  return started.length ? Number(started[started.length - 1][1]) : null
}
const restarts = (d: IsolatedDaemon) => [...d.log().matchAll(/\[harnessd\] service edge started .* restart \d+/g)].length
const ready = (d: IsolatedDaemon) => [...d.log().matchAll(/\[cli\] ready/g)].length
const connected = (d: IsolatedDaemon) => d.log().split('[services] workspaces connected').length - 1

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)
async function create(d: IsolatedDaemon, client: LocalClient, cwd: string, engine = 'claude'): Promise<Record<string, any>> {
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${cwd}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${cwd} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' && agent.tmuxPane ? agent : null
  }, 60_000, 500)
}
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const ended = client.next((frame: Frame) => frame.type === 'turn_ended' && frame.agentId === agentId, 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  await ended
}
/** The agent's session gets a name: its terminal's title, as Claude Code sets it. */
const name = (d: IsolatedDaemon, agent: Record<string, any>, title: string) => d.tmux.run('select-pane', '-t', agent.tmuxPane, '-T', title)
const branchOf = async (client: LocalClient, agentId: string) => (await row(client, agentId))?.project?.branch ?? null
/** The agent's branch is `login` on its frame, pushed to the window, and in git. */
async function named(d: IsolatedDaemon, client: LocalClient, agent: Record<string, any>, cwd: string): Promise<void> {
  await client.waitFor((frame) => frame.type === 'agent_synced' && frame.payload?.agent?.id === agent.id && frame.payload.agent.project?.branch === 'login',
    45_000, 'the agent\'s frame with its branch named after its session')
  expect(await branchOf(client, agent.id)).toBe('login')
  expect(git(d, cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('login')
}

describe('workspaces in their own process', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async (env: Record<string, string> = {}, prepare: (d: IsolatedDaemon) => void = () => {}) => {
    const d = await IsolatedDaemon.create({ env: {
      HARNESSD_SERVICES: 'workspaces',
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200',
      HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
      ...env,
    } })
    daemon = d
    prepare(d)
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    await until('workspaces to connect to the core', () => connected(d) >= 1 || null, 30_000, 100)
    return d
  }

  it('the made-up branch takes the session\'s name in the workspaces process, never in the core, and reaches the frame; search and the viewers run beside it', async () => {
    const d = await fresh({ HARNESSD_SERVICES: 'search,viewers,workspaces' })
    for (const service of ['search', 'viewers']) {
      await until(`${service} to connect to the core`, () => d.log().includes(`[services] ${service} connected`) || null, 30_000, 200)
    }
    const client = await LocalClient.connect(d)
    const cwd = worktree(d, repository(d), 'brave-otter', true)
    const agent = await create(d, client, cwd)
    expect((await row(client, agent.id))?.project).toMatchObject({ branch: 'brave-otter', branchPending: true, worktree: true })
    // Stopped: the core neither renames the branch nor stops building frames that show it.
    const pid = workspacesPid(d)!
    process.kill(pid, 'SIGSTOP')
    try {
      await name(d, agent, 'Fix the login page')
      await turn(client, agent.id, 'while workspaces is stopped')
      await new Promise((done) => setTimeout(done, 11_000))
      expect(await branchOf(client, agent.id)).toBe('brave-otter')
    } finally {
      process.kill(pid, 'SIGCONT')
    }
    await named(d, client, agent, cwd)
    expect((await client.request('session_search', { query: 'login' }, 30_000)).error).toBeUndefined()
    expect(restarts(d)).toBe(0)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('hung, it is killed at the heartbeat watch and started again; the core goes on, and the new process names the branch', async () => {
    const d = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '2000' })
    const client = await LocalClient.connect(d)
    const cwd = worktree(d, repository(d), 'brave-otter', true)
    const agent = await create(d, client, cwd)
    const first = workspacesPid(d)!
    process.kill(first, 'SIGSTOP')
    await until('the master to find workspaces hung', () => d.log().includes('[harnessd] service edge sent no heartbeat') || null, 30_000, 200)
    await until('workspaces to be started again', () => restarts(d) >= 1 || null, 30_000, 200)
    expect(workspacesPid(d)).not.toBe(first)
    await turn(client, agent.id, 'the core never waited on workspaces')
    expect(await branchOf(client, agent.id)).toBe('brave-otter')
    await name(d, agent, 'Fix the login page')
    await named(d, client, agent, cwd)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('killed outright, it is brought back, and names the branch it missed', async () => {
    let cwd = ''
    const d = await fresh({ HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '15000' }, (d) => {
      cwd = worktree(d, repository(d), 'brave-otter', true)
    })
    await until('the core to be ready', () => ready(d) >= 1 || null, 30_000, 100)
    const first = workspacesPid(d)!
    process.kill(first, 'SIGKILL')
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, cwd)
    await turn(client, agent.id, 'while workspaces was gone')
    await until('workspaces to be back', () => restarts(d) >= 1 && connected(d) >= 2 || null, 60_000, 200)
    await name(d, agent, 'Fix the login page')
    await named(d, client, agent, cwd)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('crashing on every start, it is parked; agents work, and their frames keep their branches', async () => {
    const d = await IsolatedDaemon.create({ env: {
      HARNESSD_SERVICES: 'workspaces', HARNESSD_TEST_FAULTS: 'workspaces.crash', HARNESSD_SERVICE_PARK_CRASHES: '3',
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
    } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const client = await LocalClient.connect(d)
    const cwd = worktree(d, repository(d), 'brave-otter', true)
    const agent = await create(d, client, cwd)
    await until('the master to park workspaces', () => d.log().includes('[harnessd] service edge ended 3 times') || null, 60_000, 250)
    await turn(client, agent.id, 'workspaces is parked and nothing else cares')
    expect(await branchOf(client, agent.id)).toBe('brave-otter')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('a core that restarts leaves the workspaces process running: it names the branch for the new core', async () => {
    const d = await fresh()
    let client = await LocalClient.connect(d)
    const cwd = worktree(d, repository(d), 'brave-otter', true)
    const agent = await create(d, client, cwd)
    const workspaces = workspacesPid(d)
    const wired = ready(d)
    process.kill(d.corePid()!, 'SIGKILL')
    await until('a new core to finish starting', () => ready(d) > wired || null, 60_000, 200)
    await until('workspaces to reach the new core', () => connected(d) >= 2 || null, 30_000, 200)
    client.close()
    client = await LocalClient.connect(d)
    await until('the agent to be live again', async () => (await row(client, agent.id))?.status === 'active' || null, 60_000, 250)
    await name(d, agent, 'Fix the login page')
    await named(d, client, agent, cwd)
    expect(workspacesPid(d)).toBe(workspaces)
    expect(restarts(d)).toBe(0)
    client.close()
  })

  it('lists the leftover worktrees for the person, and a clean checks each again: one an agent works in and one gone stay as they are', async () => {
    let repo = ''
    let unused = ''
    let used = ''
    // Linux's trash is the home's (lib/trash.ts), here a folder of this test's own. A Mac's is the person's own Trash,
    // which no test moves anything to: there the clean is shown refusing only.
    const data = mkdtempSync(join(tmpdir(), 'trash-'))
    try {
      const d = await fresh({ XDG_DATA_HOME: data }, (d) => {
        repo = repository(d)
        unused = worktree(d, repo, 'old-idea')
        used = worktree(d, repo, 'still-going')
      })
      const client = await LocalClient.connect(d)
      const agent = await create(d, client, used)
      expect(await client.request('worktrees_list', {}, 60_000)).toMatchObject({
        worktrees: [{ path: unused, repository: expect.stringMatching(/[\\/]repo$/), branch: 'old-idea', uncommitted: false, sizeComplete: true }],
        more: false,
      })
      const gone = join(d.env.HOME!, 'harnesses', 'worktrees', 'repo', 'gone')
      expect(await client.request('worktrees_clean', { paths: [used, gone] }, 60_000))
        .toMatchObject({ results: [{ path: used, state: 'in_use' }, { path: gone, state: 'not_found' }] })
      expect(existsSync(join(used, 'README.md'))).toBe(true)
      expect(d.log()).toContain('[worktrees] 0 of 2 moved to the Trash · kept: in_use, not_found')
      if (process.platform === 'linux') {
        expect(await client.request('worktrees_clean', { paths: [unused] }, 60_000)).toMatchObject({ results: [{ path: unused, state: 'trashed', pruned: true }] })
        expect(existsSync(join(data, 'Trash', 'files', 'old-idea', 'README.md'))).toBe(true)
        expect(git(d, repo, 'worktree', 'list', '--porcelain')).not.toContain('old-idea')
        expect(git(d, repo, 'branch', '--list', 'old-idea')).toContain('old-idea')
      }
      await turn(client, agent.id, 'my worktree is still here')
      expect(d.coresStarted()).toBe(1)
      client.close()
    } finally {
      rmSync(data, { recursive: true, force: true })
    }
  })
})
