/**
 * What a pane is started with, end to end: never harnessd's own variables, nor the session of an agent whose shell
 * started the daemon (lib/agentSessionEnv.ts). The master gives the core and
 * each service the `HARNESSD_*` they run by, the service token among them. The tmux server the core
 * started copied them into every pane it made, so every agent, terminal tile and hook had them all (found
 * 2026-10-11: `env` in an agent's pane listed every one). The core now takes them out of its
 * environment before it starts anything (lib/harnessdEnv.ts), and a tmux server an earlier boot started
 * with them is told to forget them as the core takes it over (TmuxBackend `unsetServerEnvironment`).
 * And a start from a shell keeps only an allowlist of that shell's environment, then what HARNESS_ENV_FILE names
 * (lib/startEnvironment.ts): another program's token in that shell never reaches a pane
 * (docs/plans/2026-11-17-daemon-minimal-env-design.md).
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

const exec = promisify(execFile)
type Engine = 'claude' | 'codex'
type Row = Record<string, any>

/** What an earlier boot's master gave its core, as an owner's machine showed them in a pane: made-up values. */
const EARLIER_BOOT = {
  HARNESSD_SERVICE_TOKEN: 'earlier-boot-token', HARNESSD_SERVICES: 'search,viewers', HARNESSD_SERVICE_PROCESSES: 'search,viewers',
  HARNESSD_SUPERVISED: '1', HARNESSD_WATCHDOG_MS: '30000', HARNESSD_RESTARTS: '0', HARNESSD_JUDGES_SUPERSEDED: '1',
}

const row = async (client: LocalClient, agentId: string): Promise<Row | undefined> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents.find((agent) => agent.id === agentId)
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId

async function create(d: IsolatedDaemon, client: LocalClient, engine: Engine | 'terminal', folder: string, over: Record<string, unknown> = {}): Promise<Row> {
  const cwd = join(d.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, ...(engine === 'terminal' ? {} : { bypassPermission: true }), ...over }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${folder} to start`, async () => {
    const agent = await row(client, created.agent.id)
    if (engine === 'terminal') return agent?.tmuxPane ? agent : null
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
}

/** An agent's own session, as Claude Code and Codex set it in the shells they run commands in: made-up values. */
const AGENT_SESSION = {
  AI_AGENT: 'claude-code_2-1-296_agent', CLAUDECODE: '1', CLAUDE_CODE_MESSAGING_TOKEN: 'agent-token', CLAUDE_CODE_SESSION_ID: 'agent-session',
  CODEX_THREAD_ID: 'agent-thread',
}
const HARNESSD = 'HARNESSD_'
const SESSION = 'AI_AGENT,CLAUDECODE,CLAUDE_CODE_MESSAGING,CLAUDE_CODE_SESSION,CODEX_THREAD'
/** What the core says as it takes a server over: how many names it unset, never which the server had. */
const UNSET = /\[terminal\] tmux: unset \d+ harnessd and agent session names in the environment new panes start with/

/** What an agent's engine answers to [directive] (fakeEngine), read from its thread by the answer's [lead]. */
async function engineAnswer(client: LocalClient, agentId: string, directive: string, lead: string): Promise<string> {
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${directive})`)
  client.send('message', { agentId, content: directive })
  await ended
  const { sessionId } = (await row(client, agentId))!
  return until(`the ${directive} answer in the thread`, async () => {
    const page = await client.request<{ events?: Array<{ type: string; payload: Record<string, any> }> }>('session_get', { sessionId, limit: 200 }, 30_000)
    const answer = (page.events ?? []).filter((event) => event.type === 'text_delta').map((event) => String(event.payload.content))
      .find((text) => text.startsWith(lead))
    return answer?.slice(lead.length) ?? null
  }, 15_000, 250)
}

/** The names an agent's engine has that start with [prefixes], asked as an agent reads its environment (fakeEngine `!env`). */
const engineHas = (client: LocalClient, agentId: string, prefixes = HARNESSD): Promise<string> =>
  engineAnswer(client, agentId, `!env ${prefixes}`, `env ${prefixes}: `)

/** The names starting with [prefixes] in the environment of the shell a pane runs, as that shell sees it. */
const shellHas = async (d: IsolatedDaemon, pane: string, name: string, prefixes = HARNESSD): Promise<string[]> =>
  withPrefix(Object.keys(await d.paneEnvironment(pane, name)), prefixes)
const names = (env: string, prefixes = HARNESSD): string[] => withPrefix(env.split('\n').map((line) => line.split('=')[0]), prefixes)
const withPrefix = (all: string[], prefixes: string): string[] =>
  all.filter((name) => prefixes.split(',').some((prefix) => name.startsWith(prefix))).sort()

/** What the shell that runs `harness start -f` may hold beside the daemon's own: another program's token, an agent's
 *  session, a provider key. Made-up values (docs/plans/2026-11-17-daemon-minimal-env-design.md). */
const SHELL_SESSION = { SENTINEL_TOKEN: 'sentinel-from-the-shell', CLAUDE_CODE_MESSAGING_TOKEN: 'agent-token', ANTHROPIC_API_KEY: 'kept-sentinel' }

describe('a pane\'s environment', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  const created = async (): Promise<IsolatedDaemon> => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    return d
  }

  /** Every kind of pane the daemon makes: Claude Code, Codex and a terminal tile, each without the variables. */
  const expectNoneIn = async (d: IsolatedDaemon, client: LocalClient, prefixes = HARNESSD): Promise<void> => {
    for (const engine of ['claude', 'codex'] as const) {
      const agent = await create(d, client, engine, `pane-${engine}`)
      expect(await engineHas(client, agent.id, prefixes), engine).toBe('(none)')
    }
    const tile = await create(d, client, 'terminal', 'pane-terminal')
    expect(await shellHas(d, tile.tmuxPane, 'terminal', prefixes)).toEqual([])
  }

  it('has none of harnessd\'s variables when the daemon started the tmux server, under a master that gave the core them', async () => {
    const d = await created()
    await d.start()
    // Under a master, as on every machine: the core was given the token, and its services connected with it.
    expect(d.log()).toMatch(/\[harnessd\] core started/)
    const client = await LocalClient.connect(d)
    await expectNoneIn(d, client)
    client.close()
  }, 300_000)

  it('has none of them when the tmux server was started before the daemon, by an earlier boot that gave it them', async () => {
    const d = await created()
    // The server as an earlier core left it: started from an environment with that boot's HARNESSD_*, and a
    // pane of that boot's still in it, which keeps what it was started with.
    const earlier = join(d.root, 'earlier.env')
    // The shell creates the file before env writes it, so the file shows up empty first (CI run 43672659842 read
    // it then): write it aside and move it into place whole.
    await exec('tmux', ['-S', d.tmux.socket, 'new-session', '-d', '-s', 'earlier-boot', '/bin/sh', '-c', `env > ${earlier}.tmp && mv ${earlier}.tmp ${earlier}; sleep 600`],
      { env: { ...d.env, ...EARLIER_BOOT }, timeout: 10_000 })
    await until('the earlier boot\'s pane to write its environment', () => existsSync(earlier) || null, 10_000, 50)
    expect(names(readFileSync(earlier, 'utf8'))).toEqual(Object.keys(EARLIER_BOOT).sort())
    await d.start()
    expect(d.log()).toMatch(UNSET)
    const client = await LocalClient.connect(d)
    await expectNoneIn(d, client)
    client.close()
  }, 300_000)

  it('has none of an agent\'s session when that agent\'s shell started the daemon and the tmux server', async () => {
    // An agent that installs Harness runs `harness start` from its shell: the master, and a tmux server started
    // from that shell, have that agent's session, and every pane would have looked like that agent's.
    const d = await IsolatedDaemon.create({ env: AGENT_SESSION })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await exec('tmux', ['-S', d.tmux.socket, 'new-session', '-d', '-s', 'agent-shell', '/bin/sh', '-c', 'sleep 600'], { env: d.env, timeout: 10_000 })
    await d.start()
    expect(d.log()).toMatch(UNSET)
    const client = await LocalClient.connect(d)
    await expectNoneIn(d, client, SESSION)
    client.close()
  }, 300_000)

  it.each([
    ['the master', {}],
    // The core in the CLI's own process, as Harness OS's unit runs it: the env file is read again after the narrowing.
    ['the core alone', { HARNESS_NO_MASTER: '1' }],
  ])('harness start -f gives %s only the allowlist of its shell, and the env file\'s variables', async (_what, more) => {
    const d = await IsolatedDaemon.create({ foreground: true, env: { ...SHELL_SESSION, ...more }, envFile: { E2E_FROM_ENV_FILE: 'reaches-the-pane' } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const client = await LocalClient.connect(d)
    const tile = await create(d, client, 'terminal', 'pane-foreground')
    const env = await d.paneEnvironment(tile.tmuxPane, 'foreground')
    client.close()
    expect(env.SENTINEL_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_MESSAGING_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBe('kept-sentinel')
    expect(env.PATH).toContain(join(d.root, 'bin'))
    expect(env.E2E_FROM_ENV_FILE).toBe('reaches-the-pane')
    expect(d.log()).toMatch(/\[env\] started with \d+ variables; [1-9]\d* left out \(docs\/cli\.md#the-daemons-environment\)/)
    expect(d.log().includes('SENTINEL_TOKEN') || d.log().includes('sentinel-from-the-shell'), 'the log names no variable').toBe(false)
  }, 300_000)
})
