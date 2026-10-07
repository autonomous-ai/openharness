/**
 * `harness start`, `stop` and `status` as people run them: from the INSTALLED bundle, the
 * `~/.harness/cli/cli.js` the installer lays down, run on the managed Node it records, under a
 * throwaway home with its own data folder, port and private tmux server.
 *
 * Every other end-to-end file boots the master itself; these are the commands that start and stop it,
 * which `harness service install` changes (lib/platformDaemon.ts). Without the service nothing may
 * change and no platform may be asked; with it, start and stop go through launchd or systemd; and a
 * definition written for another data folder is not this daemon's.
 *
 * launchctl, systemctl and loginctl are fakes (harness/fakePlatform.mjs), first on PATH: they record
 * every call and fail loudly where none may be made, and where the platform is allowed they run the
 * master from the definition, as launchd and systemd would. The real ones are never run. Both
 * definitions run on any computer: HARNESSD_TEST_PLATFORM picks the one `harness service` uses.
 */
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { LAUNCHD_LABEL, SYSTEMD_UNIT, launchdPlist, systemdUnit } from '../src/harnessd/platform.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

type Platform = 'launchd' | 'systemd'
const uid = process.getuid!()

interface Machine {
  /** The throwaway machine: its environment, port, private tmux and fake engines. Never started
   *  itself: `harness start` starts the daemon here. */
  daemon: IsolatedDaemon
  /** The installed bundle, and the managed Node it runs on. */
  cli: string
  node: string
  /** What every `harness` command here runs with. */
  env: NodeJS.ProcessEnv
  /** The fake platform tools' folder. */
  fakes: string
  /** The platform `harness service` uses here, and where it writes the definition. */
  platform: Platform
  definition: string
}

let bundleDir: string | null = null
let bundle = ''
beforeAll(() => {
  // The run's bundle when there is one (E2E_BUNDLE=1), else one built for this file, as it ships.
  if (process.env.E2E_BUNDLE_PATH) { bundle = process.env.E2E_BUNDLE_PATH; return }
  bundleDir = mkdtempSync(join(tmpdir(), 'harness-cli-e2e-'))
  execFileSync(process.execPath, ['build-bundle.mjs'], { cwd: CLI_ROOT, env: { ...process.env, BUNDLE_OUT_DIR: bundleDir }, stdio: 'pipe' })
  bundle = join(bundleDir, 'cli.js')
}, 180_000)
afterAll(() => { if (bundleDir) rmSync(bundleDir, { recursive: true, force: true }) })

const alive = (pid: number | null | undefined): boolean => IsolatedDaemon.alive(pid ?? null)
const pidOf = (m: Machine): number | null => {
  try { return Number(readFileSync(join(m.daemon.dataDir, 'adapter.pid'), 'utf8').trim()) || null } catch { return null }
}
const calls = (m: Machine): string[][] => {
  const file = join(m.fakes, 'calls.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]) : []
}
const platformPid = (m: Machine): number | null => {
  const file = join(m.fakes, 'state.json')
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { pid: number | null }).pid : null
}
const allow = (m: Machine, mode: 'forbidden' | 'platform') =>
  writeFileSync(join(m.fakes, 'config.json'), JSON.stringify({ mode, baseEnv: m.env }))

/** Run `harness <args>` the way a terminal does: the managed Node on the installed bundle. */
function harness(m: Machine, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(m.node, [m.cli, ...args], { cwd: m.daemon.root, env: m.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}
const said = (run: { stdout: string; stderr: string }) => `${run.stdout}\n${run.stderr}`

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)
async function create(m: Machine, client: LocalClient, folder: string): Promise<Record<string, any>> {
  const cwd = join(m.daemon.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  return until(`${folder} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
}
const back = (client: LocalClient, agent: Record<string, any>) =>
  until(`${agent.id.slice(0, 8)} to be back`, async () => {
    const now = await row(client, agent.id)
    return now?.status === 'active' && now.sessionId === agent.sessionId ? now : null
  }, 60_000, 500)
const panes = (m: Machine) => m.daemon.tmux.run('list-panes', '-a', '-F', '#{pane_id} #{pane_pid}')
/** A process's command line, as ps prints it. */
const commandOf = (pid: number): string => execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The core a master starts on an installed bundle: from the core's entry in the lean bundle it carries,
 *  written out into the data folder. */
const leanCore = (m: Machine) => new RegExp(` ${escape(join(m.daemon.dataDir, 'lean'))}/[0-9a-f]{16}/harnessd-core\\.mjs __run$`)
const statusOf = async (m: Machine) => await (await fetch(`http://127.0.0.1:${m.daemon.port}/api/status`)).json() as Record<string, any>

describe('harness start, stop and status from the installed bundle', () => {
  let machine: Machine | undefined
  /** Every master and core a test saw, stopped at its end whatever happened. */
  const seen = new Set<number>()
  afterEach(async () => {
    const m = machine
    machine = undefined
    if (!m) return
    for (const pid of [pidOf(m), platformPid(m), ...seen]) if (pid) seen.add(pid)
    for (const pid of seen) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
    await until('every daemon process of the test to go', () => [...seen].every((pid) => !alive(pid)), 10_000).catch(() => {
      for (const pid of seen) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    })
    seen.clear()
    await m.daemon.close()
  })

  async function install(platform: Platform = process.platform === 'darwin' ? 'launchd' : 'systemd'): Promise<Machine> {
    const daemon = await IsolatedDaemon.create()
    const home = daemon.env.HOME!
    // The bundle where the installer puts it, beside its hook script.
    const cliDir = join(home, '.harness', 'cli')
    mkdirSync(cliDir, { recursive: true })
    const cli = join(cliDir, 'cli.js')
    copyFileSync(bundle, cli)
    copyFileSync(join(dirname(bundle), 'notify.mjs'), join(cliDir, 'notify.mjs'))
    // The managed Node as the installer records it: a runtime folder, and current-node naming its binary.
    const runtime = daemon.env.ADAPTER_RUNTIME_DIR!
    const node = join(runtime, 'node-e2e', 'bin', 'node')
    mkdirSync(dirname(node), { recursive: true })
    symlinkSync(process.execPath, node)
    writeFileSync(join(runtime, 'current-node'), `${node}\n`)
    const fakes = join(daemon.root, 'platform-bin')
    mkdirSync(fakes)
    const fake = pathToFileURL(join(CLI_ROOT, 'e2e', 'harness', 'fakePlatform.mjs')).href
    for (const name of ['launchctl', 'systemctl', 'loginctl']) {
      writeFileSync(join(fakes, name), `#!${process.execPath}\nimport(${JSON.stringify(fake)}).then((m) => m.run(${JSON.stringify(name)}))\n`, { mode: 0o755 })
    }
    const env: NodeJS.ProcessEnv = {
      ...daemon.env, PATH: `${fakes}:${daemon.env.PATH}`, XDG_CONFIG_HOME: join(home, '.config'), HARNESSD_TEST_PLATFORM: platform,
    }
    // The defaults, all under the throwaway home: never a folder of the person running the tests.
    for (const name of ['ADAPTER_CLI_DIR', 'HARNESS_BIN_DIR', 'HARNESS_LOGS_DIR', 'HARNESS_ENV_FILE', 'DOTENV_CONFIG_PATH']) delete env[name]
    const definition = platform === 'launchd'
      ? join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
      : join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT)
    const m: Machine = { daemon, cli, node, env, fakes, platform, definition }
    allow(m, 'forbidden')
    machine = m
    onTestFailed(() => {
      const log = join(daemon.dataDir, 'harness.log')
      console.log(`---- platform calls\n${calls(m).map((call) => call.join(' ')).join('\n')}`)
      console.log(`---- daemon log\n${existsSync(log) ? readFileSync(log, 'utf8').split('\n').slice(-120).join('\n') : '(none)'}`)
    })
    return m
  }

  it('starts on an external Node reached through a managed-runtime symlink without relocating it', async () => {
    // Found by QA on a quiet machine: a Homebrew Node hard-linked under a daemon name aborted in dyld.
    // install() deliberately points this managed path at the external interpreter running the fixture.
    const m = await install()
    const started = await harness(m, 'start')
    expect(started.status, said(started)).toBe(0)
    seen.add(pidOf(m)!)
    expect((await fetch(`http://127.0.0.1:${m.daemon.port}/api/health`)).ok).toBe(true)
    expect(existsSync(join(dirname(dirname(m.node)), 'libexec', 'harnessd', 'harnessd'))).toBe(false)
    const stopped = await harness(m, 'stop')
    expect(stopped.status, said(stopped)).toBe(0)
  })

  it('without the service: start runs a master and core, an agent outlives stop in tmux and is back on the next start, and no platform is asked', async () => {
    const m = await install()
    const started = await harness(m, 'start')
    expect(started.status, said(started)).toBe(0)
    expect(started.stdout).toContain('● started · this computer only (not signed in)')
    const master = pidOf(m)!
    expect(alive(master)).toBe(true)
    expect((await fetch(`http://127.0.0.1:${m.daemon.port}/api/health`)).ok).toBe(true)
    const status = await statusOf(m)
    expect(status.pid).toBe(master)
    const core = status.corePid as number
    expect(core).not.toBe(master)
    seen.add(master).add(core)
    // harnessd's master (it retitles itself), running the installed bundle's core: from the lean bundle that
    // bundle carries, written out into the data folder (src/harnessd/leanBundle.ts).
    expect(commandOf(master)).toBe('harnessd')
    expect(commandOf(core)).toMatch(leanCore(m))

    const running = await harness(m, 'status')
    expect(running.stdout).toMatch(/status +● running · this computer only \(not signed in\)/)
    expect(running.stdout).toMatch(new RegExp(`pid +${master}\\n`))
    expect(running.stdout).not.toContain('supervisor')

    // An agent made through the local socket, as the desktop app makes one.
    let client = await LocalClient.connect(m.daemon)
    const agent = await create(m, client, 'outlives-stop')
    client.close()
    const before = await panes(m)

    const stopped = await harness(m, 'stop')
    expect(stopped.stdout, said(stopped)).toContain(`machine stopped (pid ${master})`)
    await until('the master and its core to go', () => !alive(master) && !alive(core), 10_000)
    expect(pidOf(m)).toBeNull()
    expect(await panes(m), 'the agent lives on in tmux').toBe(before)
    expect((await harness(m, 'status')).stdout).toMatch(/status +○ stopped/)

    const again = await harness(m, 'start')
    expect(again.status, said(again)).toBe(0)
    seen.add(pidOf(m)!)
    client = await LocalClient.connect(m.daemon)
    await back(client, agent)
    client.close()
    expect(await panes(m)).toBe(before)
    expect((await harness(m, 'stop')).status).toBe(0)
    expect(calls(m), 'no platform tool was asked anything').toEqual([])
  })

  it.each(['launchd', 'systemd'] as const)('with the service installed for this data folder: start and stop go through %s, and status names it', async (platform) => {
    const m = await install(platform)
    allow(m, 'platform')
    const installed = await harness(m, 'service', 'install')
    expect(installed.status, said(installed)).toBe(0)
    expect(installed.stdout).toContain(`✓ harnessd runs under ${platform} (pid ${pidOf(m)})`)
    const first = pidOf(m)!
    seen.add(first)
    expect(platformPid(m), `${platform} runs the master`).toBe(first)
    expect(commandOf(first)).toBe('harnessd')
    const firstCore = (await statusOf(m)).corePid as number
    seen.add(firstCore)
    expect(commandOf(firstCore)).toMatch(leanCore(m))
    const definition = readFileSync(m.definition, 'utf8')
    expect(definition).toContain(m.node)
    expect(definition).toContain(m.cli)
    expect(definition).toContain(join(m.daemon.dataDir, 'harness.log'))

    const status = await harness(m, 'status')
    expect(status.stdout).toMatch(new RegExp(`supervisor +${platform} · starts at login, comes back if it dies`))
    expect(status.stdout).toMatch(new RegExp(`pid +${first}\\n`))

    let client = await LocalClient.connect(m.daemon)
    const agent = await create(m, client, 'under-the-platform')
    client.close()
    const before = await panes(m)

    let from = calls(m).length
    const stopped = await harness(m, 'stop')
    expect(stopped.stdout, said(stopped)).toContain(`machine stopped (pid ${first})`)
    expect(calls(m).slice(from)).toContainEqual(platform === 'launchd'
      ? ['launchctl', 'bootout', `gui/${uid}/${LAUNCHD_LABEL}`]
      : ['systemctl', '--user', 'kill', '--kill-who=main', '--signal=SIGTERM', SYSTEMD_UNIT])
    await until('the master to go', () => !alive(first), 10_000)
    expect(await panes(m), 'the agent lives on in tmux').toBe(before)
    expect((await harness(m, 'status')).stdout).toMatch(/status +○ stopped/)

    from = calls(m).length
    const again = await harness(m, 'start')
    expect(again.status, said(again)).toBe(0)
    expect(again.stdout).toMatch(new RegExp(`supervisor +${platform}`))
    expect(calls(m).slice(from)).toContainEqual(platform === 'launchd'
      ? ['launchctl', 'bootstrap', `gui/${uid}`, m.definition]
      : ['systemctl', '--user', 'start', SYSTEMD_UNIT])
    const second = pidOf(m)!
    seen.add(second)
    expect(second).not.toBe(first)
    expect(platformPid(m)).toBe(second)
    client = await LocalClient.connect(m.daemon)
    await back(client, agent)
    client.close()

    // Uninstalled, the daemon goes back to the usual way, and the platform is out of it.
    const removed = await harness(m, 'service', 'uninstall')
    expect(removed.status, said(removed)).toBe(0)
    expect(removed.stdout).toContain(`${platform} no longer runs harnessd`)
    expect(removed.stdout).toContain('starting it the usual way')
    expect(existsSync(m.definition)).toBe(false)
    const third = pidOf(m)!
    seen.add(third)
    expect(alive(second)).toBe(false)
    expect(third).not.toBe(second)
    allow(m, 'forbidden')
    from = calls(m).length
    expect((await harness(m, 'status')).stdout).not.toContain('supervisor')
    expect((await harness(m, 'stop')).stdout).toContain(`machine stopped (pid ${third})`)
    expect(calls(m).slice(from)).toEqual([])
    expect(await panes(m)).toBe(before)
  })

  it.each(['launchd', 'systemd'] as const)('ignores a %s definition written for another data folder', async (platform) => {
    const m = await install(platform)
    const other = join(m.daemon.root, 'other-data')
    const def = { nodePath: m.node, scriptPath: m.cli, logFile: join(other, 'harness.log'), home: m.env.HOME!, env: { ADAPTER_DATA_DIR: other } }
    mkdirSync(dirname(m.definition), { recursive: true })
    writeFileSync(m.definition, platform === 'launchd' ? launchdPlist(def) : systemdUnit(def))

    const started = await harness(m, 'start')
    expect(started.status, said(started)).toBe(0)
    expect(started.stdout).not.toContain('supervisor')
    const master = pidOf(m)!
    seen.add(master)
    expect((await harness(m, 'status')).stdout).not.toContain('supervisor')
    expect((await harness(m, 'stop')).stdout).toContain(`machine stopped (pid ${master})`)
    expect(calls(m), 'no platform tool was asked anything').toEqual([])
    expect(readFileSync(m.definition, 'utf8'), 'and the other folder\'s definition is left as it was').toContain(other)
  })
})
