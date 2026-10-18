/**
 * Agent Messages between a core and a master of different builds. It left a process of its own, started on demand,
 * for the edge host on 2026-10-12. Where it runs is the master's to say, by service (harnessd/services.ts
 * `serviceProcessesEnv`), and a core routes it there and runs none of it itself: two at once would both type the same
 * message into the same pane. A core is left under a master of another build when that master cannot re-execute on
 * the bundle on disk (harnessd/reexec.ts); here, a Node without `process.execve` (harness/noExecve.cjs), the bundle
 * swapped under a running master, and its core killed for the master to start again from the bundle on disk.
 *
 * - This build's core under a master from before: that master's own Agent Messages process, asked for as the core
 *   starts, carries a message typed into an idle agent, once; started again on this build, it carries the next. That
 *   process from before never asks this core for shared tabs (`account`, `tab_key`, `tab_relay`, `observers`): no
 *   share route is called and no tab's relay is opened while it runs (shared tabs' version skew, case 2).
 * - A core from before under this build's master: the edge host carries it; no process of its own is started. Its
 *   Agent Messages are this build's, under a core that answers shared tabs' queries `UNKNOWN_QUERY`: every share action
 *   answers `DAEMON_TOO_OLD` with `CORE_TOO_OLD_TEXT`, the restart it needs, and nothing reaches a share route, while
 *   messages within the account's own tab are carried as before (case 1).
 *
 * Shared tabs' cases (docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md, "Rollout") need a build
 * from before them; one from before the move (2026-10-12) is one.
 *
 * Opt-in, since it needs a build from before the move (`SKEW_FROM=<that build>/cli.js`, its notify.mjs beside it), and
 * runs this checkout's from the run's bundle:
 * The old bundle to use is the 2c2c6be52 build (what 1b and 1c validated with); a fresh 4f92ee5e9 build fails the
 * old-master test on 1b and 1c alike.
 *     SKEW_FROM=<build>/cli.js E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/messagesSkew.e2e.ts
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { FAKE_ACCOUNT, FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import { AGENT_SETTINGS_DEFAULTS, saveAgentSettings } from '../src/lib/agentSettings.js'
import { CORE_TOO_OLD_TEXT } from '../src/services/messagesProcess.js'

const FROM = process.env.SKEW_FROM
const ME: FakeMachine = { machineId: 'c3'.repeat(16), computerId: 'e2e-computer-0000-0000-0000000000c3', name: 'skew', token: 'e2e-token-skew' }
const NO_EXECVE = fileURLToPath(new URL('./harness/noExecve.cjs', import.meta.url))

const count = (text: string, part: string): number => text.split(part).length - 1
/** What the backend saw of shared tabs: their routes, and their relay's socket. */
const sharedTabsSeen = (backend: FakeBackend, since = 0): string[] =>
  backend.seen.slice(since).filter((line) => /\/api\/agent-messages\/(shares|invites)|\/api\/agent-messages-ws/.test(line))
const SHARE_ACTIONS = ['shares', 'share_tab', 'share_invite', 'share_accept', 'share_stop']
const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents).find((agent) => agent.id === agentId)

describe.skipIf(!FROM)('Agent Messages between a core and a master of different builds', () => {
  let scratch = ''
  let daemon: IsolatedDaemon | undefined
  let backend: FakeBackend | undefined
  beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), 'messages-skew-')) })
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))
  afterEach(async () => {
    await daemon?.close(); daemon = undefined
    await backend?.close(); backend = undefined
  })

  /** The two builds: the one from before, and this checkout's (the run's bundle). */
  const builds = () => {
    const now = process.env.E2E_BUNDLE_PATH
    if (!now) throw new Error('E2E_BUNDLE=1: this checkout runs from the bundle it ships')
    return { before: FROM!, now }
  }
  /** Put [bundle] (and the notify.mjs beside it) where the daemon's master runs from. */
  const install = (dir: string, bundle: string) => {
    copyFileSync(bundle, join(dir, 'cli.js'))
    copyFileSync(join(dirname(bundle), 'notify.mjs'), join(dir, 'notify.mjs'))
  }

  /** A master on [first], signed in to the fake backend, on a Node that cannot re-execute. */
  const start = async (name: string, first: string) => {
    const dir = join(scratch, name)
    mkdirSync(dir, { recursive: true })
    install(dir, first)
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n')
    backend = await FakeBackend.start()
    backend.addMachine(ME)
    const d = daemon = await IsolatedDaemon.create({ scriptPath: join(dir, 'cli.js'), env: {
      BACKEND_WS_URL: backend.wsUrl, WEB_URL: backend.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId,
      NODE_OPTIONS: `--require=${JSON.stringify(NO_EXECVE)}`, HARNESSD_INITIAL_BACKOFF_MS: '100',
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
    } })
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    // On for the account, which this build's core keeps, and in the copy it keeps, which a build from before reads as
    // its own Settings ▸ Agents: never left to either build's default.
    backend.experiments.agent_messages = true
    saveAgentSettings(d.dataDir, { accountId: FAKE_ACCOUNT, machineId: ME.machineId }, { ...AGENT_SETTINGS_DEFAULTS, agentMessages: true })
    writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({
      version: 1, accessToken: ME.token, autonomousEnv: 'prod', computerId: ME.computerId,
      machineId: ME.machineId, expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
    }), { mode: 0o600 })
    await d.start()
    return { d, dir, relay: backend }
  }

  /** The bundle on disk becomes [next], and the core is killed: the master, which cannot re-execute, starts the next
   *  core from it. Resolves with that core's pid once Agent Messages has connected to it. */
  const swapCore = async (d: IsolatedDaemon, dir: string, next: string) => {
    const links = count(d.log(), '[services] messages connected')
    install(dir, next)
    process.kill(d.corePid()!, 'SIGKILL')
    await until('a core on the bundle on disk', () => d.coresStarted() === 2 || null, 60_000, 100)
    expect(d.log()).toContain('this Node cannot re-execute a process: the master keeps its code')
    const core = d.corePid()!
    // Started from the bundle on disk, never the master's own lean copy: the other build.
    expect(execFileSync('ps', ['-o', 'command=', '-p', String(core)], { encoding: 'utf8' })).toContain(join(dir, 'cli.js'))
    await until('Agent Messages to reach the new core', () => count(d.log(), '[services] messages connected') > links || null, 60_000, 200)
    return core
  }

  /** Two idle agents in one tab, and a message from one to the other typed into it, once. */
  const message = async (d: IsolatedDaemon, relay: FakeBackend, client: LocalClient, agents: Array<Record<string, any>>, text: string) => {
    if (!agents.length) {
      for (const folder of ['lead', 'api']) {
        const cwd = join(d.projectsDir, folder)
        mkdirSync(cwd, { recursive: true })
        const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
        expect(created.error, JSON.stringify(created)).toBeUndefined()
        agents.push(await until(`${folder} to bind its conversation`, async () => {
          const agent = await row(client, created.agent.id)
          return agent?.sessionId && agent.status === 'active' ? agent : null
        }, 60_000, 500))
      }
      relay.agentMessages = { revision: 1, machines: [{ machineId: ME.machineId, name: ME.name }],
        tabs: [{ id: 'app', name: 'app', panes: agents.map((agent) => ({ machineId: ME.machineId, agentId: agent.id })) }] }
    }
    const [lead, api] = agents
    const roster = await until('the roster', async () => {
      const answer = await client.request('agent_messages', { action: 'send', pane: lead.tmuxPane }, 40_000)
      return String(answer.roster ?? '').includes('Teammates:') ? answer : null
    }, 60_000, 1_000)
    const apiName = String(roster.roster).split('\n')[1].trim().split(/\s{2,}/)[0]
    const sent = await client.request('agent_messages', { action: 'send', pane: lead.tmuxPane, to: [apiName], text }, 40_000)
    expect(sent.error, JSON.stringify(sent)).toBeUndefined()
    const status = await until('the message to be typed into the idle agent', async () => {
      const history = await client.request<{ messages?: Array<{ id: string; statuses: Array<Record<string, unknown>> }> }>('agent_messages', { action: 'history' }, 30_000)
      const s = history.messages?.find((m) => m.id === sent.id)?.statuses[0]
      return s?.state === 'delivered' ? s : null
    }, 90_000, 500)
    expect(status).toMatchObject({ via: 'prompt' })
    // Once: a second service would have typed it again.
    await new Promise((settle) => setTimeout(settle, 5_000))
    const turns = client.frames.filter((frame: Frame) => frame.type === 'turn_started' && frame.agentId === api.id
      && String(frame.payload?.userMessage ?? '').includes(String(sent.id)))
    expect(turns).toHaveLength(1)
  }

  it('this build\'s core under a master from before: that master\'s own process carries it, once, and on this build after a restart', async () => {
    const { before, now } = builds()
    const { d, dir, relay } = await start('new-core', before)
    // The master from before runs it in a process of its own, which its core asks for while it is on.
    await until('its own process to connect', () => count(d.log(), '[services] messages connected') >= 1 || null, 60_000, 200)
    expect(count(d.log(), '[harnessd] service messages started')).toBe(1)
    await swapCore(d, dir, now)
    const client = await LocalClient.connect(d, { machineId: ME.machineId })
    const agents: Array<Record<string, any>> = []
    await message(d, relay, client, agents, 'Which port does the daemon serve?')
    // The process from before knows nothing of shared tabs: under this core it calls none of their routes and opens no
    // tab's relay.
    expect(sharedTabsSeen(relay)).toEqual([])
    // Its process started again: on the bundle on disk, this build's, still alone.
    const pid = Number([...d.log().matchAll(/\[harnessd\] service messages started \(pid (\d+)\)/g)].at(-1)![1])
    const links = count(d.log(), '[services] messages connected')
    process.kill(pid, 'SIGKILL')
    await until('it to start again and connect', () => count(d.log(), '[services] messages connected') > links || null, 60_000, 200)
    expect(count(d.log(), '[harnessd] service messages started')).toBe(2)
    await message(d, relay, client, agents, 'And the hook port?')
    expect(d.coresStarted()).toBe(2)
    client.close()
  }, 600_000)

  it('a core from before under this build\'s master: the edge host carries it, once, and no process of its own starts', async () => {
    const { before, now } = builds()
    const { d, dir, relay } = await start('old-core', now)
    await until('the edge host to connect it', () => count(d.log(), '[services] messages connected') >= 1 || null, 60_000, 200)
    await swapCore(d, dir, before)
    // This build's core, before the swap, read the shares once as Agent Messages woke: what follows is the old core's.
    const since = relay.seen.length
    const client = await LocalClient.connect(d, { machineId: ME.machineId })
    await message(d, relay, client, [], 'Which port does the daemon serve?')
    // The core from before asks for it as an experiment, at start: this master runs it in the edge host already.
    expect(count(d.log(), '[harnessd] service messages started')).toBe(0)
    // Shared tabs need the core restarted on this build: each share action says so, and none reaches the backend.
    for (const action of SHARE_ACTIONS) {
      const answer = await client.request('agent_messages', { action, tabId: 'app', name: 'app', sharedTabId: 'a1b2c3d4e5f6a1b2c3d4e5f6' }, 40_000)
      expect(answer, action).toMatchObject({ error: 'DAEMON_TOO_OLD', detail: CORE_TOO_OLD_TEXT })
    }
    expect(sharedTabsSeen(relay, since)).toEqual([])
    expect(d.coresStarted()).toBe(2)
    client.close()
  }, 600_000)
})
