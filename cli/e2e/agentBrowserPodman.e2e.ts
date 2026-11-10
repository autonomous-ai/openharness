/**
 * The agent browser on real Podman (Task 20 of docs/superpowers/plans/2026-11-10-agent-browser.md): the image built from
 * the CLI's own files, a browser agent's Chrome driven through `harness browser-mcp` as an engine drives it, its screen
 * streamed as the Desktop opens it, a page that asks for a person, a page that cannot reach the host, its login kept across a stop, its restart after a
 * crash, Device, a proxy that fails closed, and a delete that leaves nothing behind. agentBrowser.e2e.ts runs the same daemon against a fake `podman`.
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
 * The nightly suite leaves it out (vitest.e2e.ci.config.ts): the image takes minutes to build. CI runs it on Linux when
 * asked (cli-e2e.yml, `agent_browser_podman`).
 *
 * The cases run in order on one daemon and one agent, each starting where the last left the browser; once one fails,
 * the rest are skipped and say which.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { networkInterfaces, tmpdir, userInfo } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { TerminalBinaryKind } from '../src/lib/terminalBinary.js'
import { daemonIdOf } from '../src/services/agentBrowser.js'
import { artifactLog } from './harness/artifacts.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

// The image build may take its whole 15 minutes (image.ts) on a cold runner, and the browser's start follows it.
const BUILD_MS = 20 * 60_000
// macOS: Harness's own machine first, its init's 10 minutes (setup.ts, most of it the machine image's download) and its
// start.
const MACHINE_MS = process.platform === 'darwin' ? 12 * 60_000 : 0
const OWN_MACHINE = 'harness'
// A container created again (new settings) or started again (after an exit): the ready check's 60 s and the restart's
// backoff, with room.
const START_MS = 3 * 60_000
// A navigation's own 60 s (browser-tools.mjs), plus the relay asking the daemon and starting `podman exec`.
const CALL_MS = 90_000
const TYPED = 'Xin chào 👋'
const DEVICE = { gpuVendor: 'Harness E2E Vendor', gpuRenderer: 'Harness E2E Renderer', cpuCores: 12, memoryGb: 4 }
const PROXY_LOGIN = { username: 'harness-e2e', password: 'e2e-proxy-password' }
const CHAT_LINE = 'This page asks for a person. Tell your person in chat what to do in Browser, wait for their answer, and do not act on the challenge yourself.'
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
  try {
    if (process.platform === 'darwin') {
      const listed = JSON.parse(execFileSync(realPodman, ['machine', 'list', '--format', 'json'], { timeout: 10_000, stdio: 'pipe', env: podmanEnv }).toString()) as Array<{ Name: string; Running: boolean }>
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

/** Never rejects: a command that failed or ran out of time answers its code (-1 when it had none) and what it said. */
function run(file: string, args: string[], timeoutMs: number): Promise<Ran> {
  return new Promise((done) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: podmanEnv }, (error, stdout, stderr) => {
      done({ code: !error ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr: error?.killed ? `timed out after ${timeoutMs} ms` : stderr })
    })
  })
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** Where the daemon looks first (its bin is first on PATH, as agentBrowser.e2e.ts's fake is): the real Podman, in the store. */
function writePodman(d: IsolatedDaemon, store: Store): void {
  const bin = join(d.root, 'bin')
  mkdirSync(bin, { recursive: true })
  if (process.platform !== 'darwin') {
    writeFileSync(join(bin, 'podman'), `#!/bin/sh\nexec ${[realPodman!, ...store.flags].map(quote).join(' ')} "$@"\n`, { mode: 0o755 })
    return
  }
  writeFileSync(join(bin, 'podman'), '#!/bin/sh\n'
    // The daemon names its machine last (setup.ts, podman.ts); every other is the person's, refused as one that fails.
    + `if [ "$1" = machine ] && [ "$2" != list ]; then for last in "$@"; do :; done; [ "$last" = ${OWN_MACHINE} ] || { echo "Error: this test starts or changes no machine but ${OWN_MACHINE}" >&2; exit 125; }; fi\n`
    // The person's HOME, where Podman keeps their machines and connections: the daemon's is the run's own.
    + `HOME=${quote(podmanEnv.HOME!)} exec ${quote(realPodman!)} "$@"\n`, { mode: 0o755 })
  // macOS's /etc/zprofile (path_helper) puts /etc/paths.d, Homebrew's podman among them, ahead of the daemon's PATH in
  // the login shell it asks where podman is (lib/tmuxOnPath.ts): this bin goes first again after it.
  writeFileSync(join(d.env.ZDOTDIR!, '.zprofile'), `path=(${quote(bin)} $path)\n`, { flag: 'a' })
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

type ToolReply = { text: string; isError: boolean; content: Array<Record<string, any>> }

/** `harness browser-mcp` from the agent's pane, as its engine starts it: requests in on stdin, answers by id on stdout. */
class Relay {
  stderr = ''
  private next = 1
  private readonly waiting = new Map<number, { done: (reply: Record<string, any>) => void; fail: (error: Error) => void }>()
  private readonly exited: Promise<void>

  private constructor(private readonly child: ChildProcess) {
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let reply: Record<string, any>
      try { reply = JSON.parse(line) } catch { return }
      this.waiting.get(reply.id)?.done(reply)
    })
    child.stderr!.on('data', (chunk) => { this.stderr += chunk })
    this.exited = new Promise((done) => child.once('exit', (code, signal) => {
      for (const entry of this.waiting.values()) entry.fail(new Error(`harness browser-mcp exited (${signal ?? code}): ${this.stderr.slice(-2000)}`))
      this.waiting.clear()
      done()
    }))
  }

  static async open(d: IsolatedDaemon, pane: string): Promise<Relay> {
    // The run's bundle when there is one (E2E_BUNDLE), as the daemon runs: the build that ships.
    const bundle = process.env.E2E_BUNDLE_PATH
    const child = spawn(process.execPath, [...(bundle ? [bundle] : ['--import', 'tsx', 'src/cli.ts']), 'browser-mcp'], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: pane }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const relay = new Relay(child)
    await relay.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-browser-e2e', version: '1' } }, 30_000)
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    return relay
  }

  request(method: string, params: Record<string, unknown>, ms: number): Promise<Record<string, any>> {
    const id = this.next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`${method} got no answer in ${ms} ms: ${this.stderr.slice(-2000)}`)) }, ms)
      this.waiting.set(id, {
        done: (reply) => { clearTimeout(timer); this.waiting.delete(id); resolve(reply) },
        fail: (error) => { clearTimeout(timer); reject(error) },
      })
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
    const reply = await this.request('tools/call', { name, arguments: args }, CALL_MS)
    const content = (reply.result?.content ?? []) as Array<Record<string, any>>
    return { content, isError: reply.result?.isError === true, text: content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') }
  }

  /** As the engine closes it: stdin ends, and the relay ends its tool server. Killed if it has not gone in 10 s. */
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.child.stdin!.end()
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 10_000)
    await this.exited
    clearTimeout(timer)
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
  let relay: Relay | undefined
  let agent: Record<string, any> | undefined
  let broken: string | null = null
  /** macOS: the person's default connection before the run, which must be theirs after it. */
  let personsConnection = ''

  const podman = (args: string[], timeoutMs = 60_000) => run(realPodman!, [...store!.flags, ...args], timeoutMs)
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

  async function openRelay(): Promise<Relay> {
    const live = await until('the agent to be active in a pane', async () => {
      const found = await row()
      return found?.status === 'active' && found.tmuxPane ? found : null
    }, 60_000, 500)
    relay = await Relay.open(d!, String(live.tmuxPane))
    return relay
  }

  /** What a failing case leaves to read: the daemon's log, the relay's, and the browser's own logs in its container. */
  async function evidence(): Promise<void> {
    if (d) console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`)
    if (relay) console.log(`---- harness browser-mcp stderr\n${relay.stderr.slice(-4000)}`)
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
    }
    if (left.length > 0) console.log(`agent browser e2e: removed what the run left in Podman: ${left.join(', ')}`)
    if (process.platform === 'darwin') return await removeMachine()
    // The daemon's `podman events` and the relay's `podman exec` start in process groups of their own, so a core that
    // died hard leaves them running. Every one names this store on its command line, and nothing else does.
    await run('pkill', ['-KILL', '-f', '--', store!.dir!], 10_000)
    // The store's files belong to the user namespace's subordinate ids: only inside it can they be removed.
    const gone = await run(realPodman!, ['unshare', 'rm', '-rf', store!.dir!], 120_000)
    if (gone.code !== 0) throw new Error(`the Podman store ${store!.dir} was not removed: ${gone.stderr}`)
  }

  /** macOS: Harness's own machine, with the images in it. None of that name was here before the run (unavailable). */
  async function removeMachine(): Promise<void> {
    // As on Linux, the daemon's `podman events` and the relay's `podman exec` can outlive a core that died hard; each
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
    // macOS: unavailable() found no machine of its name, so the one the run makes, and all in it, is the run's.
    isolated = true
    pages = await Pages.start()
    d = await IsolatedDaemon.create()
    writePodman(d, store)
    await d.start()
    client = await LocalClient.connect(d)
  }, 120_000)

  afterAll(async () => {
    if (SKIP) return
    await relay?.close()
    client?.close()
    // Its own errors (hooks outside the root) are kept for after the clean-up, which must run regardless.
    const closed = await d?.close().then(() => null, (error: unknown) => error)
    await proxy?.stop()
    await canary?.stop()
    await pages?.stop()
    if (store) await sweep()
    if (closed) throw closed
  }, 600_000)

  step('builds the image, and a browser agent is ready with no published port', MACHINE_MS + BUILD_MS + 120_000, async () => {
    const cwd = join(d!.projectsDir, 'with-browser')
    mkdirSync(cwd, { recursive: true })
    // As the Desktop's form asks before it creates the agent: a stopped machine is one Harness starts, so it goes on.
    if (process.platform === 'darwin') expect(await client!.request('agent_browser_available', {})).toMatchObject({ state: 'stopped' })
    const created = await client!.request('agent_create', { engine: 'claude', cwd, bypassPermission: true, browser: true }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    agent = created.agent as Record<string, any>
    const pressed = process.platform === 'darwin' ? await installOwnMachine() : Date.now()
    await settled('the image to build and the browser to be ready', MACHINE_MS + BUILD_MS)
    console.log(`agent browser e2e: ready ${Math.round((Date.now() - pressed) / 1000)} s after ${process.platform === 'darwin' ? 'Install' : 'the agent was created'}`)
    if (process.platform === 'darwin') expect(await defaultConnection()).toBe(personsConnection)
    await until('the agent to bind its conversation', async () => (await row())?.sessionId || null, 60_000, 500)
    // Only `podman exec` reaches the browser (spec § The container).
    const ports = await podman(['container', 'port', name()])
    expect(ports.code, ports.stderr).toBe(0)
    expect(ports.stdout.trim()).toBe('')
  })

  step('the agent\'s tools drive it: navigate, snapshot, click by ref, type, screenshot', 6 * CALL_MS, async () => {
    const tools = await openRelay()
    const opened = await tools.call('browser_navigate', { url: pages!.url('/form') })
    expect(opened.isError, opened.text).toBe(false)
    expect(opened.text).toContain('/form')
    // The form is hidden until the button is clicked: its textbox in the second snapshot is the click's doing.
    const button = refOf((await tools.call('browser_snapshot')).text, 'button', 'Open form')
    const clicked = await tools.call('browser_click', { ref: button })
    expect(clicked.text, clicked.text).toBe('Clicked')
    const box = refOf((await tools.call('browser_snapshot')).text, 'textbox', 'Name')
    const typed = await tools.call('browser_type', { ref: box, text: TYPED, submit: true })
    expect(typed.isError, typed.text).toBe(false)
    const submitted = await until('the typed form to reach the page server', () => pages!.seen.find((seen) => seen.path === '/submitted'), 30_000)
    expect(submitted.query.get('name')).toBe(TYPED)
    const shot = await tools.call('browser_screenshot')
    expect(shot.isError, shot.text).toBe(false)
    expect(shot.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' })
    expect([...Buffer.from(String(shot.content[0].data), 'base64').subarray(0, 2)]).toEqual([0xff, 0xd8])
  })

  step('a page that asks for a person: the reply names the challenge and tells the agent to ask in chat', CALL_MS, async () => {
    const reply = await relay!.call('browser_navigate', { url: pages!.url('/challenge') })
    expect(reply.isError, reply.text).toBe(false)
    expect(reply.text).toContain('challenge: perimeterx')
    expect(reply.text).toContain(CHAT_LINE)
  })

  step('a stream opened as the Desktop opens one: the banner, a handshake, the local profile at Xvnc, and a close that ends the exec', 2 * CALL_MS, async () => {
    // Xvnc sends a full-colour rectangle as Tight JPEG only when the viewer set a quality level. This viewer sets none,
    // so a JPEG rectangle is the shaper's level (q6/c2 for a local connection, core/browserStreams.ts) reaching Xvnc.
    const noise = await relay!.call('browser_navigate', { url: pages!.url('/noise') })
    expect(noise.isError, noise.text).toBe(false)
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

  step('the daemon\'s loopback API refuses a request from inside the container', 60_000, async () => {
    const status = (url: string) => inside(['sh', '-c', `curl -s -o /dev/null -w '%{http_code}' --max-time 5 ${quote(url)}; true`])
    // The container does reach this machine, so a refusal below is the daemon's, not a missing route.
    expect((await status(pages!.url('/addr'))).stdout).toBe('200')
    const daemon = await status(`http://${HOST}:${d!.port}/api/status`)
    expect(daemon.stdout, daemon.stderr).not.toMatch(/^2/)
  })

  step('a page cannot reach the host, gvproxy or the container\'s gateway, by fetch or WebSocket, and a public page loads', 3 * CALL_MS, async () => {
    // With no proxy, every request still goes through the relay (proxy-relay.mjs), which refuses these.
    const shown = await relay!.call('browser_navigate', { url: 'https://example.com/' })
    expect(shown.isError, shown.text).toBe(false)
    expect((await relay!.call('browser_snapshot')).text).toContain('Example Domain')

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
    const probed = await relay!.call('browser_navigate', { url: pages!.url(`/probe?targets=${[...refused, allowed].join(',')}`) })
    expect(probed.isError, probed.text).toBe(false)
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

  step('a stop keeps the login: a cookie set before it is sent after the agent resumes', START_MS + 4 * CALL_MS, async () => {
    const set = await relay!.call('browser_navigate', { url: pages!.url('/set-cookie') })
    expect(set.isError, set.text).toBe(false)
    await relay!.close()
    relay = undefined
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
    expect((await client!.request('agent_resume', { agentId: agent!.id }, 90_000)).error).toBeUndefined()
    await settled('the browser to be ready again after the resume', START_MS)
    const tools = await openRelay()
    const from = pages!.seen.length
    const read = await tools.call('browser_navigate', { url: pages!.url('/cookie') })
    expect(read.isError, read.text).toBe(false)
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
    const back = await relay!.call('browser_navigate', { url: pages!.url('/addr?restarted') })
    expect(back.isError, back.text).toBe(false)
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
    const through = await relay!.call('browser_navigate', { url: pages!.url('/addr?through') })
    expect(through.isError, through.text).toBe(false)
    await until('the page to be reached through the proxy', () => pages!.seen.slice(from).find((seen) => seen.query.has('through')), 30_000)
    await proxy.stop()
    const after = await relay!.call('browser_navigate', { url: pages!.url('/addr?after') })
    const shown = await relay!.call('browser_snapshot')
    expect(after.isError || shown.text.includes('the proxy cannot be used'), `${after.text}\n${shown.text}`).toBe(true)
    const seen = pages!.seen.slice(from)
    expect(seen.filter((one) => one.query.has('after')).map((one) => one.path)).toEqual([])
    expect(seen.filter((one) => !proxy!.upstreamPorts.has(one.port)).map((one) => `${one.path} from ${one.address}:${one.port}`)).toEqual([])
  })

  step('a delete removes its container, volume, network and proxy secret', 4 * 60_000, async () => {
    await relay!.close()
    relay = undefined
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
