/**
 * A daemon under test takes nothing of the developer's and outlives nothing of the run's.
 *
 * On 2026-11-11 two daemons from an end-to-end run 1.5 days earlier were still running on a developer's Mac. The run's Vitest
 * had been killed, so no afterEach closed them, and their masters, parented to launchd, ran on. One held 51793, the real
 * daemon's bridge port, which no daemon under test asked a port of its own for; the other ran `lsof` every 5.5 s asking who
 * held it, about 7% of a core around the clock.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ownProcessGroup } from '../src/lib/windows/noWindow.js'
import { workingFolders } from '../src/testing/rootProcesses.js'
import { alive, processTable } from '../src/testing/spawnedRuns.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { hungRateLimitRead, writeHungCodex } from './harness/hungCodex.js'

interface Started { root: string; master: number; core: number; socket: string; escaped: number[]; left: number; readOnly: string }

/** The master [pid] and the service processes it runs (`harnessd-<process>`): the short-lived probes they start
 *  (`lsof`, `ps`) are left out, as their pids can go to strangers while the test waits. */
const daemonProcesses = (pid: number): number[] => [pid, ...processTable()
  .filter((row) => row.ppid === pid && /^harnessd-/.test(row.command)).map((row) => row.pid)]

const tmuxServer = (socket: string): number | null => {
  try { return Number(execFileSync('tmux', ['-S', socket, 'display-message', '-p', '#{pid}'], { encoding: 'utf8', timeout: 5_000 }).trim()) || null } catch { return null }
}

describe('a daemon under test', () => {
  let daemon: IsolatedDaemon | undefined
  let worker: ChildProcess | undefined
  let started: Started | undefined
  let watched: number[] = []
  afterEach(async () => {
    await daemon?.close()
    daemon = undefined
    // What a failing run left: this test's own processes, ended here so the run leaves nothing either.
    if (worker?.pid && alive(worker.pid)) { try { process.kill(-worker.pid, 'SIGKILL') } catch { /* gone */ } }
    for (const pid of watched) if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    if (started) {
      if (alive(started.left)) { try { process.kill(started.left, 'SIGKILL') } catch { /* gone */ } }
      try { execFileSync('tmux', ['-S', started.socket, 'kill-server'], { stdio: 'ignore', timeout: 5_000 }) } catch { /* gone */ }
      try { chmodSync(started.readOnly, 0o755) } catch { /* gone */ }
      rmSync(started.root, { recursive: true, force: true })
    }
    worker = undefined
    started = undefined
    watched = []
  })

  it('gives its bridge a port of its own, never the developer\'s daemon\'s 51793', async () => {
    daemon = await IsolatedDaemon.create()
    expect(daemon.env.HARNESS_CONNECTIONS_PORT).toBe('0')
    // A test's own port still stands.
    expect((await IsolatedDaemon.create({ env: { HARNESS_CONNECTIONS_PORT: '4321' } }).then(async (other) => {
      await other.close()
      return other.env.HARNESS_CONNECTIONS_PORT
    }))).toBe('4321')
  })

  // Removed roots on one Mac each kept a 19 MB runtime/grid-* (2026-11-14). What can still ask, in models' process
  // (`harnessd-models`): a managed grid following its pin on every start, and grid's set-up on a grid feature's first
  // use (the picker's Set up, a Get, a Use): installCli reads the managed grid's manifest, then runs grid's public
  // installer when there is still no `grid`.
  it('asks no grid manifest and runs no grid installer beyond the machine', async () => {
    daemon = await IsolatedDaemon.create()
    expect(daemon.env.ADAPTER_GRID_RUNTIME_METADATA_URL).toBe('http://127.0.0.1:9/grid.json')
    expect(daemon.env.DISABLE_GRID_INSTALL).toBe('true')
    // Nor the developer's grid login, control plane or grid: the Set up below would name their grid and ask its models.
    expect(daemon.env.GRID_HOME).toBe(join(daemon.root, 'home', '.grid'))
    expect(daemon.env.GRID_CONTROL_PLANE_URL).toBe('http://127.0.0.1:9')
    expect(daemon.env.HARNESS_GRID_BIN).toBe('')
    // A test's own still stands (update.e2e.ts, harness/fleet.ts, serviceProcesses.e2e.ts). Never started: it only
    // shows whose word wins.
    const own = await IsolatedDaemon.create({ env: { ADAPTER_GRID_RUNTIME_METADATA_URL: 'http://127.0.0.1:1/own.json', DISABLE_GRID_INSTALL: 'false',
      HARNESS_GRID_BIN: '/own/grid' } })
    await own.close()
    expect(own.env.ADAPTER_GRID_RUNTIME_METADATA_URL).toBe('http://127.0.0.1:1/own.json')
    expect(own.env.DISABLE_GRID_INSTALL).toBe('false')
    expect(own.env.HARNESS_GRID_BIN).toBe('/own/grid')
    await daemon.start()
    const client = await LocalClient.connect(daemon)
    // The picker's Set up, signed out: answered once grid's set-up gave up, at 'no-cli' without a `grid` on PATH, or at
    // the grid name a signed-out daemon is never given with one. installCli runs before either (lib/gridAttach.ts): the
    // manifest is asked and, with no `grid`, grid's installer.
    expect(await client.request('grid_fleet_models_list', { setup: true }, 60_000)).toMatchObject({ gridSetupError: expect.stringMatching(/\S/) })
    client.close()
    // Models' own lines reach the log the asserts below read.
    expect(daemon.log()).toContain('[grid-attach] ')
    expect(daemon.log()).not.toContain('installing the Harness grid runtime')
    expect(daemon.log()).not.toMatch(/grid installer (exited|finished)|installed `grid` to/)
    expect(readdirSync(daemon.env.ADAPTER_RUNTIME_DIR!).filter((name) => name.startsWith('grid-'))).toEqual([])
    // Where grid's installer would put it: under the test's home (lib/gridInstall.ts GRID_INSTALL_DIR).
    expect(existsSync(join(daemon.env.HOME!, '.local', 'bin', 'grid'))).toBe(false)
  })

  it('ends what left its process groups: a Codex rate-limit read cut by the close', async () => {
    const d = daemon = await IsolatedDaemon.create()
    writeHungCodex(d)
    await d.start()
    const group = await hungRateLimitRead(d)
    watched = group.map((row) => row.pid)
    // Its child names nothing of the root: only its group reaches it.
    expect(group.filter((row) => !row.command.includes(`${d.root}/`))).toHaveLength(1)
    await d.close()
    daemon = undefined
    expect(watched.filter(alive), 'the read\'s Codex and its child').toEqual([])
    expect(processTable().filter((row) => row.command.includes(`${d.root}/`)).map((row) => row.command)).toEqual([])
    expect(existsSync(d.root)).toBe(false)
  })

  it('leaves a shared root to the daemon that owns it, and ends alone a process of the test\'s own that names it', async () => {
    const owner = daemon = await IsolatedDaemon.create()
    // In this worker's own process group, as a test's `tmux -S <root>/…` call is.
    const named = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', join(owner.root, 'named')], { stdio: 'ignore' })
    watched = [named.pid!]
    await (await IsolatedDaemon.create({ beside: owner })).close()
    expect(alive(named.pid!), 'after the close of the daemon beside it').toBe(true)
    await owner.close()
    daemon = undefined
    // Ended, and this worker, in the same group, is still here to say so.
    expect(alive(named.pid!), 'after its owner\'s close').toBe(false)
  })

  // What was found on a developer's Mac (audit of 2026-11-15): real engines left by hand in a tile, parented to pid 1,
  // their command lines naming nothing of the root and their working folders inside it: `claude` most of them, 5
  // `opencode` and 4 `cursor-agent` beside them. A `sleep` stands in for the first, and a script of the test's own
  // for each of the other two.
  it('ends what a tile left running in its folder, though its command line names nothing of the root', async () => {
    const d = daemon = await IsolatedDaemon.create()
    await d.start()
    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'left')
    mkdirSync(cwd, { recursive: true })
    const opened = await client.request('agent_create', { engine: 'terminal', cwd }, 60_000)
    expect(opened.error, JSON.stringify(opened)).toBeUndefined()
    const pane = await until('the terminal tile to be up', async () => {
      const { agents } = await client.request<{ agents: Array<{ id: string; status: string; tmuxPane?: string }> }>('agents_list', { includeStopped: true }, 30_000)
      const now = agents.find((agent) => agent.id === opened.agent.id)
      return now?.status === 'active' && now.tmuxPane ? now.tmuxPane : null
    }, 60_000, 250)
    client.close()
    /** What [line], typed into the tile, wrote into [file], moved into place whatever the line returned. */
    const typed = async (line: string, file: string): Promise<string> => {
      await d.tmux.run('send-keys', '-t', pane, '-l', `${line} > ${file}.tmp; mv ${file}.tmp ${file}`)
      await d.tmux.run('send-keys', '-t', pane, 'Enter')
      // Boxed: an empty answer is an answer too (`whence -p` of names it cannot find), and `until` waits for a truthy one.
      return (await until(`the tile to write ${file}`, () => existsSync(file) ? { text: readFileSync(file, 'utf8') } : null, 30_000, 100)).text
    }
    // Deaf to the hangup its pane's end sends, and in a process group of its own: as an engine left running is.
    const left = [Number(await typed('nohup sleep 600 >/dev/null 2>&1 & echo $!', join(d.root, 'left.pid')))]
    watched = [...left]
    // The other engines: stand-ins in the daemon's own bin, each deaf to the hangup, saying its pid and then a `sleep`.
    const bin = join(d.root, 'bin'), others = ['opencode', 'cursor-agent']
    for (const name of others) {
      const said = join(d.root, `${name}.pid`)
      writeFileSync(join(bin, name), `#!/bin/sh\ntrap '' HUP\necho $$ > ${said}.tmp && mv ${said}.tmp ${said}\nexec sleep 600\n`, { mode: 0o755 })
    }
    // Asked before typed: a name that is not the stand-in's file is never run. On a developer's Mac it could be theirs.
    expect(await typed(`whence -p ${others.join(' ')}`, join(d.root, 'resolved'))).toBe(others.map((name) => `${join(bin, name)}\n`).join(''))
    for (const name of others) {
      await d.tmux.run('send-keys', '-t', pane, '-l', `${name} &`)
      await d.tmux.run('send-keys', '-t', pane, 'Enter')
      left.push(await until(`the ${name} stand-in to say its pid`, () => existsSync(join(d.root, `${name}.pid`)) ? Number(readFileSync(join(d.root, `${name}.pid`), 'utf8')) : null, 30_000, 100))
      watched = [...left]
    }
    await until('all three to be a sleep', () => processTable().filter((row) => left.includes(row.pid) && row.command === 'sleep 600').length === 3 || null, 10_000, 100)
    await d.close()
    daemon = undefined
    expect(left.filter(alive), 'what the tile left').toEqual([])
    const table = processTable(), folders = workingFolders(table)
    const inRoot = (pid: number) => { const folder = folders.get(pid); return folder === d.root || folder?.startsWith(`${d.root}/`) }
    expect(table.filter((row) => row.command.includes(`${d.root}/`) || inRoot(row.pid)).map((row) => row.command)).toEqual([])
  })

  it.each<[string, 'exits' | 'waits', (child: ChildProcess) => void]>([
    ['exits without closing it', 'exits', (child) => { child.stdin!.write('go\n') }],
    ['is killed, as a run\'s timeout kills it', 'waits', (child) => { child.kill('SIGKILL') }],
    ['is interrupted with Ctrl-C, which reaches its terminal\'s process group', 'waits', (child) => { process.kill(-child.pid!, 'SIGINT') }],
  ])('is gone, tmux server and all, once the worker that started it %s', async (_, mode, end) => {
    // Not a Vitest run: it keeps no artifacts, which only a test can file.
    const { E2E_ARTIFACTS_DIR: _artifacts, ...env } = process.env
    // A process group of its own, as a terminal gives the run it starts.
    const child = worker = spawn(process.execPath, ['--import', 'tsx', 'e2e/harness/abandonedWorker.ts', mode], {
      cwd: CLI_ROOT, env, stdio: ['pipe', 'pipe', 'inherit'], ...ownProcessGroup(),
    })
    let out = ''
    child.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString() })
    started = await until('the worker\'s daemon', () => out.includes('\n') ? JSON.parse(out.split('\n')[0]) as Started : null, 120_000, 100)
    const tmux = tmuxServer(started.socket)
    expect(tmux, 'the daemon\'s tmux server').not.toBeNull()
    expect(started.escaped, 'the hung read\'s Codex, its watcher and its child').toHaveLength(3)
    watched = [...new Set([...daemonProcesses(started.master), started.core, tmux!, ...started.escaped])]
    expect(watched.length, 'master, core, edge and tmux at the least').toBeGreaterThanOrEqual(4)
    end(child)
    await until('every process of the daemon to be gone', () => watched.every((pid) => !alive(pid)) || null, 40_000, 100)
    // And its throwaway root.
    await until('the daemon\'s root to be removed', () => !existsSync(started!.root) || null, 10_000, 100)
    // And what its pane left in the root's folders, which no process group and no command line reaches.
    expect(alive(started.left), 'what the worker\'s pane left').toBe(false)
  }, 240_000)
})
