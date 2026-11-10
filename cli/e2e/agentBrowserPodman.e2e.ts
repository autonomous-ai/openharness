/**
 * The agent browser on real Podman (Task 20 of docs/superpowers/plans/2026-11-10-agent-browser.md): the image built from
 * the CLI's own files, a browser agent's Chrome driven through `harness browser-mcp` as an engine drives it, its screen
 * streamed as the Desktop opens it, a page that asks for a person, its login kept across a stop, its restart after a crash, Device, a proxy that fails closed,
 * and a delete that leaves nothing behind. agentBrowser.e2e.ts runs the same daemon against a fake `podman`.
 *
 * Linux only, on rootless Podman, in a store of its own: the daemon finds a `podman` first on its PATH that runs the
 * real one with `--root` and `--runroot` in a folder this file made, so nothing a person or another run keeps in Podman
 * is seen or touched, and the clean-up can remove all that folder holds. On macOS and Windows Podman runs in a machine,
 * and this file never uses one. It is skipped, with the reason, where `podman info` fails. The nightly suite leaves it
 * out (vitest.e2e.ci.config.ts): the image takes minutes to build. CI runs it when asked (cli-e2e.yml,
 * `agent_browser_podman`).
 *
 * The cases run in order on one daemon and one agent, each starting where the last left the browser; once one fails,
 * the rest are skipped and say which.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
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
// A container created again (new settings) or started again (after an exit): the ready check's 60 s and the restart's
// backoff, with room.
const START_MS = 3 * 60_000
// A navigation's own 60 s (browser-tools.mjs), plus the relay asking the daemon and starting `podman exec`.
const CALL_MS = 90_000
const TYPED = 'Xin chào 👋'
const DEVICE = { gpuVendor: 'Harness E2E Vendor', gpuRenderer: 'Harness E2E Renderer', cpuCores: 12, memoryGb: 4 }
const PROXY_LOGIN = { username: 'harness-e2e', password: 'e2e-proxy-password' }
const CHAT_LINE = 'This page asks for a person. Tell your person in chat what to do in Browser, wait for their answer, and do not act on the challenge yourself.'
// Inside the container, the machine it runs on; Podman writes the name into the container's /etc/hosts.
const HOST = 'host.containers.internal'
// A loopback port inside the container for the Device page (see that case).
const SECURE_PORT = 18080

const realPodman = process.platform === 'linux'
  ? (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'podman')).find((file) => existsSync(file)) ?? null
  : null

/** Why this file cannot run here, or null. Only on Linux is Podman asked anything: elsewhere it would start a machine. */
function unavailable(): string | null {
  if (process.platform !== 'linux') return `Linux only: on ${process.platform} Podman runs in a machine, and this test never uses one`
  if (!realPodman) return 'podman is not on PATH'
  try {
    execFileSync(realPodman, ['info', '--format', 'json'], { timeout: 10_000, stdio: 'pipe' })
    return null
  } catch (error) {
    const said = String((error as { stderr?: Buffer }).stderr ?? '').trim().split('\n').at(-1)
    return `podman info failed: ${said || (error as Error).message}`
  }
}
const SKIP = unavailable()

interface Store { dir: string; flags: string[] }
interface Ran { code: number; stdout: string; stderr: string }

/** Never rejects: a command that failed or ran out of time answers its code (-1 when it had none) and what it said. */
function run(file: string, args: string[], timeoutMs: number): Promise<Ran> {
  return new Promise((done) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ code: !error ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr: error?.killed ? `timed out after ${timeoutMs} ms` : stderr })
    })
  })
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** Where the daemon looks first (its bin is first on PATH, as agentBrowser.e2e.ts's fake is): the real Podman, in the store. */
function writePodman(d: IsolatedDaemon, store: Store): void {
  mkdirSync(join(d.root, 'bin'), { recursive: true })
  writeFileSync(join(d.root, 'bin', 'podman'), `#!/bin/sh\nexec ${[realPodman!, ...store.flags].map(quote).join(' ')} "$@"\n`, { mode: 0o755 })
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
  '/device': '<script>'
    + 'const gl = document.createElement("canvas").getContext("webgl");'
    + 'fetch("/device-report?" + new URLSearchParams({ cores: String(navigator.hardwareConcurrency), memory: String(navigator.deviceMemory),'
    + ' vendor: gl ? String(gl.getParameter(0x9245)) : "", renderer: gl ? String(gl.getParameter(0x9246)) : "" }))'
    + '</script>',
  '/device-report': '',
  // A different colour in every pixel of the viewport (the stream case).
  '/noise': '<canvas id="c" style="position:fixed;inset:0"></canvas><script>'
    + 'const c = document.getElementById("c"); c.width = innerWidth; c.height = innerHeight;'
    + 'const g = c.getContext("2d"); const image = g.createImageData(c.width, c.height);'
    + 'for (let i = 0; i < image.data.length; i++) image.data[i] = i % 4 === 3 ? 255 : Math.random() * 256;'
    + 'g.putImageData(image, 0, 0)'
    + '</script>',
}

/** The pages the browser opens, and every request they were asked, with where it came from. */
class Pages {
  private constructor(private readonly server: http.Server, readonly port: number, readonly seen: Seen[]) {}

  /**
   * On every address: the container reaches this machine at its own address, never its loopback (rootless Podman's
   * slirp4netns does not carry loopback), and only for this run.
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
    await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '0.0.0.0', () => done()) })
    return new Pages(server, (server.address() as AddressInfo).port, seen)
  }

  url(path: string): string { return `http://${HOST}:${this.port}${path}` }

  stop(): Promise<void> {
    this.server.closeAllConnections()
    return new Promise((done) => this.server.close(() => done()))
  }
}

/**
 * An HTTP proxy with a login, as a person's would be. It carries plain requests to the pages only, and records the
 * local port of each connection it opened to them, so the pages can tell a request that came through it from one that
 * did not. It answers the relay's start probe (proxy-relay.mjs) itself, so the run needs no outside service.
 */
class LoginProxy {
  readonly upstreamPorts = new Set<number>()
  private constructor(private readonly server: http.Server, readonly port: number) {}

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
      if (url.hostname !== HOST || Number(url.port) !== pagesPort) return void res.writeHead(403).end()
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
    await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '0.0.0.0', () => done()) })
    proxy = new LoginProxy(server, (server.address() as AddressInfo).port)
    return proxy
  }

  stop(): Promise<void> {
    this.server.closeAllConnections()
    return new Promise((done) => this.server.close(() => done()))
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
  let relay: Relay | undefined
  let agent: Record<string, any> | undefined
  let broken: string | null = null

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
    // The daemon's `podman events` and the relay's `podman exec` start in process groups of their own, so a core that
    // died hard leaves them running. Every one names this store on its command line, and nothing else does.
    await run('pkill', ['-KILL', '-f', '--', store!.dir], 10_000)
    // The store's files belong to the user namespace's subordinate ids: only inside it can they be removed.
    const gone = await run(realPodman!, ['unshare', 'rm', '-rf', store!.dir], 120_000)
    if (gone.code !== 0) throw new Error(`the Podman store ${store!.dir} was not removed: ${gone.stderr}`)
  }

  beforeAll(async () => {
    if (SKIP) return
    // Short, under the system's temp folder: Podman keeps sockets under the run root.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hb-podman-')))
    store = { dir, flags: ['--root', join(dir, 'root'), '--runroot', join(dir, 'run')] }
    const info = await podman(['info', '--format', 'json'])
    expect(info.code, info.stderr).toBe(0)
    expect((JSON.parse(info.stdout) as { store: { graphRoot: string } }).store.graphRoot).toBe(join(dir, 'root'))
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
    await pages?.stop()
    if (store) await sweep()
    if (closed) throw closed
  }, 600_000)

  step('builds the image, and a browser agent is ready with no published port', BUILD_MS + 120_000, async () => {
    const cwd = join(d!.projectsDir, 'with-browser')
    mkdirSync(cwd, { recursive: true })
    const created = await client!.request('agent_create', { engine: 'claude', cwd, bypassPermission: true, browser: true }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    agent = created.agent as Record<string, any>
    await settled('the image to build and the browser to be ready', BUILD_MS)
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
    // Tight (7) alone, then one 64 × 64 update from the middle of the screen, inside the page.
    send(2, 0, ...u16(1), 0, 0, 0, 7)
    send(3, 0, ...u16(width / 2 - 32), ...u16(height / 2 - 32), ...u16(64), ...u16(64))
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

  step('a stop keeps the login: a cookie set before it is sent after the agent resumes', START_MS + 4 * CALL_MS, async () => {
    const set = await relay!.call('browser_navigate', { url: pages!.url('/set-cookie') })
    expect(set.isError, set.text).toBe(false)
    await relay!.close()
    relay = undefined
    expect((await client!.request('agent_delete', { agentId: agent!.id }, 60_000)).error).toBeUndefined()
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

  step('Device: a page opened without any tool call reports the chosen GPU, cores and memory', START_MS + 2 * 60_000, async () => {
    const before = await container()
    await saveSettings({ device: DEVICE })
    await settled('the browser to be ready with Device on', START_MS, (found) => found.id !== before!.id)
    // navigator.deviceMemory exists only in a secure context, and http://host.containers.internal is not one; the
    // container's own loopback is. socat (in the image) carries it to the pages, and `timeout` ends it whatever happens.
    const forward = await podman(['exec', '--detach', name(), 'timeout', '300', 'socat',
      `TCP-LISTEN:${SECURE_PORT},bind=127.0.0.1,fork,reuseaddr`, `TCP:${HOST}:${pages!.port}`])
    expect(forward.code, forward.stderr).toBe(0)
    await until('the loopback forward inside the container', async () => (await inside(['curl', '-sf', '--max-time', '5', `http://127.0.0.1:${SECURE_PORT}/addr`])).code === 0 || null, 30_000, 250)
    // Opened through Chrome's own DevTools HTTP endpoint, as a tab the person opens appears: no tool call, so only
    // device-inject.mjs's own connection can report the device. The ready marker waits for it to attach, so the first
    // tab after ready reports it.
    const from = pages!.seen.length
    const opened = await inside(['curl', '-sf', '--max-time', '10', '-X', 'PUT', `http://127.0.0.1:9222/json/new?http://127.0.0.1:${SECURE_PORT}/device`])
    expect(opened.code, opened.stderr).toBe(0)
    const report = await until('the tab to report', () => pages!.seen.slice(from).find((seen) => seen.path === '/device-report'), 10_000, 100)
    // Chrome reports memory rounded down to a power of two, at most 8 (device-inject.mjs).
    expect(Object.fromEntries(report.query)).toEqual({ cores: '12', memory: '4', vendor: DEVICE.gpuVendor, renderer: DEVICE.gpuRenderer })
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
