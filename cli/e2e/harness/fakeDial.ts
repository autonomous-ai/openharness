/**
 * A dial for a daemon under test, on a pseudo-terminal (ptyBridge.py): it greets the daemon the way the
 * firmware does and speaks the cable protocol with the daemon's own frame codec (src/cable/cableFrame.ts),
 * so what it sends reaches the dial's host exactly as a press on real glass would.
 *
 * The daemon finds it through `HARNESSD_TEST_DIAL_PORT`, the one thing that differs from a dial on USB:
 * a pseudo-terminal is not on the USB bus that discovery reads.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CableDecoder, CableType, encodeCableFrame } from '../../src/cable/cableFrame.js'

const here = dirname(fileURLToPath(import.meta.url))

export type DialMessage = Record<string, unknown> & { t?: string }

export interface FakeDialOptions {
  /** What it calls itself in its greeting; two dials on one desk differ by it. */
  mac?: string
  /** The settings it says it holds when it greets, as the firmware reads them from its flash. */
  settings?: Record<string, unknown>
}

export class FakeDial {
  readonly messages: DialMessage[] = []
  /** When each message arrived, ms since the epoch: the gaps are what a dial reads as its daemon's health. */
  readonly arrivedAt: number[] = []
  private readonly decoder = new CableDecoder()
  private readonly mac: string
  private readonly settings?: Record<string, unknown>
  /** When the daemon last said anything, and whether it has welcomed this dial since it last went quiet. */
  private heardAt = 0
  private welcomed = false
  private cadence: ReturnType<typeof setInterval> | null = null

  private constructor(private readonly bridge: ChildProcess, readonly path: string, options: FakeDialOptions) {
    this.mac = options.mac ?? 'e2:e0:00:00:00:01'
    this.settings = options.settings
    bridge.stdout!.on('data', (chunk: Buffer) => {
      this.decoder.feed(chunk, (frame) => {
        if (frame.type !== CableType.Json) return
        let message: DialMessage
        try { message = JSON.parse(Buffer.from(frame.payload).toString('utf8')) as DialMessage } catch { return }
        this.messages.push(message)
        this.arrivedAt.push(Date.now())
        this.heardAt = Date.now()
        if (message.t === 'welcome') this.welcomed = true
        // A dial that stops answering for 20 seconds is taken as unplugged (cableSession SILENCE_MS).
        if (message.t === 'ping') this.send({ t: 'pong' })
      })
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
    return new FakeDial(bridge, path, options)
  }

  private hello(): DialMessage {
    return { t: 'hello', product: 'harness', proto: 3, mac: this.mac, fw: '0.0.0-e2e', hw: 'e2e', ...(this.settings ? { settings: this.settings } : {}) }
  }

  send(message: DialMessage): void {
    this.bridge.stdin!.write(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(message), 'utf8')))
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
    this.bridge.stdin!.write(bytes)
  }

  /** The first welcome after `since`, waiting up to `ms`: a daemon that started again behind the port. */
  welcomeAfter(since: number, ms = 60_000): Promise<DialMessage> {
    return this.next((m) => m.t === 'welcome', ms, 'a welcome', since)
  }

  async close(): Promise<void> {
    if (this.cadence) clearInterval(this.cadence)
    this.cadence = null
    if (this.bridge.exitCode !== null) return
    const exited = new Promise<void>((done) => this.bridge.once('exit', () => done()))
    this.bridge.stdin!.end()
    const timer = setTimeout(() => this.bridge.kill('SIGKILL'), 3_000)
    await exited
    clearTimeout(timer)
  }
}
