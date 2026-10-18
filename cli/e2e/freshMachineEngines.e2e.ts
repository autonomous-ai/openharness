/**
 * Engines as clean computers have them (fresh macOS 26 and Ubuntu 24.04 VMs, signed out, 2026-10-11), started from a
 * terminal with `harness new`:
 *
 *  - OpenCode 1.19.0 prints its help to standard error. Read from standard output alone, its permission flag was never
 *    confirmed and every launch of it held for good.
 *  - Codex installed by Harness with its own Node is a `#!/usr/bin/env node` script, and such a computer has no `node`
 *    on its PATH. Its probe failed, so every launch held; its pane would have failed the same way.
 *  - A Codex that cannot run at all is refused at once, with its own reason, instead of being held and said only to be
 *    unconfirmed after a minute.
 *  - A Codex that is not there at all is installed by Harness for a new project (2026-10-12): `harness new` waits for
 *    the install and then starts it, or says why it could not be installed, and leaves no folder behind either way.
 *  - A Codex the Desktop is still downloading as a brand-new Mac sets up (2026-10-16) is waited for: neither installed
 *    a second time beside it nor refused for the executable npm has linked and not yet finished.
 *
 * An agent starts harnesses only once the account lets it (Settings ▸ Experimental, off by default): the MCP case signs
 * in to the fake backend, whose account has that on.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import { resolveBinaryOnPath } from '../src/lib/binaryOnPath.js'

let daemon: IsolatedDaemon | undefined
let backend: FakeBackend | undefined
afterEach(async () => {
  await daemon?.close(); daemon = undefined
  await backend?.close(); backend = undefined
})

/** Signed in to the fake backend, whose account lets agents start harnesses. */
const ME: FakeMachine = { machineId: 'c9'.repeat(16), computerId: 'e2e-computer-0000-0000-0000000000c9', name: 'studio', token: 'e2e-token-fresh-machine' }
async function agentsMayStart(): Promise<{ env: Record<string, string>; signIn: (d: IsolatedDaemon) => void }> {
  const relay = backend = await FakeBackend.start()
  relay.addMachine(ME)
  relay.experiments.agents_start_agents = true
  return {
    env: { BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId },
    signIn: (d) => writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({
      version: 1, accessToken: ME.token, autonomousEnv: 'prod', computerId: ME.computerId,
      machineId: ME.machineId, expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
    }), { mode: 0o600 }),
  }
}

/** `harness <args>` from a terminal, not a pane; `said` hears its standard error as it comes. */
function harness(d: IsolatedDaemon, args: string[], said: (err: string) => void = () => {}): Promise<{ code: number; out: string; err: string; ms: number }> {
  const began = Date.now()
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk; said(err) })
    child.on('close', (code) => done({ code: code ?? -1, out, err, ms: Date.now() - began }))
  })
}

async function boot(prepare: (d: IsolatedDaemon) => void = () => {}, env: Record<string, string> = {}): Promise<IsolatedDaemon> {
  const d = daemon = await IsolatedDaemon.create({ env })
  onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
  prepare(d)
  await d.start()
  return d
}

const project = (d: IsolatedDaemon, name: string) => { const dir = join(d.projectsDir, name); mkdirSync(dir, { recursive: true }); return dir }

it('starts an OpenCode that prints its help to standard error, with its permission flag', async () => {
  const d = await boot((d) => {
    const binary = join(d.root, 'bin', 'opencode'), launches = join(d.root, 'launches.jsonl')
    d.env.OPENCODE_PATH = binary
    d.env.OPENCODE_DATA_DIR = join(d.root, 'opencode', 'data')
    d.env.OPENCODE_PLUGIN_DIR = join(d.root, 'opencode', 'plugin')
    // OpenCode 1.19.0 as measured: `--help` writes 4,285 bytes to standard error, none to standard output, exits 0.
    writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.19.0'); process.exit(0) }
if (args.includes('--help')) { console.error('opencode [project]\\n\\nOptions:\\n      --auto     approve every action\\n      --prompt   prompt to use'); process.exit(0) }
fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ args }) + '\\n');
process.title = ('opencode --session ses_' + process.pid).padEnd(160);
console.log('fixture-opencode-ready');
setInterval(() => {}, 1000);
`, { mode: 0o755 })
  })
  const started = await harness(d, ['new', 'opencode', project(d, 'stderr-help'), '--name', 'helpful', '--', 'hello'])
  expect(started.code, started.out + started.err).toBe(0)
  expect(started.out).toContain('Created helpful on this computer')
  const launch = await until('OpenCode to start', () => {
    const lines = existsSync(join(d.root, 'launches.jsonl')) ? readFileSync(join(d.root, 'launches.jsonl'), 'utf8').trim().split('\n') : []
    return lines[0] ? JSON.parse(lines[0]) as { args: string[] } : null
  }, 30_000, 100)
  expect(launch.args).toContain('--auto')
})

it('runs a Codex that npm installed as a Node script on a computer with no Node of its own', async (context) => {
  // The login shell's PATH below names system folders only; a computer that has a node there is not this case.
  const system = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
  if (system.some((dir) => existsSync(join(dir, 'node')))) context.skip()
  const d = await boot((d) => {
    const bin = join(d.root, 'bin')
    // What `npm install -g @openai/codex` leaves in ~/.local/bin: a script that asks env for a node.
    const engine = pathToFileURL(join(CLI_ROOT, 'e2e', 'harness', 'fakeEngine.mjs')).href
    const wrapper = readFileSync(join(bin, 'codex'), 'utf8').split('\n').slice(1).join('\n')
    expect(wrapper).toContain(engine)
    writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node\n${wrapper}`, { mode: 0o755 })
    // After the system's own startup files, as a person's own .zshrc or .bash_profile would: no node anywhere.
    const path = `export PATH=${[bin, ...system].join(':')}\n`
    writeFileSync(join(d.env.HOME!, '.zshrc'), path)
    writeFileSync(join(d.env.HOME!, '.bash_profile'), path)
  })
  const started = await harness(d, ['new', 'codex', project(d, 'no-node'), '--name', 'nodeless', '--', 'hello'])
  expect(started.code, started.out + started.err).toBe(0)
  expect(started.out).toContain('Created nodeless on this computer')
  // Its pane ran it too: the engine started and bound its conversation.
  const client = await LocalClient.connect(d)
  try {
    await until('Codex to bind its conversation in its pane', async () => {
      const row = ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents).find((a) => a.name === 'nodeless')
      return row?.sessionId && row.status === 'active' ? row : null
    }, 60_000, 500)
  } finally { client.close() }
})

it('refuses at once, with its own reason, a Codex that cannot run, and saves nothing to start later', async () => {
  const d = await boot((d) => {
    writeFileSync(join(d.root, 'bin', 'codex'), `#!${process.execPath}
console.error("node:internal/modules/cjs/loader:1228\\n  throw err;\\n\\nError: Cannot find module '@openai/codex-linux-x64'\\n\\nNode.js v22.20.0");
process.exit(1);
`, { mode: 0o755 })
  })
  const refused = await harness(d, ['new', 'codex', project(d, 'broken'), '--', 'hello'])
  expect(refused.code, refused.out + refused.err).toBe(1)
  expect(refused.err.trim()).toBe('Codex is installed but cannot run: Error: Cannot find module \'@openai/codex-linux-x64\'')
  // Refused, not held for a minute and then called unconfirmed.
  expect(refused.ms).toBeLessThan(30_000)
  const client = await LocalClient.connect(d)
  try {
    expect((await client.request<{ agents: unknown[] }>('agents_list', { includeStopped: true }, 30_000)).agents).toEqual([])
  } finally { client.close() }
})

it('says what a launch still held after a minute waits for, and cancels it so it never starts later', async () => {
  let fixed = ''
  const d = await boot((d) => {
    fixed = join(d.root, 'codex-answers')
    // A Codex whose help never comes: each probe meets its deadline, and the launch is held, asked again every two seconds.
    const wrapper = readFileSync(join(d.root, 'bin', 'codex'), 'utf8').split('\n')
    writeFileSync(join(d.root, 'bin', 'codex'), [wrapper[0],
      `if (process.argv.includes('--help') && !require('node:fs').existsSync(${JSON.stringify(fixed)})) setInterval(() => {}, 1000)`,
      `else ${wrapper.slice(1).join('\n')}`].join('\n'), { mode: 0o755 })
  })
  const held = await harness(d, ['new', 'codex', project(d, 'held'), '--name', 'later', '--', 'hello'])
  expect(held.code, held.out + held.err).toBe(1)
  expect(held.err).toContain('Waiting to confirm the selected executable’s permission flags.')
  expect(held.err.trim().split('\n').at(-1)).toBe('Harness did not start the harness within a minute: '
    + 'Waiting to confirm the selected executable’s permission flags. The request is cancelled, so it will not start later.')
  // Once Codex answers, the cancelled request still does not start.
  writeFileSync(fixed, '')
  await new Promise((done) => setTimeout(done, 8_000))
  const client = await LocalClient.connect(d)
  try {
    expect((await client.request<{ agents: unknown[] }>('agents_list', { includeStopped: true }, 30_000)).agents).toEqual([])
  } finally { client.close() }
}, 180_000)

/** The system folders a login shell's PATH names on a computer with nothing installed. */
const SYSTEM = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
/** A computer that has a codex, npm or node in its system folders is not one with nothing installed. */
const notBare = (): boolean => SYSTEM.some((dir) => ['codex', 'npm', 'node'].some((name) => existsSync(join(dir, name))))

/**
 * No codex anywhere, so the daemon installs it with the recipe it would use on a person's computer, through an `npm`
 * that puts the fake engine's own wrapper in the prefix: after the seconds in `npm-seconds` (3 by default), or failing
 * as an offline npm does while `npm-offline` exists.
 */
function withoutCodex(d: IsolatedDaemon): void {
  const bin = join(d.root, 'bin'), tools = join(d.root, 'tools'), installed = join(d.root, 'codex-package')
  const offline = join(d.root, 'npm-offline'), seconds = join(d.root, 'npm-seconds')
  renameSync(join(bin, 'codex'), installed)
  delete d.env.CODEX_PATH
  symlinkSync(process.execPath, join(bin, 'node'))
  writeFileSync(join(bin, 'npm'), `#!/bin/sh
case "$1" in
  prefix) printf '%s\\n' "\${npm_config_prefix:-$HOME/.local}"; exit 0 ;;
  install) ;;
  *) exit 1 ;;
esac
if [ -f ${JSON.stringify(offline)} ]; then
  echo 'npm error code ENOTFOUND' >&2
  echo 'npm error network request to https://registry.npmjs.org/@openai%2fcodex failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org' >&2
  exit 1
fi
sleep "$(cat ${JSON.stringify(seconds)} 2>/dev/null || echo 3)"
mkdir -p "$npm_config_prefix/bin" && cp ${JSON.stringify(installed)} "$npm_config_prefix/bin/codex" && chmod 755 "$npm_config_prefix/bin/codex"
`, { mode: 0o755 })
  mkdirSync(tools)
  symlinkSync(resolveBinaryOnPath('tmux')!, join(tools, 'tmux'))
  // The daemon's own PATH too: no codex of the developer's may be found and run.
  const path = [bin, tools, ...SYSTEM].join(':')
  d.env.PATH = path
  writeFileSync(join(d.env.HOME!, '.zshrc'), `export PATH=${path}\n`)
  writeFileSync(join(d.env.HOME!, '.bash_profile'), `export PATH=${path}\n`)
}

it('installs a missing Codex for a new project and starts it there, or says why it could not, leaving no folder', async (context) => {
  if (notBare()) context.skip()
  const d = await boot(withoutCodex)
  const offline = join(d.root, 'npm-offline')
  const home = d.env.HOME!, folder = join(home, 'harnesses', 'scratch1')
  const run = () => harness(d, ['new', 'codex', 'scratch1', '--name', 'cx', '--', 'Reply with pong'])
  // Offline: it says it is installing, then why Codex could not be installed, and no folder blocks the same command.
  writeFileSync(offline, '')
  const refused = await run()
  expect(refused.code, refused.out + refused.err).toBe(1)
  expect(refused.err.trim().split('\n')).toEqual(['Installing Codex. The harness starts once it is installed.',
    'Codex could not be installed: npm error network request to https://registry.npmjs.org/@openai%2fcodex failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org'])
  expect(existsSync(folder)).toBe(false)
  // Online again: the same command installs it, waits, and starts the harness in its new project.
  rmSync(offline)
  const started = await run()
  expect(started.code, started.out + started.err).toBe(0)
  expect(started.err.trim()).toBe('Installing Codex. The harness starts once it is installed.')
  expect(started.out).toContain(`Created cx on this computer in ${folder}.`)
  expect(existsSync(join(home, '.local', 'bin', 'codex'))).toBe(true)
  const client = await LocalClient.connect(d)
  try {
    const agents = await until('Codex to bind its conversation in its new project', async () => {
      const rows = (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents
      return rows.length === 1 && rows[0]!.sessionId && rows[0]!.status === 'active' ? rows : null
    }, 60_000, 500)
    expect(agents[0]).toMatchObject({ name: 'cx' })
  } finally { client.close() }
}, 180_000)

it('waits for the Desktop\'s own download of Codex, rather than installing it beside it or refusing what it has written so far', async (context) => {
  if (notBare()) context.skip()
  const d = await boot((d) => {
    withoutCodex(d)
    // Every npm the daemon or a pane runs, said where the test can read it.
    const npm = join(d.root, 'bin', 'npm'), script = readFileSync(npm, 'utf8').split('\n')
    writeFileSync(npm, [script[0], `printf '%s\\n' "$*" >> ${JSON.stringify(join(d.root, 'npm-calls'))}`, ...script.slice(1)].join('\n'), { mode: 0o755 })
  })
  const home = d.env.HOME!, bin = join(home, '.local', 'bin'), run = join(home, '.harness', 'run')
  mkdirSync(bin, { recursive: true }); mkdirSync(run, { recursive: true })
  // What npm has linked before it has written the package the launcher needs (a brand-new Mac, 2026-10-16).
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}\nconsole.error("Error: Cannot find module '@openai/codex-darwin-arm64'");\nprocess.exit(1)\n`, { mode: 0o755 })
  // The Desktop's download as it runs it (desktop/lib/bootstrap/agent_prefetch.dart): a shell named harness-download,
  // its pid in the marker, which it removes once done. It finishes once the launch has been seen held for it, however
  // long the CLI and the daemon took to get there.
  const marker = join(run, 'downloading-codex'), release = join(d.root, 'download-may-finish')
  const download = spawn('/bin/sh', ['-c', `while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.2; done; `
    + `cp ${JSON.stringify(join(d.root, 'codex-package'))} ${JSON.stringify(join(bin, 'codex'))}; rm -f ${JSON.stringify(marker)}; exit $?`,
  'harness-download'], { stdio: 'ignore' })
  try {
    writeFileSync(marker, String(download.pid))
    const started = await harness(d, ['new', 'codex', 'scratch1', '--name', 'cx', '--', 'Reply with pong'],
      (err) => { if (err.includes('Downloading Codex.')) writeFileSync(release, '') })
    expect(started.code, started.out + started.err).toBe(0)
    // Said first, as the hold it is; the download's last write may leave the next look a moment to settle.
    expect(started.err.trim().split('\n')[0]).toBe('Downloading Codex. The harness starts once it is downloaded.')
    expect(started.err).not.toContain('cannot run')
    expect(started.out).toContain(`Created cx on this computer in ${join(home, 'harnesses', 'scratch1')}.`)
  } finally { download.kill('SIGKILL') }
  // Nothing installed it a second time.
  const npmCalls = existsSync(join(d.root, 'npm-calls')) ? readFileSync(join(d.root, 'npm-calls'), 'utf8') : ''
  expect(npmCalls).not.toMatch(/^install/m)
  const client = await LocalClient.connect(d)
  try {
    const agents = await until('Codex to bind its conversation in its new project', async () => {
      const rows = (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents
      return rows.length === 1 && rows[0]!.sessionId && rows[0]!.status === 'active' ? rows : null
    }, 60_000, 500)
    expect(agents[0]).toMatchObject({ name: 'cx' })
  } finally { client.close() }
}, 180_000)

/** `harness mcp` as Codex starts it: requests in on stdin, answers by id from stdout. */
function mcp(d: IsolatedDaemon) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'mcp'], { cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['pipe', 'pipe', 'pipe'] })
  const waiting = new Map<number, (reply: Record<string, any>) => void>()
  createInterface({ input: child.stdout }).on('line', (line) => { const reply = JSON.parse(line); waiting.get(reply.id)?.(reply) })
  let next = 1
  const request = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> => {
    const id = next++
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((done) => waiting.set(id, done))
  }
  return {
    request,
    async call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; ms: number }> {
      const began = Date.now()
      const reply = await request('tools/call', { name, arguments: args })
      return { text: reply.result.content.map((c: { text: string }) => c.text).join('\n'), isError: reply.result.isError === true, ms: Date.now() - began }
    },
    close: () => child.stdin.end(),
  }
}

it('answers an MCP agent within Codex\'s tool timeout while Codex installs, starts that harness by itself, and never a second', async (context) => {
  if (notBare()) context.skip()
  const account = await agentsMayStart()
  const d = await boot((d) => { withoutCodex(d); writeFileSync(join(d.root, 'npm-seconds'), '55'); account.signIn(d) }, account.env)
  await until('the account\'s experiments to be kept', () => {
    try { return JSON.parse(readFileSync(join(d.dataDir, 'agent-settings.json'), 'utf8')).agentsStartAgents === true || null } catch { return null }
  }, 30_000, 200)
  const server = mcp(d)
  try {
    await server.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client' }, capabilities: {} })
    const task = { name: 'cx', agent: 'codex', project: 'scratch1', task: 'Reply with pong' }
    // Codex ends a tool call at 60 s unless told otherwise; the install takes 55 s here, and the answer comes first.
    const started = await server.call('harness_start', task)
    expect(started.isError, started.text).toBe(false)
    expect(started.ms).toBeLessThan(50_000)
    expect(started.text).toBe('cx on this computer: installing Codex. It starts by itself once installed; do not start it again.\n'
      + 'Next: harness_wait (names: "cx")  (until it has started and answered)')
    // It follows it by name, and asking again is answered with it.
    const listed = await server.call('harness_list', {})
    expect(listed.text).toMatch(/\ncx +Codex +installing +you /)
    const again = await server.call('harness_start', task)
    expect(again.text).toBe('"cx" is already starting: Harness is installing Codex. It starts by itself; wait for it with harness_wait (names: "cx"). Do not start it again.')
    // It starts by itself once installed, and is waited on to its answer.
    let waited = await server.call('harness_wait', { names: ['cx'] })
    for (let i = 0; i < 4 && !/^cx: idle/.test(waited.text); i++) waited = await server.call('harness_wait', { names: ['cx'] })
    expect(waited.text).toBe('cx: idle · read it: harness_read (name: "cx")')
  } finally { server.close() }
  const client = await LocalClient.connect(d, { machineId: ME.machineId })
  try {
    const rows = (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents
    expect(rows.map((row) => row.name)).toEqual(['cx'])
  } finally { client.close() }
  // Recorded as the MCP agent's, by the creation it was asked by.
  const ledger = readFileSync(join(d.dataDir, 'agent-client', 'started.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  expect(ledger.find((row) => row.child)).toMatchObject({ by: { agentId: expect.stringMatching(/^agent:codex/) }, child: { name: 'cx', creationId: expect.any(String) } })
}, 240_000)
