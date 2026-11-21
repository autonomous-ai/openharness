/**
 * A dial for a daemon under test, on a pseudo-terminal (ptyBridge.py): it greets the daemon the way the
 * firmware does and speaks the cable protocol with the daemon's own frame codec (src/cable/cableFrame.ts),
 * so what it sends reaches the dial's host exactly as a press on real glass would.
 *
 * The daemon finds it through `HARNESSD_TEST_DIAL_PORT`, the one thing that differs from a dial on USB:
 * a pseudo-terminal is not on the USB bus that discovery reads.
 *
 * Windows has no pseudo-terminal a COM port can be: there the dial serves a pipe (`listen`), and the serial stand-in the
 * daemon runs as its `harness-serial.exe open` carries the port's bytes to it
 * (src/cable/__fixtures__/fakeHarnessSerial.mjs, `FAKE_SERIAL_OPEN=bridge:<endpoint>`).
 */
import { spawn } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CableDecoder, CableType, encodeCableFrame } from '../../src/cable/cableFrame.js'
import { CAROUSEL_REFRESH_MS, DialCarousel, type DialMessage } from '../../src/testing/dialCarousel.js'

export type { DialMessage }

const here = dirname(fileURLToPath(import.meta.url))

export interface FakeDialOptions {
  /** What it calls itself in its greeting; two dials on one desk differ by it. */
  mac?: string
  /** The settings it says it holds when it greets, as the firmware reads them from its flash. */
  settings?: Record<string, unknown>
  /** The capabilities its greeting names (`stats: 'turn-v1'`, …), as a firmware that speaks them does. */
  capabilities?: Record<string, string>
}

/** The dial's end of the cable: what carries its bytes to the daemon, and what lets the cable go. */
interface Cable {
  write(bytes: Uint8Array): void
  close(): Promise<void>
}

export class FakeDial {
  readonly messages: DialMessage[] = []
  /** When each message arrived, ms since the epoch: the gaps are what a dial reads as its daemon's health. */
  readonly arrivedAt: number[] = []
  private readonly mac: string
  private readonly settings?: Record<string, unknown>
  private readonly capabilities: Record<string, string>
  /** When the daemon last said anything, and whether it has welcomed this dial since it last went quiet. */
  private heardAt = 0
  private welcomed = false
  private cadence: ReturnType<typeof setInterval> | null = null
  private readonly model = new DialCarousel()
  private readonly refreshing: ReturnType<typeof setInterval>

  private constructor(private readonly cable: Cable, readonly path: string, options: FakeDialOptions) {
    this.mac = options.mac ?? 'e2:e0:00:00:00:01'
    this.settings = options.settings
    this.capabilities = options.capabilities ?? {}
    this.refreshing = setInterval(() => this.model.refresh(), CAROUSEL_REFRESH_MS)
  }

  /** What the daemon sent, framed by [decoder]: one for each connection, so a frame cut short by a port that closed is
   *  never joined to the next connection's bytes. */
  private hear(decoder: CableDecoder, chunk: Buffer): void {
    decoder.feed(chunk, (frame) => {
      if (frame.type !== CableType.Json) return
      let message: DialMessage
      try { message = JSON.parse(Buffer.from(frame.payload).toString('utf8')) as DialMessage } catch { return }
      this.messages.push(message)
      this.arrivedAt.push(Date.now())
      this.heardAt = Date.now()
      if (message.t === 'welcome') this.welcomed = true
      this.model.heard(message)
      // A dial that stops answering for 20 seconds is taken as unplugged (cableSession SILENCE_MS).
      if (message.t === 'ping') this.send({ t: 'pong' })
    })
  }

  static async open(options: FakeDialOptions = {}): Promise<FakeDial> {
    const bridge = spawn('python3', [join(here, 'ptyBridge.py')], { stdio: ['pipe', 'pipe', 'pipe'] })
    const path = await new Promise<string>((resolve, reject) => {
      let said = ''
      const timer = setTimeout(() => reject(new Error(`the pseudo-terminal did not open: ${said}`)), 10_000)
      bridge.stderr!.on('data', (chunk: Buffer) => {
        said += chunk.toString('utf8')
        const line = said.split('\n')[0]
        if (said.includes('\n') && line.startsWith('/dev/')) { clearTimeout(timer); resolve(line) }
      })
      bridge.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the pseudo-terminal bridge exited (${code}): ${said}`)) })
    })
    const dial = new FakeDial({
      write: (bytes) => { bridge.stdin!.write(bytes) },
      close: async () => {
        if (bridge.exitCode !== null) return
        const exited = new Promise<void>((done) => bridge.once('exit', () => done()))
        bridge.stdin!.end()
        const timer = setTimeout(() => bridge.kill('SIGKILL'), 3_000)
        await exited
        clearTimeout(timer)
      },
    }, path, options)
    const decoder = new CableDecoder()
    bridge.stdout!.on('data', (chunk: Buffer) => dial.hear(decoder, chunk))
    return dial
  }

  /**
   * A dial that serves [endpoint], a pipe or a Unix socket: the connection made to it is the cable. A port the daemon
   * opens again connects again, and the newer connection is the cable from then on. What it sends while nothing is
   * connected is lost, as on a port nobody holds; `greet` sends again until it is heard.
   */
  static async listen(endpoint: string, options: FakeDialOptions = {}): Promise<FakeDial> {
    let cable: Socket | null = null
    const server = createServer()
    const dial = new FakeDial({
      write: (bytes) => { if (cable && !cable.destroyed) cable.write(bytes) },
      close: async () => {
        cable?.destroy()
        await new Promise<void>((done) => server.close(() => done()))
      },
    }, endpoint, options)
    server.on('connection', (socket) => {
      cable?.destroy()
      cable = socket
      const decoder = new CableDecoder()
      socket.on('data', (chunk: Buffer) => dial.hear(decoder, chunk))
      // A stand-in that ends as its port closes can reset the connection: the port's next open connects anew.
      socket.on('error', () => {})
      socket.on('close', () => { if (cable === socket) cable = null })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, () => { server.off('error', reject); resolve() })
    })
    return dial
  }

  private hello(): DialMessage {
    return { t: 'hello', product: 'harness', proto: 3, mac: this.mac, fw: '0.0.0-e2e', hw: 'e2e', ...this.capabilities, ...(this.settings ? { settings: this.settings } : {}) }
  }

  send(message: DialMessage): void {
    this.cable.write(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(message), 'utf8')))
  }

  /** One chunk of what its microphone heard, between a `voice.begin` and its `voice.end`, as the firmware sends it. */
  audio(pcm: Buffer): void {
    this.cable.write(encodeCableFrame(CableType.Pcm, pcm))
  }

  /** What the glass shows: the tiles in order, the agent on the face (`null` is "Choose a pane"), the agents refused. */
  carousel(): { tiles: string[]; active: string | null; refused: number } {
    const { tiles, active, refused } = this.model
    return { tiles: [...tiles], active: tiles[active] ?? null, refused }
  }

  /** A tap on an app in APPS (ui_habitat.c `app_pick`): the pick goes to the daemon, and its ring lands on the face. */
  pick(app: string): void {
    this.send({ t: 'app.pick', app })
    this.model.picked(app)
  }

  /** The first message from the daemon that passes `test`, waiting up to `ms` for it. */
  async next(test: (message: DialMessage) => boolean, ms = 20_000, what = 'a message', since = 0): Promise<DialMessage> {
    const deadline = Date.now() + ms
    for (;;) {
      const found = this.messages.slice(since).find(test)
      if (found) return found
      if (Date.now() > deadline) throw new Error(`the dial heard no ${what} in ${ms}ms (heard: ${this.messages.map((m) => m.t).join(', ') || 'nothing'})`)
      await new Promise((done) => setTimeout(done, 100))
    }
  }

  /**
   * A person's turn to [agentId], again every 2 s until [probe] gives a value, polling every 50 ms; that value. The daemon
   * drops a dial's `focus` for 750 ms after a focus of its own (a landing, a re-assert, a follow) until it hears that one
   * echoed (cableSession.ts, `expectedAppFocusEcho`), and this dial echoes none: a turn that falls in that time is lost,
   * so it is made again, as a person turns again.
   */
  async turnUntil<T>(agentId: string, what: string, probe: () => T | undefined, ms = 60_000): Promise<T> {
    const deadline = Date.now() + ms
    let sentAt = 0
    for (;;) {
      const got = probe()
      if (got !== undefined) return got
      if (Date.now() > deadline) throw new Error(`the dial's turn to ${agentId} never gave ${what} in ${ms}ms`)
      if (Date.now() - sentAt >= 2_000) {
        this.send({ t: 'focus', agentId })
        sentAt = Date.now()
      }
      await new Promise((done) => setTimeout(done, 50))
    }
  }

  /**
   * Greet the daemon as the firmware does, again and again until it answers: the daemon opens the port
   * on its own scan, and a greeting sent before then lands on nobody.
   */
  async greet(ms = 60_000, since = 0): Promise<DialMessage> {
    const deadline = Date.now() + ms
    for (;;) {
      this.send(this.hello())
      const welcome = this.messages.slice(since).find((m) => m.t === 'welcome')
      if (welcome) return welcome
      if (Date.now() > deadline) throw new Error(`the daemon never welcomed the dial (heard: ${this.messages.map((m) => m.t).join(', ') || 'nothing'})`)
      await new Promise((done) => setTimeout(done, 500))
    }
  }

  /**
   * Greet as the firmware does, on its own, for as long as the dial is plugged in: every two seconds until
   * the daemon welcomes it, then every fifteen, welcomed or not — which is how a dial finds a daemon that
   * started again behind the same port, since it has no port-open event to wait on and the new daemon's
   * pings sound like the old one's (cableSession.ts, rule 1). Fifteen seconds without a word from the
   * daemon (the dial's own window) and it is no longer welcomed.
   */
  keepGreeting(): void {
    if (this.cadence) return
    let greetedAt = 0
    const tick = (): void => {
      if (this.welcomed && Date.now() - this.heardAt > 15_000) this.welcomed = false
      const every = this.welcomed ? 15_000 : 2_000
      if (Date.now() - greetedAt < every) return
      greetedAt = Date.now()
      this.send(this.hello())
    }
    this.cadence = setInterval(tick, 500)
    tick()
  }

  /** Bytes that are no frames, straight onto the port: what a broken or hostile board sends. */
  flood(bytes: Buffer): void {
    this.cable.write(bytes)
  }

  /** The first welcome after `since`, waiting up to `ms`: a daemon that started again behind the port. */
  welcomeAfter(since: number, ms = 60_000): Promise<DialMessage> {
    return this.next((m) => m.t === 'welcome', ms, 'a welcome', since)
  }

  async close(): Promise<void> {
    if (this.cadence) clearInterval(this.cadence)
    this.cadence = null
    clearInterval(this.refreshing)
    await this.cable.close()
  }
}
