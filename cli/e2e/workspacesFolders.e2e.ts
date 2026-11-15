/**
 * The git a create and a purge take runs in the workspaces service, in the edge host, never in the core: a clone ran
 * git, ssh and their helpers as children of the core, the most trusted process (the audit of 2026-11-12, security 5).
 * On the real daemon, with `git`, `ssh` and `du` on its PATH as shims that write down who started them, a worktree, a
 * clone and a branch made for a create, and a worktree reviewed and removed for a purge, are each the edge host's
 * children and none is the core's. What happens to the edge host costs workspaces alone: gone, a create that needs git
 * waits for it (held) and a delete reviewed before is refused with the harness running; hung, a create in flight fails
 * in words; parked, a purge offers only what needs no git. The core never restarts, and agents keep working.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

/** Git as the test runs it: the real one, in the daemon's throwaway home, never this machine's configuration. */
const git = (d: IsolatedDaemon, cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { env: { ...process.env, HOME: d.env.HOME, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' }).trim()

/** A repository with one commit on `main`, in the daemon's projects folder. */
function repository(d: IsolatedDaemon, name: string): string {
  const dir = join(d.projectsDir, name)
  mkdirSync(dir, { recursive: true })
  git(d, dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), `${name}\n`)
  git(d, dir, 'add', '.')
  git(d, dir, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '-m', 'start')
  return dir
}

/** GitHub as this test's own folder: `https://github.com/e2e/<name>.git` clones the bare copy of [source] here, through
 *  the home's git configuration, so a clone needs no network. */
function github(d: IsolatedDaemon, source: string, name: string): string {
  const remote = join(d.root, 'github')
  mkdirSync(remote, { recursive: true })
  execFileSync('git', ['clone', '-q', '--bare', source, join(remote, `${name}.git`)], { env: { ...process.env, HOME: d.env.HOME, GIT_CONFIG_NOSYSTEM: '1' } })
  writeFileSync(join(d.env.HOME!, '.gitconfig'), `[url "file://${remote}/"]\n\tinsteadOf = https://github.com/e2e/\n`)
  return `https://github.com/e2e/${name}.git`
}

/** `git`, `ssh` and `du` on the daemon's PATH write who started them (`$PPID`) and what they were asked to [log], in one
 *  line each, then run the real one. */
function shims(d: IsolatedDaemon, log: string): void {
  for (const name of ['git', 'ssh', 'du']) {
    const real = execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim()
    writeFileSync(join(d.root, 'bin', name),
      `#!/bin/sh\nline="$PPID ${name}"\nfor a in "$@"; do line="$line $a"; done\nprintf '%s\\n' "$line" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 })
  }
}

/** Each child the shims saw: who started it, and what it was: git's subcommand (a worktree's and a remote's with theirs),
 *  or `du` and `ssh`. */
function children(log: string): Array<{ pid: number; verb: string }> {
  const text = existsSync(log) ? readFileSync(log, 'utf8') : ''
  return text.split('\n').filter(Boolean).map((line) => {
    const [pid, name, ...args] = line.split(' ')
    if (name !== 'git') return { pid: Number(pid), verb: name! }
    let at = 0
    while (at < args.length && args[at]!.startsWith('-')) at += args[at] === '-C' || args[at] === '-c' ? 2 : 1
    const verb = args[at] ?? '', next = args[at + 1] ?? ''
    return { pid: Number(pid), verb: verb === 'worktree' || verb === 'remote' ? `${verb} ${next}`
      : verb === 'config' && !args.slice(at + 1).some((arg) => arg.startsWith('--get')) ? 'config (write)' : verb }
  })
}
/** What a create's folder or a purge's worktree takes, and a frame's reads never do. */
const GIT_WORK = new Set(['clone', 'worktree add', 'worktree remove', 'worktree unlock', 'switch', 'checkout', 'branch', 'remote get-url', 'config (write)', 'du', 'ssh'])
/** How many of each [verb] [pid] started, for the record. */
const counted = (seen: Array<{ pid: number; verb: string }>, pid: number) =>
  Object.fromEntries([...new Set(seen.filter((child) => child.pid === pid).map((child) => child.verb))].sort()
    .map((verb) => [verb, seen.filter((child) => child.pid === pid && child.verb === verb).length]))

/** The edge host the master runs now: the last one it said it started. Read from its log, never from the process table,
 *  where another daemon's services could be. */
const edgePid = (d: IsolatedDaemon): number | null => {
  const started = [...d.log().matchAll(/\[harnessd\] service edge started \(pid (\d+)\)/g)]
  return started.length ? Number(started[started.length - 1][1]) : null
}
const connected = (d: IsolatedDaemon) => d.log().split('[services] workspaces connected').length - 1
const restarts = (d: IsolatedDaemon) => [...d.log().matchAll(/\[harnessd\] service edge started .* restart \d+/g)].length

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)
/** A saved create's outcome, once it is no longer pending. */
const finished = (client: LocalClient, creationId: string): Promise<Record<string, any>> => until(`${creationId} to finish`, async () => {
  const status = await client.request('agent_create_status', { creationId }, 30_000)
  return status.state !== 'pending' ? status : null
}, 120_000, 250)
/** A create as New Harness asks it, with the folder [source] names, answered once it is no longer pending. */
async function create(client: LocalClient, creationId: string, source: Record<string, unknown>): Promise<Record<string, any>> {
  const created = await client.request('agent_create', { engine: 'claude', creationId, bypassPermission: true, ...source }, 90_000)
  return created.state !== 'pending' ? created : finished(client, creationId)
}
/** Whether [path] is inside [folder], however either is spelled (macOS's /tmp is /private/tmp). */
const inside = (folder: string, path: string) => realpathSync(path).startsWith(realpathSync(folder) + '/')
const same = (a: string, b: string) => realpathSync(a) === realpathSync(b)
/** The created agent, once it runs in its folder with its conversation bound. */
async function bound(client: LocalClient, created: Record<string, any>): Promise<Record<string, any>> {
  expect(created, JSON.stringify(created)).toMatchObject({ state: 'created' })
  return until(`${created.agent.id} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' && agent.tmuxPane ? agent : null
  }, 60_000, 250)
}
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const ended = client.next((frame: Frame) => frame.type === 'turn_ended' && frame.agentId === agentId, 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  await ended
}
const identity = (agent: Record<string, any>) => ({ agentId: agent.id, sessionId: agent.sessionId, createdAt: Date.parse(agent.createdAt) })

describe('the folders git makes for a create, and a purge\'s worktree, in the workspaces service', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async (env: Record<string, string> = {}, before: (d: IsolatedDaemon) => void = () => {}) => {
    const d = await IsolatedDaemon.create({ env: { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000', ...env } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    before(d)
    await d.start()
    return d
  }

  it('a worktree, a clone and a branch are made, and a worktree is reviewed and removed, by the edge host\'s git and none of the core\'s', async () => {
    const log = join('/tmp', `workspaces-folders-${process.pid}-${Date.now()}.log`)
    const d = await fresh({}, (d) => shims(d, log))
    await until('workspaces to connect to the core', () => connected(d) >= 1 || null, 30_000, 100)
    const client = await LocalClient.connect(d)
    const alpha = repository(d, 'alpha'), gamma = repository(d, 'gamma')
    const address = github(d, repository(d, 'beta-source'), 'beta')
    const home = d.env.HOME!

    // A worktree of alpha where Harness keeps them, on a branch made up for it.
    const tree = await bound(client, await create(client, 'folders-worktree-0001', { projectSource: 'worktree', gitSource: alpha, branchRef: 'refs/heads/main' }))
    expect(inside(join(home, 'harnesses', 'worktrees', 'alpha'), tree.cwd), tree.cwd).toBe(true)
    expect(same(git(d, tree.cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'), join(alpha, '.git'))).toBe(true)
    // A clone, into the projects folder under the repository's own name.
    const clone = await bound(client, await create(client, 'folders-clone-000001', { projectSource: 'remote', repositoryUrl: address }))
    expect(same(clone.cwd, join(home, 'harnesses', 'beta')), clone.cwd).toBe(true)
    expect(readFileSync(join(clone.cwd, 'README.md'), 'utf8')).toBe('beta-source\n')
    expect(git(d, clone.cwd, 'config', 'remote.origin.fetch')).toBe('+refs/heads/*:refs/remotes/origin/*')
    // The folder itself, on a new branch.
    const branch = await bound(client, await create(client, 'folders-branch-00001', { projectSource: 'branch', gitSource: gamma, branchRef: 'refs/heads/feature', branchName: 'feature' }))
    expect(same(branch.cwd, gamma), branch.cwd).toBe(true)
    expect(git(d, gamma, 'branch', '--show-current')).toBe('feature')

    // Inspect says where the worktree's harness works; Delete reviews it and removes it with the conversation.
    expect(await client.request('agent_worktree_delete', { ...identity(tree), mode: 'describe' }, 60_000))
      .toMatchObject({ workspace: { kind: 'worktree', canDelete: true, mainPath: realpathSync(alpha) } })
    const review = await client.request('agent_purge', { ...identity(tree), mode: 'inspect', includeWorktree: true }, 60_000)
    expect(review, JSON.stringify(review)).toMatchObject({ choices: { sessionData: { available: true }, worktreeData: { available: true, path: realpathSync(tree.cwd) } } })
    const reviewed = review.choices.worktreeData.path as string
    const madeUp = git(d, tree.cwd, 'branch', '--show-current')
    const deleted = await client.request('agent_purge', { ...identity(tree), mode: 'delete', reviewId: review.reviewId,
      choices: { sessionData: true, worktreeData: true }, path: reviewed }, 90_000)
    expect(deleted, JSON.stringify(deleted)).toMatchObject({ deleted: true, worktreeDeleted: true, sessionDeleted: true, branchKept: true })
    expect(existsSync(tree.cwd)).toBe(false)
    expect(git(d, alpha, 'branch', '--list', madeUp)).toContain(madeUp)

    const core = d.corePid()!, edge = edgePid(d)!
    const seen = children(log)
    console.log(`[git children] ${JSON.stringify({ core: counted(seen, core), edge: counted(seen, edge) })}`)
    expect(seen.filter((child) => child.pid === core && GIT_WORK.has(child.verb)).map((child) => child.verb)).toEqual([])
    // The shims saw the work, so a git of the core's would have been seen too.
    for (const verb of ['clone', 'worktree add', 'switch', 'du', 'worktree remove']) {
      expect(seen.some((child) => child.pid === edge && child.verb === verb), `${verb} in the edge host`).toBe(true)
    }
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('the edge host gone, a create that needs git waits for it held, a reviewed delete is refused before the stop, and agents work', async () => {
    const d = await fresh({ HARNESSD_SERVICES: 'workspaces', HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '15000', HARNESSD_SERVICE_MAX_BACKOFF_MS: '15000' })
    await until('workspaces to connect to the core', () => connected(d) >= 1 || null, 30_000, 100)
    const client = await LocalClient.connect(d)
    const alpha = repository(d, 'alpha')
    const tree = await bound(client, await create(client, 'gone-worktree-000001', { projectSource: 'worktree', gitSource: alpha, branchRef: 'refs/heads/main' }))
    const review = await client.request('agent_worktree_delete', { ...identity(tree), mode: 'inspect' }, 60_000)
    expect(review, JSON.stringify(review)).toMatchObject({ worktree: { path: realpathSync(tree.cwd) } })

    process.kill(edgePid(d)!, 'SIGKILL')
    await until('the core to see workspaces go', () => d.log().includes('[services] workspaces disconnected') || null, 30_000, 100)
    // Reviewed while they were up: refused before anything changes, the harness running and its worktree kept.
    const refused = await client.request('agent_worktree_delete', { ...identity(tree), mode: 'delete', reviewId: review.reviewId, path: review.worktree.path }, 60_000)
    expect(refused).toMatchObject({ error: 'WORKTREE_DELETE_REFUSED', stopped: false, detail: expect.stringContaining('did not answer') })
    expect((await row(client, tree.id))?.status).toBe('active')
    expect(existsSync(tree.cwd)).toBe(true)
    // A create that needs git waits for workspaces, saved, and is no failure.
    const asked = await client.request('agent_create', { engine: 'claude', creationId: 'gone-worktree-000002', bypassPermission: true,
      projectSource: 'worktree', gitSource: alpha, branchRef: 'refs/heads/main' }, 90_000)
    expect(asked.state, JSON.stringify(asked)).toBe('pending')
    const held = await until('the create to wait for workspaces', async () => {
      const status = await client.request('agent_create_status', { creationId: 'gone-worktree-000002' }, 30_000)
      return status.held?.service === 'workspaces' ? status : null
    }, 30_000, 250)
    expect(held).toMatchObject({ state: 'pending', held: { service: 'workspaces', detail: expect.stringContaining('workspaces service') } })
    await turn(client, tree.id, 'the core never waits on workspaces')

    await until('workspaces to be back', () => restarts(d) >= 1 && connected(d) >= 2 || null, 60_000, 200)
    const later = await bound(client, await finished(client, 'gone-worktree-000002'))
    expect(inside(join(d.env.HOME!, 'harnesses', 'worktrees', 'alpha'), later.cwd), later.cwd).toBe(true)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('hung while it makes a folder, it is killed at the heartbeat watch: the create in flight fails in words, and the next is made', async () => {
    const d = await fresh({ HARNESSD_SERVICES: 'workspaces', HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '2000' })
    await until('workspaces to connect to the core', () => connected(d) >= 1 || null, 30_000, 100)
    const client = await LocalClient.connect(d)
    const alpha = repository(d, 'alpha')
    const hung = edgePid(d)!
    process.kill(hung, 'SIGSTOP')
    let failed: Record<string, any>
    try {
      failed = await create(client, 'hung-worktree-000001', { projectSource: 'worktree', gitSource: alpha, branchRef: 'refs/heads/main' })
    } finally { try { process.kill(hung, 'SIGCONT') } catch { /* killed by the master, as it should be */ } }
    expect(failed, JSON.stringify(failed)).toMatchObject({ state: 'failed', failure: { code: 'SERVICE_UNAVAILABLE', detail: expect.stringContaining('did not answer') } })
    await until('workspaces to be started again', () => restarts(d) >= 1 && connected(d) >= 2 || null, 60_000, 200)
    const made = await bound(client, await create(client, 'hung-worktree-000002', { projectSource: 'worktree', gitSource: alpha, branchRef: 'refs/heads/main' }))
    await turn(client, made.id, 'made once workspaces were back')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('parked, a purge offers only what needs no git, Inspect says the folder is unknown, a create waits, and agents work', async () => {
    let cwd = ''
    const d = await fresh({ HARNESSD_SERVICES: 'workspaces', HARNESSD_TEST_FAULTS: 'workspaces.crash', HARNESSD_SERVICE_PARK_CRASHES: '3' }, (d) => {
      const alpha = repository(d, 'alpha')
      cwd = join(d.env.HOME!, 'harnesses', 'worktrees', 'alpha', 'brave-otter')
      git(d, alpha, 'worktree', 'add', '-q', '-b', 'brave-otter', cwd)
    })
    await until('the master to park workspaces', () => d.log().includes('[harnessd] service edge ended 3 times') || null, 60_000, 250)
    const client = await LocalClient.connect(d)
    // A folder the person chose needs no git to start in.
    const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agent = await bound(client, { state: 'created', agent: created.agent })
    const review = await client.request('agent_purge', { ...identity(agent), mode: 'inspect', includeWorktree: true }, 60_000)
    expect(review, JSON.stringify(review)).toMatchObject({ choices: { sessionData: { available: true },
      worktreeData: { available: false, reason: expect.stringContaining('did not answer') } } })
    expect(await client.request('agent_worktree_delete', { ...identity(agent), mode: 'describe' }, 60_000))
      .toMatchObject({ workspace: { kind: 'unavailable', canDelete: false } })
    expect(await client.request('agent_worktree_delete', { ...identity(agent), mode: 'inspect' }, 60_000))
      .toMatchObject({ error: 'WORKTREE_DELETE_REFUSED', stopped: false })
    const asked = await client.request('agent_create', { engine: 'claude', creationId: 'parked-worktree-0001', bypassPermission: true,
      projectSource: 'worktree', gitSource: join(d.projectsDir, 'alpha'), branchRef: 'refs/heads/main' }, 90_000)
    expect(asked.state, JSON.stringify(asked)).toBe('pending')
    await until('the create to wait for workspaces', async () =>
      (await client.request('agent_create_status', { creationId: 'parked-worktree-0001' }, 30_000)).held?.service === 'workspaces' || null, 30_000, 250)
    await turn(client, agent.id, 'workspaces are parked and nothing else cares')
    expect(existsSync(cwd)).toBe(true)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })
})
