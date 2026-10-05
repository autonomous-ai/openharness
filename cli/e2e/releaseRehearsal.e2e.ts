/**
 * A release rehearsal: the update every installed machine gets when this checkout ships, from a published
 * release (`REHEARSE_FROM`, its cli.js with its notify.mjs beside it) to this checkout's bundle, through
 * the real updater path and a local manifest, from the state that release leaves on a person's machine:
 * its own data folder, and its hooks installed into the (throwaway) home, which the fake engines run as
 * Claude Code and Codex run theirs, as for every daemon under test (e2e/harness/fakeEngine.mjs).
 *
 * At the moment of the update a Claude Code and a Codex agent are mid-turn, a window is connected and a
 * terminal tile is open. After it: the same agents on the same conversations, their turns finished and
 * the next ones answered, the tile drawing again, the hooks the release installed reaching the new core,
 * and every process accounted for. Then `harness start` again (a reboot, the desktop app), which brings
 * this checkout's master up over the same agents.
 *
 * `REHEARSE_SIGNED_IN=1` signs the machine in to the fake backend first (e2e/harness/fakeBackend.ts), as
 * most machines are: the release connects as the machine's node, and so must the core after it.
 *
 * Opt-in, since it needs a released bundle (`curl` it from the release CDN, or build its tag):
 * `REHEARSE_FROM=<release>/cli.js npm run test:e2e -- releaseRehearsal`.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { TerminalBinaryKind } from '../src/lib/terminalBinary.js'
import { LocalClient, type Frame } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'

const FROM = process.env.REHEARSE_FROM
const SIGNED_IN = process.env.REHEARSE_SIGNED_IN === '1'
const TO = process.env.REHEARSE_TO
const MACHINE: FakeMachine = { machineId: 'b2'.repeat(16), computerId: 'e2e-computer-0000-0000-00000000000b', name: 'rehearsal', token: 'e2e-token-rehearsal' }
const NEXT = '0.99.0'
const SLOW = '!slow 20000'
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
type Row = Record<string, any>

describe.skipIf(!FROM)('a release rehearsal: the update from a published release to this checkout', () => {
  let scratch = ''
  let server: Server | undefined
  let backend: FakeBackend | undefined
  let daemon: IsolatedDaemon | undefined
  let offered: 'from' | 'next' = 'from'
  let fromVersion = ''
  let fromHasMaster = false
  const bundles = new Map<'from' | 'next', { cli: Buffer; notify: Buffer; version: string }>()
  const cliDir = () => join(scratch, 'cli')
  const status = async (): Promise<Row | null> =>
    fetch(`http://127.0.0.1:${daemon!.port}/api/status`).then((response) => response.json() as Promise<Row>).catch(() => null)
  const rows = async (client: LocalClient): Promise<Row[]> =>
    (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
  const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
  const turn = async (client: LocalClient, agentId: string, content: string) => {
    const started = client.next(isTurn('turn_started', agentId), 60_000, `turn_started (${content})`)
    const ended = client.next(isTurn('turn_ended', agentId), 60_000, `turn_ended (${content})`)
    client.send('message', { agentId, content })
    expect((await started).payload?.userMessage).toBe(content)
    await ended
  }
  /** Every process running a build from this install: the master, its core and its services. */
  const daemonProcesses = (): Array<{ pid: number; ppid: number; command: string }> =>
    execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => !!match && match[3].includes(join(cliDir(), 'cli.js')))
      .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }))
  /** The pids answering on the daemon's port: whatever runs it now, a successor nothing started for us included. */
  const listeners = (): number[] => {
    try {
      return execFileSync('lsof', ['-n', '-P', '-t', `-iTCP:${daemon!.port}`, '-sTCP:LISTEN']).toString().trim().split('\n').filter(Boolean).map(Number)
    } catch { return [] }
  }
  /** A terminal tile on the agent, as a window opens it; resolves with its first keyframe. */
  const openTile = async (client: LocalClient, agentId: string) => {
    const requestId = `tile-${Math.random().toString(36).slice(2)}`
    const since = client.binaries.length
    const answer = client.next((frame) => (frame.type === 'terminal_ready' || frame.type === 'terminal_error') && frame.payload?.requestId === requestId, 30_000, 'terminal_ready')
    client.send('terminal_open', { requestId, protocolVersion: 3, agentId, cols: 100, rows: 30 })
    const ready = await answer
    expect(ready.type, JSON.stringify(ready.payload)).toBe('terminal_ready')
    const streamId = ready.payload!.streamId as string
    await client.waitForBinary((frame) => frame.streamId === streamId && frame.kind === TerminalBinaryKind.keyframe, 30_000, 'the tile\'s keyframe', since)
    return streamId
  }
  /**
   * harnessd's processes as their master logs them (never by title: the master and its services rename
   * themselves): the master this test started, its latest core, and each service's latest process, alive.
   */
  const harnessdProcesses = (): Array<{ role: string; pid: number }> => {
    const text = logs()
    const alive = (pid: number) => IsolatedDaemon.alive(pid)
    const found: Array<{ role: string; pid: number }> = []
    if (daemon!.pid && alive(daemon!.pid) && !daemon!.options.noMaster) found.push({ role: 'master', pid: daemon!.pid })
    const cores = [...text.matchAll(/\[harnessd\] core started \(pid (\d+)\)/g)]
    const core = cores.length ? Number(cores[cores.length - 1][1]) : listeners()[0]
    if (core && alive(core)) found.push({ role: 'core', pid: core })
    const latest = new Map<string, number>()
    for (const match of text.matchAll(/\[harnessd\] service (\w+) started \(pid (\d+)\)/g)) latest.set(match[1], Number(match[2]))
    for (const [name, pid] of latest) if (alive(pid)) found.push({ role: `service ${name}`, pid })
    return found
  }
  /** What each of them holds in memory now (resident, MiB): `REHEARSAL_MEMORY=<file>` keeps it. */
  const memory = (when: string): Array<{ role: string; pid: number; mib: number }> => {
    const rows = harnessdProcesses().map((one) => ({ ...one, mib: Number(execFileSync('ps', ['-o', 'rss=', '-p', String(one.pid)], { encoding: 'utf8' }).trim() || 0) / 1024 }))
    const text = rows.map((row) => `${when}\t${row.role}\t${row.pid}\t${row.mib.toFixed(1)} MiB`).join('\n')
    if (process.env.REHEARSAL_MEMORY) writeFileSync(process.env.REHEARSAL_MEMORY, `${text}\n`, { flag: 'a' })
    return rows
  }
  /** A window on this machine: signed in, it is the account's machine it selects, not this computer. */
  const connect = (d: IsolatedDaemon) => LocalClient.connect(d, backend ? { machineId: MACHINE.machineId } : {})
  /** Everything the daemon has said: what the processes this test started printed, and the log file a
   *  successor the release spawned on its own writes to (`spawnDaemonChild`). */
  const logs = (): string => {
    let file = ''
    try { file = readFileSync(join(daemon!.dataDir, 'harness.log'), 'utf8') } catch { /* none yet */ }
    return `${daemon!.log()}\n${file}`
  }
  /** Session search answers, from wherever this build runs it (in the core, or in its own process), and
   *  finds the agent by what it was told. */
  const searchFinds = (client: LocalClient, agent: Row, words: string) => until(`search to find ${agent.engine}'s conversation`, async () => {
    const answer = await client.request('session_search', { query: words, limit: 20 }, 30_000)
    expect(answer.error, JSON.stringify(answer)).toBeUndefined()
    return JSON.stringify(answer).includes(agent.sessionId) || null
  }, 90_000, 1_000)
  const hookFiles = () => ({
    claude: join(daemon!.env.HOME!, '.claude', 'settings.json'),
    codex: join(daemon!.env.CODEX_HOME!, 'hooks.json'),
  })

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'harness-rehearsal-'))
    // `REHEARSE_TO` names another build to update to (a branch built at ${NEXT}), this checkout's otherwise.
    const out = TO ? dirname(TO) : join(scratch, 'build')
    if (!TO) execFileSync(process.execPath, ['build-bundle.mjs'], { cwd: CLI_ROOT, env: { ...process.env, ADAPTER_VERSION: NEXT, BUNDLE_OUT_DIR: out }, stdio: 'pipe' })
    expect(execFileSync(process.execPath, [join(out, 'cli.js'), 'version'], { encoding: 'utf8' }).trim()).toBe(NEXT)
    bundles.set('next', { cli: readFileSync(join(out, 'cli.js')), notify: readFileSync(join(out, 'notify.mjs')), version: NEXT })
    fromVersion = execFileSync(process.execPath, [FROM!, 'version'], { encoding: 'utf8' }).trim()
    const fromCli = readFileSync(FROM!)
    bundles.set('from', { cli: fromCli, notify: readFileSync(join(dirname(FROM!), 'notify.mjs')), version: fromVersion })
    // A release from before harnessd runs its core on its own (`harness start` spawned `__run`); one after
    // runs it under its master (`__harnessd`).
    fromHasMaster = fromCli.includes('__harnessd')

    server = createServer((request, response) => {
      const url = request.url ?? ''
      const origin = `http://127.0.0.1:${(server!.address() as { port: number }).port}`
      const bundle = bundles.get(offered)!
      if (url === '/metadata.json') {
        response.end(JSON.stringify({ cli: {
          version: bundle.version,
          cli: { url: `${origin}/cli-${offered}.js`, sha256: sha(bundle.cli), size: bundle.cli.length },
          notify: { url: `${origin}/notify-${offered}.mjs`, sha256: sha(bundle.notify), size: bundle.notify.length },
        } }))
        return
      }
      const asked = /^\/(cli|notify)-(from|next)\.(js|mjs)$/.exec(url)
      if (asked) { response.end(bundles.get(asked[2] as 'from' | 'next')![asked[1] as 'cli' | 'notify']); return }
      response.statusCode = 404
      response.end()
    })
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
    const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`

    mkdirSync(cliDir())
    copyFileSync(FROM!, join(cliDir(), 'cli.js'))
    copyFileSync(join(dirname(FROM!), 'notify.mjs'), join(cliDir(), 'notify.mjs'))
    writeFileSync(join(cliDir(), 'package.json'), '{"type":"module"}\n')
    if (SIGNED_IN) {
      backend = await FakeBackend.start()
      backend.addMachine(MACHINE)
    }
    daemon = await IsolatedDaemon.create({
      scriptPath: join(cliDir(), 'cli.js'),
      noMaster: !fromHasMaster,
      env: {
        ...(backend ? { BACKEND_WS_URL: backend.wsUrl, WEB_URL: backend.httpUrl, ADAPTER_COMPUTER_ID: MACHINE.computerId } : {}),
        ADAPTER_CLI_DIR: cliDir(),
        ADAPTER_UPDATE_DISABLE: 'false',
        ADAPTER_UPDATE_URL: `${local}/metadata.json`,
        ADAPTER_UPDATE_CHECK_MS: '1000',
        ADAPTER_UPDATE_SLOT_SEC: '-1',
        HARNESSD_UPDATE_PROBATION_MS: '6000',
        HARNESSD_INITIAL_BACKOFF_MS: '100',
        // The hooks go where the release puts them on a person's machine: the (throwaway) home.
        DISABLE_HOOK_INSTALL: 'false',
        HOOK_INSTALL_ENGINES: 'claude,codex',
        HARNESS_TUI_MANIFEST_URL: `${local}/tui/metadata.json`,
        ADAPTER_RUNTIME_METADATA_URL: `${local}/runtime/metadata.json`,
        ADAPTER_GRID_RUNTIME_METADATA_URL: `${local}/grid/metadata.json`,
      },
    })
    // Nothing beyond this machine: the runner's environment may name a registry or a proxy.
    for (const [key, value] of Object.entries(daemon.env)) {
      const host = typeof value === 'string' && /^(https?|wss?):\/\//i.test(value) ? new URL(value).hostname : null
      if (host && host !== '127.0.0.1' && host !== 'localhost') delete daemon.env[key]
    }
    if (backend) {
      // Signed in, as `harness login` leaves a computer: a session for its machine on this account.
      writeFileSync(join(daemon.root, 'auth', 'session.json'), JSON.stringify({
        version: 1, accessToken: MACHINE.token, autonomousEnv: 'prod', computerId: MACHINE.computerId,
        machineId: MACHINE.machineId, expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
      }), { mode: 0o600 })
    }
    // A released build may say nothing when it is ready, and has no request gate: its port is the sign.
    await daemon.start({ ready: 'port' })
    expect((await status())?.version).toBe(fromVersion)
    if (backend) await until(`${fromVersion} to connect as the machine's node`, () => backend!.nodeUp(MACHINE.machineId) || null, 60_000, 250)
  }, 300_000)

  afterAll(async () => {
    // Whatever runs the port now, a successor the release spawned on its own included, goes with the test.
    for (const pid of listeners()) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
    await daemon?.close()
    await backend?.close()
    await new Promise<void>((done) => server ? server.close(() => done()) : done())
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('agents mid-turn, a window and a tile come through the update, then through this master\'s first start', async () => {
    const d = daemon!
    onTestFailed(() => {
      console.log(`---- daemon log\n${logs().split('\n').slice(-200).join('\n')}`)
      if (process.env.REHEARSAL_LOG) writeFileSync(process.env.REHEARSAL_LOG, logs())
    })
    let client = await connect(d)
    const agents: Row[] = []
    for (const engine of ['claude', 'codex'] as const) {
      const cwd = join(d.projectsDir, `rehearsal-${engine}`)
      mkdirSync(cwd, { recursive: true })
      // Asked until the released build has finished wiring its handlers (it answers before it has).
      const created = await until(`${fromVersion} to create a ${engine} agent`, async () => {
        const answer = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
        return answer.error ? null : answer
      }, 60_000, 1_000)
      agents.push(await until(`${engine} to bind on ${fromVersion}`, async () => {
        const agent = (await rows(client)).find((one) => one.id === created.agent.id)
        return agent?.sessionId && agent.status === 'active' ? agent : null
      }, 90_000, 500))
    }
    for (const agent of agents) await turn(client, agent.id, `on ${fromVersion} (${agent.engine})`)
    // The release installed its hooks into the home, as on a person's machine, and the engines run them.
    const files = hookFiles()
    const before = { claude: readFileSync(files.claude, 'utf8'), codex: readFileSync(files.codex, 'utf8') }
    expect(before.claude).toContain(join(cliDir(), 'notify.mjs'))
    expect(before.codex).toContain(join(cliDir(), 'notify.mjs'))
    await openTile(client, agents[0].id)

    // Both at work when the update lands.
    for (const agent of agents) {
      const started = client.next(isTurn('turn_started', agent.id), 60_000, `the long turn of ${agent.engine}`)
      client.send('message', { agentId: agent.id, content: SLOW })
      await started
    }
    const updateFrom = d.log().length
    offered = 'next'
    await until(`the machine to run ${NEXT}`, async () => (await status())?.version === NEXT || null, 150_000, 250)
    client.close()

    // The window reconnects, as the desktop app does.
    client = await connect(d)
    const back = async (where: string) => {
      const now = await until(`both agents back on their conversations ${where}`, async () => {
        const list = await rows(client)
        return agents.every((agent) => list.some((one) => one.id === agent.id && one.status === 'active' && one.sessionId === agent.sessionId)) ? list : null
      }, 90_000, 500)
      // No one else: a hook that wrote the registry on its own would have put a stranger on a pane.
      expect(now.filter((one) => one.status === 'active').map((one) => one.id).sort()).toEqual(agents.map((agent) => agent.id).sort())
    }
    await back(`on ${NEXT}`)
    if (backend) await until(`${NEXT} to connect as the machine's node`, () => backend!.nodeUp(MACHINE.machineId) || null, 60_000, 250)
    // The turns in flight finished in their panes; the new core reads how they ended.
    for (const agent of agents) {
      await until(`the long turn of ${agent.engine} to have ended`, async () => {
        const row = (await rows(client)).find((one) => one.id === agent.id)
        const page = await client.request<{ events: unknown[] }>('session_get', { sessionId: agent.sessionId, limit: 50 }, 30_000)
        return row?.activity?.state !== 'working' && /answer \d+: !slow 20000/.test(JSON.stringify(page.events)) ? true : null
      }, 90_000, 1_000)
    }
    await openTile(client, agents[0].id)
    for (const agent of agents) await turn(client, agent.id, `on ${NEXT}, handed over (${agent.engine})`)
    // The services answer after the update, wherever the new build runs them.
    await searchFinds(client, agents[0], 'handed')
    // The hooks the release installed reach the new core through the new notify.mjs, whichever command
    // the files now name.
    for (const agent of agents) {
      const prompted = new RegExp(`\\[hooks\\] ${agent.sessionId.slice(0, 8)} UserPromptSubmit`)
      await until(`${agent.engine}'s hooks to reach the new core`, () => prompted.test(logs().slice(logs().indexOf(`v${NEXT}`))) || null, 30_000, 250)
    }
    for (const file of [files.claude, files.codex]) expect(readFileSync(file, 'utf8')).toContain(join(cliDir(), 'notify.mjs'))

    // Every process accounted for: under the release's master, its core on the new bundle as its child;
    // without one, the successor the release spawned, and nothing of the release left running.
    const status1 = (await status())!
    // A release without a master hands over by spawning the successor and watching it for up to half a
    // minute more (its waitForReady) before it leaves: one core once it has.
    const cores = await until('one core on this install', () => {
      const now = daemonProcesses().filter((one) => one.command.endsWith(' __run'))
      return now.length === 1 ? now : null
    }, 90_000, 500)
    if (fromHasMaster) {
      expect(status1.harnessd?.masterPid).toBe(d.pid)
      expect(cores[0].ppid).toBe(d.pid)
      await until('the master to keep the update', () => d.log().slice(updateFrom).includes('the update stayed up — keeping it'), 60_000)
    } else {
      expect(listeners()).toEqual([cores[0].pid])
    }
    expect(existsSync(join(cliDir(), 'cli.js.prev')) || existsSync(join(cliDir(), 'update-pending.json'))).toBe(false)
    memory(`after the update from ${fromVersion}`)
    client.close()

    // The next `harness start` (a reboot, the desktop app) starts this checkout as harnessd: master and core.
    await d.stop()
    for (const pid of listeners()) process.kill(pid, 'SIGTERM')
    await until('the daemon to be down', () => listeners().length === 0 || null, 30_000, 250)
    ;(d.options as { noMaster?: boolean }).noMaster = false
    await d.start()
    expect(await status()).toMatchObject({ version: NEXT, harnessd: { masterVersion: NEXT, masterPid: d.pid } })
    client = await connect(d)
    await back('under this master')
    if (backend) await until('this master\'s core to connect as the machine\'s node', () => backend!.nodeUp(MACHINE.machineId) || null, 60_000, 250)
    await openTile(client, agents[0].id)
    for (const agent of agents) await turn(client, agent.id, `on ${NEXT}, under the master (${agent.engine})`)
    await searchFinds(client, agents[1], 'master')
    await until('only the master and its own children', () => daemonProcesses().every((one) => one.pid === d.pid || one.ppid === d.pid) || null, 15_000, 200)
    expect(daemonProcesses().filter((one) => one.command.endsWith(' __run'))).toHaveLength(1)
    const under = memory(`under this master`)
    // Every service this build runs in its own process is the master's child, and answers (search did).
    const services = under.filter((row) => row.role.startsWith('service '))
    for (const service of services) {
      expect(Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(service.pid)], { encoding: 'utf8' }).trim()), service.role).toBe(d.pid)
    }
    if (process.env.REHEARSE_EXPECT_SERVICES) expect(services.length).toBe(Number(process.env.REHEARSE_EXPECT_SERVICES))
    client.close()
  }, 900_000)
})
