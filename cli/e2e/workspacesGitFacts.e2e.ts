/**
 * The core runs no git for an agent's frame: the repository and branch each frame shows are the git facts the workspaces
 * service in the edge host reports (services/workspaces.ts), which the core keeps and reads from memory
 * (core/frameParts.ts). On the real daemon, with `git`, `ssh` and `du` on its PATH as shims that write down who
 * started them, every git child is the edge host's and none is the core's. The edge host gone, frames keep the facts it
 * last reported; back, it fills them again.
 *
 * GIT_FACTS_REST_SECONDS (default 20) is how long the ten agents rest while a window asks for the list every
 * GIT_FACTS_LIST_EVERY_SECONDS (default 5), as the desktop does every 60 s; the numbers are printed as JSON.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

/** Git as the test runs it: the daemon's throwaway home, never this machine's configuration. */
const git = (d: IsolatedDaemon, cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { env: { ...process.env, HOME: d.env.HOME, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8', timeout: 10_000 }).trim()

/** A repository with one commit on `main`, in the daemon's projects folder. */
function repository(d: IsolatedDaemon, name: string): string {
  const dir = join(d.projectsDir, name)
  mkdirSync(dir, { recursive: true })
  git(d, dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), `${name}\n`)
  mkdirSync(join(dir, 'app'), { recursive: true })
  writeFileSync(join(dir, 'app', 'main.ts'), 'export {}\n')
  git(d, dir, 'add', '.')
  git(d, dir, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '-m', 'start')
  git(d, dir, 'remote', 'add', 'origin', `https://github.com/e2e/${name}.git`)
  return dir
}

/** `git`, `ssh` and `du` on the daemon's PATH write who started them (`$PPID`) to [log], then run the real one. */
function shims(d: IsolatedDaemon, log: string): void {
  for (const name of ['git', 'ssh', 'du']) {
    const real = execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8', timeout: 10_000 }).trim()
    writeFileSync(join(d.root, 'bin', name), `#!/bin/sh\necho "$PPID ${name}" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 })
  }
}

/** Each child the shims saw, as [parent pid, command]. */
const children = (log: string): Array<[number, string]> => {
  let text = ''
  try { text = readFileSync(log, 'utf8') } catch { return [] }
  return text.split('\n').filter(Boolean).map((line) => { const [pid, name] = line.split(' '); return [Number(pid), name!] })
}

/** The edge host the master runs now: the last one it said it started. */
const edgePid = (d: IsolatedDaemon): number | null => {
  const started = [...d.log().matchAll(/\[harnessd\] service edge started \(pid (\d+)\)/g)]
  return started.length ? Number(started[started.length - 1][1]) : null
}
const connected = (d: IsolatedDaemon) => d.log().split('[services] workspaces connected').length - 1
const restarts = (d: IsolatedDaemon) => [...d.log().matchAll(/\[harnessd\] service edge started .* restart \d+/g)].length

const list = async (client: LocalClient) =>
  (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await list(client)).find((agent) => agent.id === agentId)

async function create(client: LocalClient, cwd: string): Promise<Record<string, any>> {
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${cwd}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${cwd} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' && agent.tmuxPane ? agent : null
  }, 60_000, 500)
}

const seconds = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback)
  return Number.isFinite(value) && value > 0 ? value : fallback
}
const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
}

// The ownership shim is POSIX-only; Windows process behavior needs its native runner.
describe.skipIf(process.platform === 'win32')('the git facts on agents\' frames', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async (env: Record<string, string> = {}) => {
    const d = await IsolatedDaemon.create({ env: {
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200',
      HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
      ...env,
    } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    return d
  }

  it('ten agents show their repositories and branches, and every git child is the edge host\'s, none the core\'s', async () => {
    const d = await fresh()
    const log = join(d.root, 'children.log')
    shims(d, log)
    await d.start()
    await until('workspaces to connect to the core', () => connected(d) >= 1 || null, 30_000, 100)
    const client = await LocalClient.connect(d)
    // Four repositories, three worktrees of the first, a subfolder of the second and two folders outside git.
    const names = ['alpha', 'beta', 'gamma', 'delta']
    const repos = names.map((name) => repository(d, name))
    const folders: Array<{ cwd: string; branch: string | null; remote: string | null; worktree?: boolean }> =
      repos.map((cwd, i) => ({ cwd, branch: 'main', remote: `github.com/e2e/${names[i]}` }))
    for (const branch of ['one', 'two', 'three']) {
      const cwd = join(d.projectsDir, 'worktrees', 'alpha', branch)
      git(d, repos[0]!, 'worktree', 'add', '-q', '-b', branch, cwd)
      folders.push({ cwd, branch, remote: 'github.com/e2e/alpha', worktree: true })
    }
    folders.push({ cwd: join(repos[1]!, 'app'), branch: 'main', remote: 'github.com/e2e/beta' })
    for (const name of ['notes', 'scratch']) folders.push({ cwd: join(d.projectsDir, name), branch: null, remote: null })
    const agents: Array<Record<string, any>> = []
    for (const folder of folders) agents.push(await create(client, folder.cwd))

    // Each frame names its repository and branch, as git says them, or none for a folder outside git.
    await until('every frame to show its git facts', async () => {
      const rows = await list(client)
      return folders.every((folder, i) => {
        const project = rows.find((agent) => agent.id === agents[i]!.id)?.project
        return project?.cwd === folder.cwd && project.branch === folder.branch && project.remote === folder.remote
          && project.kind === (folder.branch === null ? 'none' : 'git') && (project.root === null) === (folder.branch === null)
          && (folder.worktree ? project.worktree === true : project.worktree === undefined)
      }) || null
    }, 60_000, 500)
    const rows = await list(client)
    for (const agent of agents) expect(rows.find((each) => each.id === agent.id)?.gitContext?.state).toBe('workspace')

    // At rest, a window asks for the list as the desktop does; nobody turns.
    const core = d.corePid()!, edge = edgePid(d)!
    const before = children(log).length
    const rest = seconds('GIT_FACTS_REST_SECONDS', 20) * 1000, every = seconds('GIT_FACTS_LIST_EVERY_SECONDS', 5) * 1000
    const took: number[] = []
    const started = Date.now()
    while (Date.now() - started < rest) {
      const at = performance.now()
      expect((await list(client)).length).toBeGreaterThanOrEqual(agents.length)
      took.push(performance.now() - at)
      await new Promise((done) => setTimeout(done, every))
    }
    const minutes = (Date.now() - started) / 60_000
    const window = children(log).slice(before)
    const all = children(log)
    const by = (rows: Array<[number, string]>, pid: number) => rows.filter(([parent]) => parent === pid).length
    console.log(JSON.stringify({ gitFacts: {
      agents: agents.length, restSeconds: Math.round(minutes * 60), listEverySeconds: every / 1000,
      coreChildrenPerMinute: by(window, core) / minutes, edgeChildrenPerMinute: by(window, edge) / minutes,
      coreChildrenTotal: by(all, core), edgeChildrenTotal: by(all, edge),
      agentsListMs: { p50: Math.round(percentile(took, 0.5)), p95: Math.round(percentile(took, 0.95)), samples: took.length },
    } }))
    // The core started none, from the first agent to the last list; the edge host did the git.
    expect(all.filter(([parent]) => parent === core)).toEqual([])
    expect(by(all, edge)).toBeGreaterThan(0)
    client.close()
  }, 240_000 + seconds('GIT_FACTS_REST_SECONDS', 20) * 1000)

  it('the edge host gone, frames keep the facts it last reported; back, it fills them again, and the core never restarts', async () => {
    const d = await fresh({ HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '8000', HARNESSD_SERVICE_MAX_BACKOFF_MS: '8000' })
    await d.start()
    await until('workspaces to connect to the core', () => connected(d) >= 1 || null, 30_000, 100)
    const client = await LocalClient.connect(d)
    const cwd = repository(d, 'kept')
    const agent = await create(client, cwd)
    await until('the frame to show main', async () => (await row(client, agent.id))?.project?.branch === 'main' || null, 60_000, 250)
    process.kill(edgePid(d)!, 'SIGKILL')
    await until('the core to see workspaces go', () => d.log().includes('[services] workspaces disconnected') || null, 30_000, 100)
    // Moved while nobody reports it: the frame keeps the last word, and the agent works.
    git(d, cwd, 'switch', '-q', '-c', 'feature')
    const reply = await client.turn(agent.id, 'while the edge host is gone')
    expect(reply).toBeTruthy()
    const kept = await row(client, agent.id)
    expect(kept?.project).toMatchObject({ kind: 'git', cwd, branch: 'main', remote: 'github.com/e2e/kept' })
    expect(kept?.gitContext?.current?.branch).toBe('main')
    await until('the edge host to be back', () => restarts(d) >= 1 && connected(d) >= 2 || null, 60_000, 200)
    await client.waitFor((frame) => frame.type === 'agent_synced' && frame.payload?.agent?.id === agent.id && frame.payload.agent.project?.branch === 'feature',
      45_000, 'the agent\'s frame with the branch it moved to while the edge host was gone')
    expect((await row(client, agent.id))?.project?.branch).toBe('feature')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })
})
