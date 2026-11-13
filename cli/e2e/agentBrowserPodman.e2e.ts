/**
 * The agent browser on real Podman (Task 20 of docs/superpowers/plans/2026-11-10-agent-browser.md, driven as Task 18 of
 * docs/superpowers/plans/2026-11-11-browser-from-chat.md has it): the image built from the CLI's own files, a plain agent's
 * browser started by its person (`agent_browser_start`), its Chrome driven by `harness browser` run in the agent's pane as
 * its engine's shell tool runs it, its screen streamed as the Desktop opens it, Chrome's window sized to the panel, a page
 * that asks for a person, a page that cannot reach the host, its login kept across the person's Stop and the agent's own
 * stop, its restart after a crash, Device, a proxy that fails closed, and a delete that leaves nothing behind.
 * agentBrowser.e2e.ts runs the same daemon against a fake `podman`.
 *
 * `harness browser` proves its pane from its parent processes (lib/callerPane.ts), so it must run below the pane's own
 * process: the agent's fake engine (its wrapper here, `writeEngine`) runs each command the test leaves it, as Claude
 * Code's Bash tool does, with the pane's environment. Typing into the pane would type into the engine's composer.
 *
 * The daemon finds a `podman` first on its PATH that runs the real one, so nothing a person or another run keeps in
 * Podman is seen or touched, and the clean-up can remove all the run made:
 * - Linux, on rootless Podman: in a store of its own, `--root` and `--runroot` in a folder this file made. Skipped, with
 *   the reason, where `podman info` fails.
 * - macOS: on Harness's own machine, `harness`, made as a person's Install makes it when their machine will not start
 *   (spec § Podman). The wrapper refuses every machine command but a listing for any machine but `harness`, so the
 *   product's one start of the person's machine fails as such a machine's does, and their machines and default
 *   connection are never changed. Skipped unless every machine here is stopped and none is named `harness`. The
 *   clean-up removes the machine; the files Podman leaves beside it (its image download, SSH key) are not this file's
 *   to guess, so a person removes them by name (agent-browser-spike-2.md § Cleanup).
 * - macOS, with HARNESS_E2E_PODMAN_REUSE_MACHINE=harness: on a person's `harness` machine that already runs, used as
 *   it is, beside their own daemon and browsers. The run's daemon is on it as theirs is (its state file names the
 *   connection), so it never starts or makes a machine; the wrapper refuses every machine command but a listing or an
 *   inspect, and any `system` command or prune, and the run fails on a refusal. Only what this run's daemon made is
 *   removed: its label and its agent's names, and the image it built. Skipped unless that machine runs.
 * The nightly suite leaves it out (vitest.e2e.ci.config.ts): the image takes minutes to build. CI runs it on Linux when
 * asked (cli-e2e.yml, `agent_browser_podman`).
 *
 * The cases run in order on one daemon and one agent, each starting where the last left the browser; once one fails,
 * the rest are skipped and say which.
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { networkInterfaces, tmpdir, userInfo } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { TerminalBinaryKind } from '../src/lib/terminalBinary.js'
import { daemonIdOf } from '../src/services/agentBrowser.js'
import { browserAssetsHash, browserContextFiles } from '../src/services/agentBrowser/assets.js'
import { imageTag } from '../src/services/agentBrowser/image.js'
import { artifactLog } from './harness/artifacts.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, fakeEngineShim, IsolatedDaemon, until } from './harness/daemon.js'

// The image build may take its whole 15 minutes (image.ts) on a cold runner, and the browser's start follows it.
const BUILD_MS = 20 * 60_000
const OWN_MACHINE = 'harness'
// macOS: the person's running `harness` machine, used as it is instead of one this run makes (the file's comment).
const REUSE = process.env.HARNESS_E2E_PODMAN_REUSE_MACHINE ?? ''
// macOS: Harness's own machine first, its init's 10 minutes (setup.ts, most of it the machine image's download) and its
// start.
const MACHINE_MS = process.platform === 'darwin' && !REUSE ? 12 * 60_000 : 0
// A container created again (new settings) or started again (after an exit): the ready check's 60 s and the restart's
// backoff, with room.
const START_MS = 3 * 60_000
// The CLI's longest wait (navigate: 75 s, agentClient/browser.ts), plus its start.
const CALL_MS = 90_000
const TYPED = 'Xin chào 👋'
const DEVICE = { gpuVendor: 'Harness E2E Vendor', gpuRenderer: 'Harness E2E Renderer', cpuCores: 12, memoryGb: 4 }
const PROXY_LOGIN = { username: 'harness-e2e', password: 'e2e-proxy-password' }
const CHAT_LINE = 'This page asks for a person. Tell your person in chat what to do in Browser, wait for their answer, and do not act on the challenge yourself.'
// What `harness browser` prints (the spec's copy).
const OFF_LINE = 'Your browser is off. Ask your person to start it: Browser in your chat.'
const STOP_LINE = 'Your person stopped your browser.'
const START_STOP_LINE = 'Only your person starts and stops your browser: Browser in your chat.'
// Text no page here shows: a `wait` for it runs its whole 30 s unless something ends it.
const NEVER_SHOWN = 'Text no page here shows'
// The tool server in the image, as the daemon starts it (services/agentBrowser.ts TOOL_SERVER).
const TOOL_SERVER = ['node', '/opt/harness-browser/browser-tools.mjs']
// How `harness browser` is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs: the build that
// ships.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']
// Inside the container, the machine it runs on; Podman writes the name into the container's /etc/hosts. The browser's
// relay refuses it (proxy-relay.mjs), so only what does not go through the browser uses it.
const HOST = 'host.containers.internal'
// The pages' address, as the browser reaches them: this machine on its own network, which the relay lets through as
// any browser on that network reaches it.
const PAGES_HOST = Object.values(networkInterfaces()).flat()
  .find((one) => one && one.family === 'IPv4' && !one.internal && !one.address.startsWith('169.254.') && !one.address.startsWith('192.168.127.'))?.address
/** Reads, in the container, what a tab reports of its device: run with the tab's target id (see the Device case). */
const DEVICE_READ = "import { chromium } from 'playwright-core';"
  + "const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');"
  + 'for (const context of browser.contexts()) for (const page of context.pages()) {'
  + ' const { targetInfo } = await (await context.newCDPSession(page)).send(\'Target.getTargetInfo\');'
  + ' if (targetInfo.targetId !== process.argv[1]) continue;'
  + ' await page.waitForLoadState(\'load\');'
  + ' console.log(JSON.stringify(await page.evaluate(() => { const gl = document.createElement(\'canvas\').getContext(\'webgl\');'
  + ' return { cores: String(navigator.hardwareConcurrency), memory: String(navigator.deviceMemory),'
  + ' vendor: gl ? String(gl.getParameter(0x9245)) : \'\', renderer: gl ? String(gl.getParameter(0x9246)) : \'\' } })));'
  + '}'
  + 'process.exit(0)'

const realPodman = process.platform === 'linux' || process.platform === 'darwin'
  ? (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'podman')).find((file) => existsSync(file)) ?? null
  : null

// macOS: Podman keeps the person's machines and connections in their home, and vitest.setup.ts gives every test a home
// of its own. Linux's store is named by flags, and its run keeps the test's home.
const podmanEnv = process.platform === 'darwin' ? { ...process.env, HOME: userInfo().homedir } : process.env

/** Why this file cannot run here, or null. Only a listing is asked of a machine: it starts none. */
function unavailable(): string | null {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return `Linux and macOS only: Browser is not on ${process.platform} in v1`
  if (!realPodman) return 'podman is not on PATH'
  if (!PAGES_HOST) return 'this machine has no network address for the browser to reach its pages at'
  if (REUSE && process.platform !== 'darwin') return 'HARNESS_E2E_PODMAN_REUSE_MACHINE is for macOS: Linux runs in a store of its own'
  if (REUSE && REUSE !== OWN_MACHINE) return `HARNESS_E2E_PODMAN_REUSE_MACHINE is ${REUSE}: only Harness's own machine, ${OWN_MACHINE}, is used as it is`
  try {
    if (process.platform === 'darwin') {
      const listed = JSON.parse(execFileSync(realPodman, ['machine', 'list', '--format', 'json'], { timeout: 10_000, stdio: 'pipe', env: podmanEnv }).toString()) as Array<{ Name: string; Running: boolean }>
      if (REUSE) {
        if (!listed.some((machine) => machine.Name === OWN_MACHINE && machine.Running)) return `no running Podman machine named ${OWN_MACHINE} to use as it is`
        execFileSync(realPodman, ['--connection', OWN_MACHINE, 'info', '--format', 'json'], { timeout: 10_000, stdio: 'pipe', env: podmanEnv })
        return null
      }
      // A running machine would be used as the person's; none at all would be made under their default name.
      if (listed.length === 0) return 'no Podman machine here: this test makes Harness\'s own beside a person\'s that will not start'
      if (listed.some((machine) => machine.Running)) return 'a Podman machine is running here, and this test never uses a person\'s'
      if (listed.some((machine) => machine.Name === OWN_MACHINE)) return `a Podman machine named ${OWN_MACHINE} is here already, and this test removes the one it makes`
      return null
    }
    execFileSync(realPodman, ['info', '--format', 'json'], { timeout: 10_000, stdio: 'pipe' })
    return null
  } catch (error) {
    const said = String((error as { stderr?: Buffer }).stderr ?? '').trim().split('\n').at(-1)
    return `podman info failed: ${said || (error as Error).message}`
  }
}
const SKIP = unavailable()

/** `dir`: Linux's store folder; macOS has the machine instead. */
interface Store { dir?: string; flags: string[] }
interface Ran { code: number; stdout: string; stderr: string }

/**
 * Never rejects: a command that failed or ran out of time answers its code (-1 when it had none) and what it said.
 * [input], when given, is its whole standard input.
 */
function run(file: string, args: string[], timeoutMs: number, input?: string): Promise<Ran> {
  return new Promise((done) => {
    const child = execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: podmanEnv }, (error, stdout, stderr) => {
      done({ code: !error ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr: error?.killed ? `timed out after ${timeoutMs} ms` : stderr })
    })
    if (input !== undefined) child.stdin!.end(input)
  })
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** Reusing the person's machine: every command the wrapper refused, a line each. */
const refusedLog = (d: IsolatedDaemon) => join(d.root, 'podman-refused.log')

/**
 * Reusing the person's machine: the run's daemon is on it as their own daemon is, by the connection its state file
 * names (stateFile.ts), as setup leaves it once it made Harness's machine. Without it the daemon would ask the
 * person's default connection, which may be another machine.
 */
function onOwnMachine(d: IsolatedDaemon): void {
  writeFileSync(join(d.dataDir, 'agent-browser.json'), `${JSON.stringify({ browsers: {}, deleting: [], setup: null, connection: OWN_MACHINE }, null, 2)}\n`, { mode: 0o600 })
}

/** Where the daemon looks first (its bin is first on PATH, as agentBrowser.e2e.ts's fake is): the real Podman, in the store. */
function writePodman(d: IsolatedDaemon, store: Store): void {
  const bin = join(d.root, 'bin')
  mkdirSync(bin, { recursive: true })
  if (process.platform !== 'darwin') {
    writeFileSync(join(bin, 'podman'), `#!/bin/sh\nexec ${[realPodman!, ...store.flags].map(quote).join(' ')} "$@"\n`, { mode: 0o755 })
    return
  }
  writeFileSync(join(bin, 'podman'), '#!/bin/sh\n'
    + (REUSE
      // The machine is the person's, used as it is: its command and the word after, past `--connection <name>`. A
      // listing or an inspect is all a machine is asked; nothing changes their connections or prunes. Each refusal is
      // recorded, and the run fails on it (leaveMachine).
      ? 'one=; two=; skip=; for arg in "$@"; do if [ -n "$skip" ]; then skip=; continue; fi; case "$arg" in --connection|-c) skip=1 ;; -*) ;; *) if [ -z "$one" ]; then one=$arg; else two=$arg; break; fi ;; esac; done\n'
        + `case "$one:$two" in machine:list|machine:inspect) ;; machine:*|system:*|*:prune) echo "podman $one $two" >> ${quote(refusedLog(d))}; echo "Error: this test uses the machine ${OWN_MACHINE} as it is: podman $one $two is refused" >&2; exit 125 ;; esac\n`
      // The daemon names its machine last (setup.ts, podman.ts); every other is the person's, refused as one that fails.
      : `if [ "$1" = machine ] && [ "$2" != list ]; then for last in "$@"; do :; done; [ "$last" = ${OWN_MACHINE} ] || { echo "Error: this test starts or changes no machine but ${OWN_MACHINE}" >&2; exit 125; }; fi\n`)
    // The person's HOME, where Podman keeps their machines and connections: the daemon's is the run's own.
    + `HOME=${quote(podmanEnv.HOME!)} exec ${quote(realPodman!)} "$@"\n`, { mode: 0o755 })
  // macOS's /etc/zprofile (path_helper) puts /etc/paths.d, Homebrew's podman among them, ahead of the daemon's PATH in
  // the login shell it asks where podman is (lib/tmuxOnPath.ts): this bin goes first again after it.
  writeFileSync(join(d.env.ZDOTDIR!, '.zprofile'), `path=(${quote(bin)} $path)\n`, { flag: 'a' })
}

/**
 * The agent's engine (the fake Claude Code, as the daemon's own wrapper starts it) also runs each `harness browser` the
 * test leaves in [runs]: `<n>.json`, `{pane, args}`, taken by the engine in that pane, which writes `<n>.out`, `<n>.err`
 * and, last, `<n>.code`. So the command's parents are the engine and the pane's shell, as when the engine's shell tool runs
 * it, and its environment is the pane's. A probe of the engine (`--version`) runs in no pane and takes nothing.
 */
function writeEngine(d: IsolatedDaemon, runs: string): void {
  const runner = `
if (process.env.TMUX_PANE && !process.argv.slice(2).some((arg) => ['--version', '-v', '--help', '-h'].includes(arg))) {
  const fs = process.getBuiltinModule('node:fs'), { join } = process.getBuiltinModule('node:path'), { spawn } = process.getBuiltinModule('node:child_process')
  const runs = ${JSON.stringify(runs)}
  const done = (base, code) => { fs.writeFileSync(base + '.exit', String(code)); fs.renameSync(base + '.exit', base + '.code') }
  setInterval(() => {
    let names = []
    try { names = fs.readdirSync(runs).filter((name) => name.endsWith('.json')) } catch { return }
    for (const name of names) {
      const base = join(runs, name.slice(0, -'.json'.length))
      let request
      try { request = JSON.parse(fs.readFileSync(base + '.json', 'utf8')) } catch { continue }
      if (request.pane !== process.env.TMUX_PANE) continue
      try { fs.renameSync(base + '.json', base + '.taken') } catch { continue }
      const out = fs.openSync(base + '.out', 'w'), err = fs.openSync(base + '.err', 'w')
      const child = spawn(process.execPath, [...${JSON.stringify(CLI_ENTRY)}, 'browser', ...request.args],
        { cwd: ${JSON.stringify(CLI_ROOT)}, env: process.env, stdio: ['ignore', out, err] })
      fs.closeSync(out)
      fs.closeSync(err)
      child.on('error', () => done(base, -1))
      child.on('exit', (code, signal) => done(base, code ?? signal))
    }
  }, 100).unref()
}
`
  writeFileSync(join(d.root, 'bin', 'claude'), fakeEngineShim('claude', { ...d.engineConfig }) + runner, { mode: 0o755 })
}

/** The default connection's name, as `podman system connection list` shows it. */
async function defaultConnection(): Promise<string> {
  const listed = await run(realPodman!, ['system', 'connection', 'list', '--format', 'json'], 10_000)
  return (JSON.parse(listed.stdout || '[]') as Array<{ Name: string; Default: boolean }>).find((one) => one.Default)?.Name ?? ''
}

interface Seen { path: string; query: URLSearchParams; address: string; port: number; cookie: string }

const PAGES: Record<string, string> = {
  '/form': '<button onclick="document.getElementById(\'f\').hidden = false">Open form</button>'
    + '<form id="f" action="/submitted" hidden><label>Name <input name="name"></label></form>',
  '/submitted': '<p>Thanks</p>',
  // PerimeterX draws its challenge into the page (challenge.mjs CHALLENGE_ELEMENTS): no outside service needed.
  '/challenge': '<div id="px-captcha" style="width:300px;height:80px;background:#ddd">Press and hold</div>',
  '/set-cookie': '<p>Cookie set</p>',
  '/cookie': '<p>Cookie read</p>',
  '/addr': '<p>Your address</p>',
  // The tab's size and the screen's, in its title, which `navigate` prints (the window case).
  '/window': '<script>document.title = `inner ${innerWidth}x${innerHeight} screen ${screen.width}x${screen.height}`</script>',
  // Each `host:port` in `targets`, by fetch and by WebSocket: reached only when the canary itself answered.
  '/probe': '<script>'
    + 'const targets = new URLSearchParams(location.search).get("targets").split(",");'
    + 'const fetched = (t) => fetch("http://" + t + "/", { cache: "no-store" }).then((r) => r.text()).then((b) => b === "canary" ? "reached" : "failed", () => "failed");'
    + 'const opened = (t) => new Promise((done) => { const ws = new WebSocket("ws://" + t + "/");'
    + ' ws.onopen = () => { ws.close(); done("reached") }; ws.onerror = () => done("failed"); setTimeout(() => done("timeout"), 15000) });'
    + 'Promise.all(targets.map(async (t) => [t, await fetched(t), await opened(t)]))'
    + '.then((r) => fetch("/probe-report?" + new URLSearchParams({ r: JSON.stringify(r) })))'
    + '</script>',
  '/probe-report': '',
  // A different colour in every pixel of the viewport (the stream case).
  '/noise': '<canvas id="c" style="position:fixed;inset:0"></canvas><script>'
    + 'const c = document.getElementById("c"); c.width = innerWidth; c.height = innerHeight;'
    + 'const g = c.getContext("2d"); const image = g.createImageData(c.width, c.height);'
    + 'for (let i = 0; i < image.data.length; i++) image.data[i] = i % 4 === 3 ? 255 : Math.random() * 256;'
    + 'g.putImageData(image, 0, 0)'
    + '</script>',
}

/** The pages the browser opens, and every request they were asked, with where it came from. */
/**
 * Listens on every address, and answers how to stop: every socket it took is destroyed first, the upgraded and CONNECT
 * ones too. `closeAllConnections` leaves those, and `server.close` waits for them: through gvproxy, a container's end of
 * one may never close once the container is gone (the clean-up hung its 10 minutes on macOS, 2026-11-10).
 */
async function listen(server: http.Server): Promise<{ port: number; stop: () => Promise<void> }> {
  const sockets = new Set<Socket>()
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '0.0.0.0', () => done()) })
  return {
    port: (server.address() as AddressInfo).port,
    stop: () => {
      for (const socket of sockets) socket.destroy()
      return new Promise((done) => server.close(() => done()))
    },
  }
}

class Pages {
  private constructor(readonly stop: () => Promise<void>, readonly port: number, readonly seen: Seen[]) {}

  /**
   * On every address: the browser reaches this machine at its own network address (PAGES_HOST), never its loopback or
   * host.containers.internal, which the relay refuses; curl in the container still uses that name. Only for this run.
   */
  static async start(): Promise<Pages> {
    const seen: Seen[] = []
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://pages')
      seen.push({ path: url.pathname, query: url.searchParams, address: req.socket.remoteAddress ?? '', port: req.socket.remotePort ?? 0, cookie: req.headers.cookie ?? '' })
      const body = PAGES[url.pathname]
      if (body === undefined) return void res.writeHead(404, { 'cache-control': 'no-store' }).end()
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // Persistent, so Chrome writes it to the profile on the volume; a session cookie would not outlive the browser.
        ...(url.pathname === '/set-cookie' ? { 'set-cookie': 'harness_e2e=kept; Max-Age=86400; Path=/' } : {}),
      })
      res.end(`<!doctype html><meta charset="utf-8"><title>${url.pathname}</title>${body}`)
    })
    const { port, stop } = await listen(server)
    return new Pages(stop, port, seen)
  }

  url(path: string): string { return `http://${PAGES_HOST}:${this.port}${path}` }
}

/**
 * An HTTP proxy with a login, as a person's would be. It carries plain requests to the pages only, and records the
 * local port of each connection it opened to them, so the pages can tell a request that came through it from one that
 * did not. It answers the relay's start probe (proxy-relay.mjs) itself, so the run needs no outside service.
 */
class LoginProxy {
  readonly upstreamPorts = new Set<number>()
  private constructor(readonly stop: () => Promise<void>, readonly port: number) {}

  static async start(pagesPort: number): Promise<LoginProxy> {
    const login = `Basic ${Buffer.from(`${PROXY_LOGIN.username}:${PROXY_LOGIN.password}`).toString('base64')}`
    let proxy: LoginProxy | null = null
    const server = http.createServer((req, res) => {
      if (req.headers['proxy-authorization'] !== login) return void res.writeHead(407, { 'proxy-authenticate': 'Basic realm="e2e"' }).end()
      let url: URL
      try { url = new URL(req.url ?? '') } catch { return void res.writeHead(400).end() }
      if (url.hostname === 'ip-api.com') {
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'success', timezone: 'Asia/Ho_Chi_Minh', query: '203.0.113.7' }))
      }
      // Chrome's own background requests go nowhere: the machine running the test is not the internet.
      if (url.hostname !== PAGES_HOST || Number(url.port) !== pagesPort) return void res.writeHead(403).end()
      const headers = { ...req.headers }
      delete headers['proxy-authorization']
      delete headers['proxy-connection']
      const upstream = http.request({ host: '127.0.0.1', port: pagesPort, method: req.method, path: url.pathname + url.search, headers, agent: false })
      upstream.on('socket', (socket) => socket.once('connect', () => proxy!.upstreamPorts.add(socket.localPort!)))
      upstream.on('response', (answer) => { res.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(res) })
      upstream.on('error', () => res.destroy())
      req.pipe(upstream)
    })
    // Only https goes through CONNECT, and the pages are plain http.
    server.on('connect', (_req, socket: Socket) => { socket.on('error', () => socket.destroy()); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n') })
    const { port, stop } = await listen(server)
    proxy = new LoginProxy(stop, port)
    return proxy
  }
}

/**
 * On every address of this machine: answers `canary` to any page (CORS and Private Network Access allowed, so only the
 * relay can stop it), completes a WebSocket handshake, and records the Host of every request and upgrade it got.
 */
class Canary {
  readonly hosts: string[] = []
  private constructor(readonly stop: () => Promise<void>, readonly port: number) {}

  static async start(): Promise<Canary> {
    let canary: Canary | null = null
    const allow = { 'access-control-allow-origin': '*', 'access-control-allow-private-network': 'true', 'cache-control': 'no-store' }
    const server = http.createServer((req, res) => {
      canary!.hosts.push(req.headers.host ?? '')
      res.writeHead(req.method === 'OPTIONS' ? 204 : 200, allow).end(req.method === 'OPTIONS' ? undefined : 'canary')
    })
    server.on('upgrade', (req, socket: Socket) => {
      canary!.hosts.push(req.headers.host ?? '')
      socket.on('error', () => socket.destroy())
      const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    })
    const { port, stop } = await listen(server)
    canary = new Canary(stop, port)
    return canary
  }
}

/** A stream's bytes from Xvnc, as the Desktop's page reads them: `take(n)` resolves with the next `n`, in order. */
function screenOf(client: LocalClient, streamId: string): (n: number) => Promise<Buffer> {
  let buffered = Buffer.alloc(0)
  let since = client.binaries.length
  return async (n) => {
    while (buffered.length < n) {
      const frame = await client.waitForBinary((f) => f.kind === TerminalBinaryKind.browser && f.streamId === streamId, 30_000, `${n} bytes of the stream`, since)
      since = client.binaries.indexOf(frame) + 1
      buffered = Buffer.concat([buffered, frame.bytes])
    }
    const taken = buffered.subarray(0, n)
    buffered = buffered.subarray(n)
    return taken
  }
}

/** The ref a snapshot gave the element of this role and name (browser-tools-lib.mjs roleSnapshot). */
function refOf(snapshot: string, role: string, name: string): string {
  const line = snapshot.split('\n').find((entry) => entry.includes(`${role} "${name}"`) && /\[ref=e\d+\]/.test(entry))
  if (!line) throw new Error(`no ${role} "${name}" with a ref in the snapshot:\n${snapshot}`)
  return /\[ref=(e\d+)\]/.exec(line)![1]
}

describe('the agent browser on real Podman', () => {
  let store: Store | undefined
  /** The store answered as the one this file made: only then is everything in it this run's to remove. */
  let isolated = false
  let d: IsolatedDaemon | undefined
  let client: LocalClient | undefined
  let pages: Pages | undefined
  let proxy: LoginProxy | undefined
  let canary: Canary | undefined
  let agent: Record<string, any> | undefined
  let broken: string | null = null
  /** macOS: the person's default connection before the run, which must be theirs after it. */
  let personsConnection = ''
  /** Reusing the person's machine: the image this run built, which the clean-up removes; null when it was there. */
  let builtImage: string | null = null

  /** The last `harness browser` the agent ran, and what it said: a failing case's evidence. */
  let lastCommand = ''
  let commands = 0

  const podman = (args: string[], timeoutMs = 60_000, input?: string) => run(realPodman!, [...store!.flags, ...args], timeoutMs, input)
  const name = () => `harness-browser-${agent!.id}`
  const inside = (cmd: string[]) => podman(['exec', name(), ...cmd])
  const row = async () => (await client!.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true })).agents
    .find((listed) => listed.id === agent!.id)

  async function exists(kind: 'container' | 'volume' | 'network' | 'secret', named: string): Promise<boolean> {
    const answer = await podman([kind, 'exists', named])
    if (answer.code === 0 || answer.code === 1) return answer.code === 0
    throw new Error(`podman ${kind} exists ${named} failed (${answer.code}): ${answer.stderr}`)
  }

  /** The agent's container, by kind: a volume and a network carry the same name. */
  async function container(): Promise<{ id: string; startedAt: string } | null> {
    const answer = await podman(['container', 'inspect', name()])
    if (answer.code !== 0) return null
    const [found] = JSON.parse(answer.stdout) as Array<{ Id: string; State: { StartedAt: string } }>
    return { id: found.Id, startedAt: found.State.StartedAt }
  }

  /**
   * Waits for the frame to say ready or failed, and requires ready: a failed browser stays failed until a retry.
   * `fresh`: the container must be a new one (or started again) first, or the frame's ready may be the old browser's.
   */
  async function settled(what: string, ms: number, fresh?: (found: { id: string; startedAt: string }) => boolean): Promise<void> {
    const browser = await until(what, async () => {
      // The container first: the frame says starting before Podman makes or starts it, so a ready read after is its own.
      if (fresh) {
        const found = await container()
        if (!found || !fresh(found)) return null
      }
      const shown = (await row())?.browser
      return shown && (shown.state === 'ready' || shown.state === 'failed') ? shown : null
    }, ms, 500)
    expect(browser, JSON.stringify(browser)).toEqual({ state: 'ready' })
  }

  async function saveSettings(change: Record<string, unknown>): Promise<void> {
    const current = await client!.request('agent_browser_settings', { agentId: agent!.id })
    expect(current.error, JSON.stringify(current)).toBeUndefined()
    const saved = await client!.request('agent_browser_settings_save', { agentId: agent!.id, settings: { ...current, ...change } })
    expect(saved.error, JSON.stringify(saved)).toBeUndefined()
  }

  const runs = () => join(d!.root, 'browser-runs')

  /**
   * `harness browser <args>` in the agent's pane, run by its engine (writeEngine): its exit code and what it printed. The
   * agent's pane is read again each time, as an agent's stop and resume may give it another.
   */
  async function browser(args: string[], ms = CALL_MS): Promise<Ran> {
    const live = await until('the agent to be active in a pane', async () => {
      const found = await row()
      return found?.status === 'active' && found.tmuxPane ? found : null
    }, 60_000, 500)
    const base = join(runs(), String(++commands))
    writeFileSync(`${base}.request`, JSON.stringify({ pane: String(live.tmuxPane), args }))
    renameSync(`${base}.request`, `${base}.json`)
    const code = await until(`harness browser ${args[0]} to exit`, () => readFileSync(`${base}.code`, 'utf8'), ms, 100)
    const ran = { code: /^\d+$/.test(code) ? Number(code) : -1, stdout: readFileSync(`${base}.out`, 'utf8'), stderr: readFileSync(`${base}.err`, 'utf8') }
    // Its command's name only, as the daemon logs it: the rest can be a page's words.
    lastCommand = `harness browser ${args[0]}: exit ${code}\n${ran.stderr.slice(-2000)}`
    return ran
  }

  /** Whether the tool server runs in the container: the daemon starts it at the first command after a Start. */
  const toolServerRuns = async () => (await inside(['pgrep', '-f', '--', TOOL_SERVER[1]!])).code === 0

  /** What a failing case leaves to read: the daemon's log, the last command's, and the browser's own logs in its container. */
  async function evidence(): Promise<void> {
    if (d) console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`)
    if (lastCommand) console.log(`---- the last command\n${lastCommand}`)
    if (!agent || !store) return
    const logs = await podman(['logs', '--tail', '200', name()])
    const own = await inside(['sh', '-c', 'tail -n 80 /tmp/chrome.log /tmp/xvnc.log /tmp/proxy-relay.log /tmp/device.log 2>/dev/null; true'])
    const text = `---- podman logs\n${logs.stdout}${logs.stderr}\n---- the container's own logs\n${own.stdout}${own.stderr}\n`
    artifactLog('browser-container.log', text)
    console.log(text.slice(-6000))
  }

  /** A case of the run: skipped with the reason when Podman is not here, or when an earlier case failed. */
  const step = (title: string, timeout: number, body: () => Promise<void>) => it(title, async (ctx) => {
    ctx.skip(SKIP !== null, SKIP ?? undefined)
    ctx.skip(broken !== null, `an earlier case failed: ${broken}`)
    onTestFailed(async () => {
      broken ??= title
      await evidence()
    })
    await body()
  }, timeout)

  /**
   * Whatever the cases left, by this daemon's label (containers.ts labels its containers, volumes and networks), its
   * agent's secret by name, and the images in the store; then the store itself. Run however the cases ended.
   */
  async function sweep(): Promise<void> {
    const lines = (answer: Ran) => [...new Set(answer.stdout.split('\n').map((line) => line.trim()).filter(Boolean))]
    const left: string[] = []
    if (d) {
      const label = `label=harness.daemon=${daemonIdOf(d.dataDir)}`
      for (const [kind, list, remove] of [
        ['container', ['ps', '-a', '-q', '--filter', label], ['rm', '--force', '--time', '0']],
        ['network', ['network', 'ls', '-q', '--filter', label], ['network', 'rm', '--force']],
        ['volume', ['volume', 'ls', '-q', '--filter', label], ['volume', 'rm', '--force']],
      ] as const) {
        const found = lines(await podman([...list]))
        if (found.length === 0) continue
        left.push(`${found.length} ${kind}(s)`)
        const removed = await podman([...remove, ...found], 120_000)
        if (removed.code !== 0) console.log(`agent browser e2e: ${kind}s not removed: ${removed.stderr}`)
      }
    }
    if (agent && await exists('secret', `harness-proxy-${agent.id}`).catch(() => false)) {
      left.push('the proxy secret')
      await podman(['secret', 'rm', `harness-proxy-${agent.id}`])
    }
    if (isolated) {
      // Every image in this store was built or pulled by this run: the browser's, its base and the build's layers.
      const images = lines(await podman(['images', '-a', '-q']))
      if (images.length > 0) await podman(['rmi', '--force', ...images], 300_000)
    } else if (builtImage) {
      // Never forced: Podman refuses an image a container uses, and the layers the person's image shares stay its own.
      const removed = await podman(['rmi', builtImage], 120_000)
      if (removed.code !== 0) console.log(`agent browser e2e: the image ${builtImage} was not removed: ${removed.stderr}`)
    }
    if (left.length > 0) console.log(`agent browser e2e: removed what the run left in Podman: ${left.join(', ')}`)
    if (process.platform === 'darwin') return REUSE ? await leaveMachine() : await removeMachine()
    // The daemon's `podman events` and its tool servers' `podman exec` start in process groups of their own, so a core that
    // died hard leaves them running. Every one names this store on its command line, and nothing else does.
    await run('pkill', ['-KILL', '-f', '--', store!.dir!], 10_000)
    // The store's files belong to the user namespace's subordinate ids: only inside it can they be removed.
    const gone = await run(realPodman!, ['unshare', 'rm', '-rf', store!.dir!], 120_000)
    if (gone.code !== 0) throw new Error(`the Podman store ${store!.dir} was not removed: ${gone.stderr}`)
  }

  /** macOS: Harness's own machine, with the images in it. None of that name was here before the run (unavailable). */
  async function removeMachine(): Promise<void> {
    // As on Linux, the daemon's `podman events` and its tool servers' `podman exec` can outlive a core that died hard; each
    // names the connection on its command line.
    await run('pkill', ['-KILL', '-f', '--', `--connection ${OWN_MACHINE} `], 10_000)
    await run(realPodman!, ['machine', 'stop', OWN_MACHINE], 120_000)
    const removed = await run(realPodman!, ['machine', 'rm', '--force', OWN_MACHINE], 120_000)
    const listed = await run(realPodman!, ['machine', 'list', '--format', 'json'], 10_000)
    if ((JSON.parse(listed.stdout || '[]') as Array<{ Name: string }>).some((machine) => machine.Name === OWN_MACHINE)) {
      throw new Error(`the Podman machine ${OWN_MACHINE} was not removed: ${removed.stderr}`)
    }
    const connection = await defaultConnection()
    if (connection !== personsConnection) throw new Error(`the default connection is ${connection}, not ${personsConnection} as before the run`)
  }

  /**
   * macOS, on the person's machine used as it is: only this run's processes end, and the machine runs on as it did, on
   * their default connection, with no machine command refused along the way.
   */
  async function leaveMachine(): Promise<void> {
    // As removeMachine, for a core that died hard: the run's `podman events` names its daemon's label and each exec its
    // agent's container. The person's daemon on the same connection names neither.
    if (d) await run('pkill', ['-KILL', '-f', '--', `label=harness.daemon=${daemonIdOf(d.dataDir)}`], 10_000)
    if (agent) await run('pkill', ['-KILL', '-f', '--', `harness-browser-${agent.id} `], 10_000)
    const listed = await run(realPodman!, ['machine', 'list', '--format', 'json'], 10_000)
    if (!(JSON.parse(listed.stdout || '[]') as Array<{ Name: string; Running: boolean }>).some((machine) => machine.Name === OWN_MACHINE && machine.Running)) {
      throw new Error(`the Podman machine ${OWN_MACHINE} no longer runs: ${listed.stdout}${listed.stderr}`)
    }
    const connection = await defaultConnection()
    if (connection !== personsConnection) throw new Error(`the default connection is ${connection}, not ${personsConnection} as before the run`)
    if (d && existsSync(refusedLog(d))) throw new Error(`the wrapper refused, on the person's machine:\n${readFileSync(refusedLog(d), 'utf8')}`)
  }

  /**
   * On the person's machine, which keeps an older harness-browser image for their own browsers: the daemon would run
   * that at once and build this CLI's in the background (image.ts ensureImage), so the cases would drive the older
   * browser. This CLI's is built first, as image.ts builds it. Answers the tag when this run built it.
   */
  async function buildOwnImage(): Promise<string | null> {
    const tag = imageTag(browserAssetsHash(), new Date())
    if ((await podman(['image', 'exists', `localhost/${tag}`])).code === 0) return null
    const dir = mkdtempSync(join(tmpdir(), 'hb-image-'))
    try {
      for (const [file, content] of Object.entries(browserContextFiles())) writeFileSync(join(dir, file), content)
      const built = await podman(['build', '-t', tag, dir], BUILD_MS)
      expect(built.code, `${built.stdout.slice(-4000)}\n${built.stderr.slice(-2000)}`).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    return tag
  }

  /**
   * macOS, as a person whose machine will not start: the browser waits for setup, availability says Harness will make
   * its own, and Install (`agent_browser_setup`) makes it. Answers when Install was pressed.
   */
  async function installOwnMachine(): Promise<number> {
    await until('the browser to need setup', async () => (await row())?.browser?.error === 'needs_setup' || null, 60_000, 500)
    expect(await client!.request('agent_browser_available', {})).toMatchObject({ state: 'needs_setup', ownMachine: true })
    const pressed = Date.now()
    expect(await client!.request('agent_browser_setup', {})).toMatchObject({ ok: true })
    // Until setup's first step, the frame still says needs_setup: a wait for ready or failed would read that.
    await until('setup to start', async () => (await row())?.browser?.state === 'setup' || null, 30_000, 250)
    return pressed
  }

  beforeAll(async () => {
    if (SKIP) return
    if (process.platform === 'darwin') {
      store = { flags: ['--connection', OWN_MACHINE] }
      personsConnection = await defaultConnection()
    } else {
      // Short, under the system's temp folder: Podman keeps sockets under the run root.
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hb-podman-')))
      store = { dir, flags: ['--root', join(dir, 'root'), '--runroot', join(dir, 'run')] }
      const info = await podman(['info', '--format', 'json'])
      expect(info.code, info.stderr).toBe(0)
      expect((JSON.parse(info.stdout) as { store: { graphRoot: string } }).store.graphRoot).toBe(join(dir, 'root'))
    }
    // macOS: unavailable() found no machine of its name, so the one the run makes, and all in it, is the run's. A
    // person's machine used as it is holds their own.
    isolated = !REUSE
    pages = await Pages.start()
    d = await IsolatedDaemon.create()
    if (REUSE) onOwnMachine(d)
    writePodman(d, store)
    mkdirSync(runs(), { recursive: true })
    writeEngine(d, runs())
    await d.start()
    client = await LocalClient.connect(d)
  }, 120_000)

  afterAll(async () => {
    if (SKIP) return
    client?.close()
    // Its own errors (hooks outside the root) are kept for after the clean-up, which must run regardless.
    const closed = await d?.close().then(() => null, (error: unknown) => error)
    await proxy?.stop()
    await canary?.stop()
    await pages?.stop()
    if (store) await sweep()
    if (closed) throw closed
  }, 600_000)

  step('builds the image, and a plain agent\'s browser, started by its person, is ready with no published port', MACHINE_MS + BUILD_MS + (REUSE ? BUILD_MS : 0) + 120_000, async () => {
    const cwd = join(d!.projectsDir, 'with-browser')
    mkdirSync(cwd, { recursive: true })
    // As the Desktop's panel asks before its Start: a stopped machine is one Harness starts, so it goes on; the
    // person's running one is ready.
    if (process.platform === 'darwin') expect(await client!.request('agent_browser_available', {})).toMatchObject({ state: REUSE ? 'ready' : 'stopped' })
    if (REUSE) builtImage = await buildOwnImage()
    // A plain agent: New agent sends no `browser`.
    const created = await client!.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    agent = created.agent as Record<string, any>
    await until('the agent to bind its conversation', async () => (await row())?.sessionId || null, 60_000, 500)
    expect((await row())?.browser).toBeUndefined()
    // The person's Start, in the agent's chat.
    expect(await client!.request('agent_browser_start', { agentId: agent.id }, 60_000)).toMatchObject({ ok: true })
    const install = process.platform === 'darwin' && !REUSE
    const pressed = install ? await installOwnMachine() : Date.now()
    await settled('the image to build and the browser to be ready', MACHINE_MS + BUILD_MS)
    console.log(`agent browser e2e: ready ${Math.round((Date.now() - pressed) / 1000)} s after ${install ? 'Install' : 'Start'}`)
    if (process.platform === 'darwin') expect(await defaultConnection()).toBe(personsConnection)
    // Only `podman exec` reaches the browser (spec § The container).
    const ports = await podman(['container', 'port', name()])
    expect(ports.code, ports.stderr).toBe(0)
    expect(ports.stdout.trim()).toBe('')
  })

  step('harness browser start and stop exit 2, and the browser runs on as it was', 2 * CALL_MS, async () => {
    const before = await container()
    expect(before).not.toBeNull()
    for (const word of ['start', 'stop']) {
      const answered = await browser([word])
      expect(answered.code, `${word}: ${answered.stderr}`).toBe(2)
      expect(answered.stderr.trim()).toBe(START_STOP_LINE)
      expect(answered.stdout).toBe('')
    }
    expect(await container()).toEqual(before)
    expect((await row())?.browser).toEqual({ state: 'ready' })
  })

  step('the person\'s Stop during a wait ends that command with the stop line', CALL_MS + 60_000, async () => {
    // No command reached this browser since its Start, so a tool server in its container is the wait's own.
    expect(await toolServerRuns()).toBe(false)
    const waiting = browser(['wait', NEVER_SHOWN])
    await until('the wait to reach the tool server', () => toolServerRuns(), 20_000, 100)
    expect(await client!.request('agent_browser_stop', { agentId: agent!.id }, 60_000)).toMatchObject({ ok: true })
    const ended = await waiting
    expect(ended.code, ended.stderr).toBe(4)
    expect(ended.stderr.trim()).toBe(STOP_LINE)
    expect(ended.stdout).toBe('')
    await until('the frame to drop its browser', async () => (await row())?.browser === undefined || null, 30_000, 250)
  })

  step('a command while off exits 4 with the off line, until the person\'s Start', START_MS + 2 * CALL_MS, async () => {
    // The Stop drops the browser from the frame at once; its container goes once Chrome has closed and written the
    // profile (entrypoint.sh, inside Podman's 10 s), seconds later on a Podman machine.
    await until('the stopped browser\'s container to go', async () => (await container()) === null || null, 60_000, 500)
    const off = await browser(['snapshot'])
    expect(off.code, off.stderr).toBe(4)
    expect(off.stderr.trim()).toBe(OFF_LINE)
    expect(off.stdout).toBe('')
    // A command never starts a browser.
    expect(await container()).toBeNull()
    expect(await client!.request('agent_browser_start', { agentId: agent!.id }, 60_000)).toMatchObject({ ok: true })
    await settled('the browser to be ready after the Start', START_MS, () => true)
    const on = await browser(['snapshot'])
    expect(on.code, on.stderr).toBe(0)
  })

  step('the agent\'s commands drive it: navigate, snapshot, click by ref, type, screenshot to a file', 6 * CALL_MS, async () => {
    const opened = await browser(['navigate', pages!.url('/form')])
    expect(opened.code, opened.stderr).toBe(0)
    expect(opened.stdout).toContain('/form')
    // The form is hidden until the button is clicked: its textbox in the second snapshot is the click's doing.
    const button = refOf((await browser(['snapshot'])).stdout, 'button', 'Open form')
    const clicked = await browser(['click', button])
    expect(clicked.code, clicked.stderr).toBe(0)
    expect(clicked.stdout.trim()).toBe('Clicked')
    const box = refOf((await browser(['snapshot'])).stdout, 'textbox', 'Name')
    const typed = await browser(['type', box, TYPED, '--submit'])
    expect(typed.code, typed.stderr).toBe(0)
    const submitted = await until('the typed form to reach the page server', () => pages!.seen.find((seen) => seen.path === '/submitted'), 30_000)
    expect(submitted.query.get('name')).toBe(TYPED)
    // Only the file's path on the terminal; the agent reads the JPEG with its own file tool.
    const shot = await browser(['screenshot'])
    expect(shot.code, shot.stderr).toBe(0)
    const file = shot.stdout.trim()
    expect(file.split('\n')).toHaveLength(1)
    expect(isAbsolute(file), file).toBe(true)
    expect([...readFileSync(file).subarray(0, 2)]).toEqual([0xff, 0xd8])
  })

  step('a page that asks for a person: the output names the challenge and tells the agent to ask in chat', CALL_MS, async () => {
    const reply = await browser(['navigate', pages!.url('/challenge')])
    expect(reply.code, reply.stderr).toBe(0)
    expect(reply.stdout).toContain('challenge: perimeterx')
    expect(reply.stdout).toContain(CHAT_LINE)
  })

  step('the tool server calls initialize an unknown method', 60_000, async () => {
    // A `browser-mcp` relay still running in an agent launched before speaks MCP to it: its handshake, listing and ping
    // are no longer answered (Task 9).
    const asked = ['initialize', 'tools/list', 'ping'].map((method, n) => JSON.stringify({ jsonrpc: '2.0', id: n + 1, method, params: {} })).join('\n')
    const answered = await podman(['exec', '-i', name(), ...TOOL_SERVER], 30_000, `${asked}\n`)
    // Its input closed, it exits by itself.
    expect(answered.code, answered.stderr).toBe(0)
    const replies = answered.stdout.trim().split('\n').map((line) => JSON.parse(line) as { id: number }).sort((a, b) => a.id - b.id)
    expect(replies).toEqual(['initialize', 'tools/list', 'ping'].map((method, n) => ({ jsonrpc: '2.0', id: n + 1, error: { code: -32601, message: `Unknown method ${method}` } })))
  })

  step('a stream opened as the Desktop opens one: the banner, a handshake, the local profile at Xvnc, and a close that ends the exec', 2 * CALL_MS, async () => {
    // Xvnc sends a full-colour rectangle as Tight JPEG only when the viewer set a quality level. This viewer sets none,
    // so a JPEG rectangle is the shaper's level (q6/c2 for a local connection, services/agentBrowser/streams.ts) reaching Xvnc.
    const noise = await browser(['navigate', pages!.url('/noise')])
    expect(noise.code, noise.stderr).toBe(0)
    const opened = await client!.request<{ streamId?: string; error?: string }>('agent_browser_open', { agentId: agent!.id })
    expect(opened.error, JSON.stringify(opened)).toBeUndefined()
    const streamId = opened.streamId!
    const take = screenOf(client!, streamId)
    let seq = 0
    const send = (...bytes: number[]) => client!.sendBinary({ kind: TerminalBinaryKind.browser, streamId, seq: seq++, bytes: Uint8Array.from(bytes), compressed: false })
    const u16 = (value: number) => [value >> 8, value & 0xff]

    expect((await take(12)).toString('latin1')).toBe('RFB 003.008\n')
    send(...Buffer.from('RFB 003.008\n', 'latin1'))
    // RFB 3.8 (RFC 6143 § 7.1-7.3): the security types, None chosen, its result, then a shared ClientInit.
    const types = await take((await take(1))[0])
    expect([...types]).toContain(1)
    send(1)
    expect((await take(4)).readUInt32BE(0)).toBe(0)
    send(1)
    const init = await take(24)
    await take(init.readUInt32BE(20))
    const [width, height] = [init.readUInt16BE(0), init.readUInt16BE(2)]
    // The middle of the screen, inside the page: 64 × 64.
    const middle = [...u16(width / 2 - 32), ...u16(height / 2 - 32), ...u16(64), ...u16(64)]
    // First Raw (0) alone, until that middle shows the page's noise: the browser paints it some time after the
    // navigation answers, and before it does the area is plain, which Tight sends as a fill, not JPEG (measured on the
    // M2 Mac). Raw's pixels need no decoder to read.
    send(2, 0, ...u16(1), 0, 0, 0, 0)
    let colours = 0
    const deadline = Date.now() + 30_000
    while (colours < 1_000 && Date.now() < deadline) {
      send(3, 0, ...middle)
      const update = await take(4)
      expect(update[0], 'a FramebufferUpdate').toBe(0)
      const seen = new Set<number>()
      for (let rects = update.readUInt16BE(2); rects > 0; rects--) {
        const rect = await take(12)
        expect(rect.readInt32BE(8), 'Raw').toBe(0)
        const pixels = await take(rect.readUInt16BE(4) * rect.readUInt16BE(6) * 4)
        for (let at = 0; at < pixels.length; at += 4) seen.add(pixels.readUInt32LE(at))
      }
      colours = seen.size
      if (colours < 1_000) await new Promise((done) => setTimeout(done, 250))
    }
    expect(colours, 'colours in the middle of the page').toBeGreaterThanOrEqual(1_000)
    // Then Tight (7) alone, and the same area again.
    send(2, 0, ...u16(1), 0, 0, 0, 7)
    send(3, 0, ...middle)
    const update = await take(4)
    expect(update[0], 'a FramebufferUpdate').toBe(0)
    expect(update.readUInt16BE(2)).toBeGreaterThan(0)
    const rect = await take(13)
    expect(rect.readInt32BE(8), 'Tight').toBe(7)
    // The compression-control byte's high nibble: 9 is JPEG (RFC 6143 § 7.7.6).
    expect(rect[12] >> 4, 'a JPEG rectangle').toBe(9)

    const closed = client!.next((frame) => frame.type === 'agent_browser_close' && frame.payload?.streamId === streamId, 10_000, 'agent_browser_close')
    client!.send('agent_browser_close', { streamId })
    expect((await closed).payload?.reason).toBe('closed')
    // The daemon's `podman exec` and the socat it ran in the container both go.
    await until('the stream\'s exec to end', async () => {
      const host = await run('pgrep', ['-f', '--', `${name()} socat STDIO`], 10_000)
      const container = await inside(['pgrep', '-f', '--', 'socat STDIO'])
      return (host.code === 1 && container.code === 1) || null
    }, 30_000, 250)
  })

  step('a window request changes window.innerWidth and leaves screen.width as the Device setting', 6 * CALL_MS, async () => {
    // Inside every screen the Device setting offers, and over the smallest window (1024x640): set as asked.
    const asked = { width: 1100, height: 700 }
    const { screen } = await client!.request<{ screen?: string }>('agent_browser_settings', { agentId: agent!.id })
    expect(screen).toMatch(/^\d+x\d+$/)
    const read = async () => {
      const shown = await browser(['navigate', pages!.url('/window')])
      expect(shown.code, shown.stderr).toBe(0)
      const [, innerWidth, screenSize] = /inner (\d+)x\d+ screen (\d+x\d+)/.exec(shown.stdout) ?? []
      expect(innerWidth, shown.stdout).toBeDefined()
      return { innerWidth: Number(innerWidth), screen: screenSize }
    }
    const before = await read()
    expect(before.innerWidth, 'the window before the request').toBeGreaterThan(asked.width)
    expect(before.screen).toBe(screen)
    expect(await client!.request('agent_browser_window', { agentId: agent!.id, ...asked }, 30_000)).toMatchObject(asked)
    // Read again by a fresh navigation, until the page lays out in the new window.
    const after = await until('the page to lay out in the window asked for', async () => {
      const now = await read()
      return now.innerWidth <= asked.width ? now : null
    }, 4 * CALL_MS, 500)
    expect(after.screen).toBe(screen)
  })

  step('the daemon\'s loopback API refuses a request from inside the container', 60_000, async () => {
    const status = (url: string) => inside(['sh', '-c', `curl -s -o /dev/null -w '%{http_code}' --max-time 5 ${quote(url)}; true`])
    // The container does reach this machine, so a refusal below is the daemon's, not a missing route.
    expect((await status(pages!.url('/addr'))).stdout).toBe('200')
    const daemon = await status(`http://${HOST}:${d!.port}/api/status`)
    expect(daemon.stdout, daemon.stderr).not.toMatch(/^2/)
  })

  step('a page cannot reach the host, gvproxy or the container\'s gateway, by fetch or WebSocket, and a public page loads', 3 * CALL_MS, async () => {
    // With no proxy, every request still goes through the relay (proxy-relay.mjs), which refuses these.
    const shown = await browser(['navigate', 'https://example.com/'])
    expect(shown.code, shown.stderr).toBe(0)
    expect((await browser(['snapshot'])).stdout).toContain('Example Domain')

    canary = await Canary.start()
    const route = await inside(['cat', '/proc/net/route'])
    expect(route.code, route.stderr).toBe(0)
    // The default route's gateway, little-endian hex.
    const hex = route.stdout.split('\n').map((line) => line.trim().split(/\s+/)).find((cols) => cols[1] === '00000000')?.[2]
    expect(hex, route.stdout).toMatch(/^[0-9A-F]{8}$/)
    const gateway = [...Buffer.from(hex!, 'hex').reverse()].join('.')
    // 192.168.127.254 is the Mac's own loopback on a Podman machine, and 192.168.127.1:80 gvproxy's control API.
    const refused = [`192.168.127.254:${canary.port}`, '192.168.127.1:80', `${HOST}:${canary.port}`, `${gateway}:${canary.port}`]
    // The same probe to this machine's own network address reaches the canary, so a failure above is the relay's.
    const allowed = `${PAGES_HOST}:${canary.port}`
    const from = pages!.seen.length
    const probed = await browser(['navigate', pages!.url(`/probe?targets=${[...refused, allowed].join(',')}`)])
    expect(probed.code, probed.stderr).toBe(0)
    const report = await until('the probe to report', () => pages!.seen.slice(from).find((seen) => seen.path === '/probe-report'), 60_000, 250)
    expect(JSON.parse(report.query.get('r') ?? '[]')).toEqual([
      ...refused.map((target) => [target, 'failed', 'failed']),
      [allowed, 'reached', 'reached'],
    ])
    expect([...new Set(canary.hosts)]).toEqual([allowed])
    // One line for each refusal, by category, never the destination.
    const log = (await inside(['cat', '/tmp/proxy-relay.log'])).stdout
    for (const category of ['gvproxy', 'host name', 'container network']) expect(log).toContain(`proxy relay: refused a ${category} destination`)
    for (const leak of [HOST, gateway, '192.168.127', String(canary.port)]) expect(log).not.toContain(leak)
  })

  step('the agent\'s stop then resume keeps the login: its browser follows it back, and a cookie set before is sent after', START_MS + 4 * CALL_MS, async () => {
    const set = await browser(['navigate', pages!.url('/set-cookie')])
    expect(set.code, set.stderr).toBe(0)
    // A turn first, as every agent a person stops has had (core.e2e.ts does the same): until one ends, the fake engine's
    // conversation has no opening to keep, and the stop is held (IDENTITY_UNAVAILABLE).
    const ended = client!.next((frame) => frame.type === 'turn_ended' && frame.agentId === agent!.id, 45_000, 'turn_ended')
    client!.send('message', { agentId: agent!.id, content: 'Keep this conversation across the stop' })
    await ended
    const stopped = await client!.request('agent_delete', { agentId: agent!.id }, 60_000)
    expect(stopped.error, JSON.stringify(stopped)).toBeUndefined()
    await until('the agent to stop', async () => (await row())?.status === 'stopped' || null, 60_000, 500)
    // Its container and network go with the stop; the volume, which holds the login, stays.
    await until('its container and network to go', async () => (!(await exists('container', name())) && !(await exists('network', name()))) || null, 60_000, 500)
    expect(await exists('volume', name())).toBe(true)
    // No Start: the browser left on follows its agent back (decision 14).
    expect((await client!.request('agent_resume', { agentId: agent!.id }, 90_000)).error).toBeUndefined()
    await settled('the browser to be ready again after the resume', START_MS, () => true)
    const from = pages!.seen.length
    const read = await browser(['navigate', pages!.url('/cookie')])
    expect(read.code, read.stderr).toBe(0)
    const asked = await until('the page server to be asked for /cookie', () => pages!.seen.slice(from).find((seen) => seen.path === '/cookie'), 30_000)
    expect(asked.cookie).toContain('harness_e2e=kept')
  })

  step('the person\'s Stop then Start keeps the login: a cookie set before the Stop is sent after the Start', START_MS + 4 * CALL_MS, async () => {
    const set = await browser(['navigate', pages!.url('/set-cookie')])
    expect(set.code, set.stderr).toBe(0)
    expect(await client!.request('agent_browser_stop', { agentId: agent!.id }, 60_000)).toMatchObject({ ok: true })
    await until('the frame to drop its browser', async () => (await row())?.browser === undefined || null, 30_000, 250)
    // The agent runs on; its container and network go, and the volume, which holds the login, stays.
    expect((await row())?.status).toBe('active')
    await until('its container and network to go', async () => (!(await exists('container', name())) && !(await exists('network', name()))) || null, 60_000, 500)
    expect(await exists('volume', name())).toBe(true)
    expect(await client!.request('agent_browser_start', { agentId: agent!.id }, 60_000)).toMatchObject({ ok: true })
    await settled('the browser to be ready again after the Start', START_MS, () => true)
    const from = pages!.seen.length
    const read = await browser(['navigate', pages!.url('/cookie')])
    expect(read.code, read.stderr).toBe(0)
    const asked = await until('the page server to be asked for /cookie', () => pages!.seen.slice(from).find((seen) => seen.path === '/cookie'), 30_000)
    expect(asked.cookie).toContain('harness_e2e=kept')
  })

  step('a browser that crashes is started again by the service', START_MS + CALL_MS, async () => {
    const before = await container()
    expect(before).not.toBeNull()
    // Chrome's main process is the oldest with the debugging flag; its renderers do not carry it.
    const killed = await inside(['pkill', '-KILL', '-o', '-f', '--', '--remote-debugging-port=9222'])
    expect(killed.code, killed.stderr).toBe(0)
    await settled('the browser to be started again', START_MS, (found) => found.startedAt !== before!.startedAt)
    const back = await browser(['navigate', pages!.url('/addr?restarted')])
    expect(back.code, back.stderr).toBe(0)
  })

  step('Device: a tab opened without any tool call reports the chosen GPU, cores and memory', START_MS + 2 * 60_000, async () => {
    const before = await container()
    await saveSettings({ device: DEVICE })
    await settled('the browser to be ready with Device on', START_MS, (found) => found.id !== before!.id)
    // Opened through Chrome's own DevTools HTTP endpoint, as a tab the person opens appears: no tool call, so only
    // device-inject.mjs's own connection can set the device. The ready marker waits for it to attach, so the first tab
    // after ready has it. A public HTTPS page: navigator.deviceMemory exists only in a secure context, which a page at
    // this machine's network address is not, the relay refuses the container's own loopback, and a tab opened on
    // about:blank had no deviceMemory on CI (2026-11-10). The proxy case already needs the runner to reach the internet.
    const opened = await inside(['curl', '-sf', '--max-time', '10', '-X', 'PUT', 'http://127.0.0.1:9222/json/new?https://example.com/'])
    expect(opened.code, opened.stderr).toBe(0)
    const { id } = JSON.parse(opened.stdout) as { id: string }
    const read = await inside(['sh', '-c', `cd /opt/harness-browser && timeout 20 node --input-type=module -e ${quote(DEVICE_READ)} ${quote(id)}`])
    expect(read.code, read.stderr).toBe(0)
    // Chrome reports memory rounded down to a power of two, at most 8 (device-inject.mjs).
    expect(JSON.parse(read.stdout.trim())).toEqual({ cores: '12', memory: '4', vendor: DEVICE.gpuVendor, renderer: DEVICE.gpuRenderer })
  })

  step('a proxy with a login carries every request, and one that goes away fails closed', START_MS + 3 * CALL_MS, async () => {
    proxy = await LoginProxy.start(pages!.port)
    const before = await container()
    // A named zone: Auto looks the exit up from this machine, where host.containers.internal is no name.
    await saveSettings({ proxy: { scheme: 'http', host: HOST, port: proxy.port, ...PROXY_LOGIN }, timeZone: 'Asia/Ho_Chi_Minh' })
    await settled('the browser to be ready behind the proxy', START_MS, (found) => found.id !== before!.id)
    expect(await exists('secret', `harness-proxy-${agent!.id}`)).toBe(true)
    // From the new container on: the old one's requests, before it went, were rightly direct.
    const from = pages!.seen.length
    const through = await browser(['navigate', pages!.url('/addr?through')])
    expect(through.code, through.stderr).toBe(0)
    await until('the page to be reached through the proxy', () => pages!.seen.slice(from).find((seen) => seen.query.has('through')), 30_000)
    await proxy.stop()
    // A navigation that fails exits 1 with the tool's words; one Chrome shows as its own error page exits 0.
    const after = await browser(['navigate', pages!.url('/addr?after')])
    const shown = await browser(['snapshot'])
    expect(after.code !== 0 || shown.stdout.includes('the proxy cannot be used'), `${after.stdout}${after.stderr}\n${shown.stdout}`).toBe(true)
    const seen = pages!.seen.slice(from)
    expect(seen.filter((one) => one.query.has('after')).map((one) => one.path)).toEqual([])
    expect(seen.filter((one) => !proxy!.upstreamPorts.has(one.port)).map((one) => `${one.path} from ${one.address}:${one.port}`)).toEqual([])
  })

  step('a delete removes its container, volume, network and proxy secret', 4 * 60_000, async () => {
    const bound = await row()
    expect(bound?.sessionId).toBeTruthy()
    const createdAt = Date.parse(bound!.createdAt ?? agent!.createdAt)
    const review = await client!.request('agent_purge', { agentId: agent!.id, sessionId: bound!.sessionId, createdAt, mode: 'inspect' }, 60_000)
    expect(review.error, JSON.stringify(review)).toBeUndefined()
    const deleted = await client!.request('agent_purge', { agentId: agent!.id, sessionId: bound!.sessionId, createdAt, mode: 'delete', reviewId: review.reviewId }, 90_000)
    expect(deleted, JSON.stringify(deleted)).toMatchObject({ deleted: true })
    const things = [['container', name()], ['volume', name()], ['network', name()], ['secret', `harness-proxy-${agent!.id}`]] as const
    await until('its container, volume, network and secret to be gone', async () => {
      for (const [kind, named] of things) if (await exists(kind, named)) return null
      return true
    }, 60_000, 500)
  })
})
