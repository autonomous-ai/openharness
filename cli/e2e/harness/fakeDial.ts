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

export class FakeDial {
  readonly messages: DialMessage[] = []
  private readonly decoder = new CableDecoder()

  private constructor(private readonly bridge: ChildProcess, readonly path: string) {
    bridge.stdout!.on('data', (chunk: Buffer) => {
      this.decoder.feed(chunk, (frame) => {
        if (frame.type !== CableType.Json) return
        let message: DialMessage
        try { message = JSON.parse(Buffer.from(frame.payload).toString('utf8')) as DialMessage } catch { return }
        this.messages.push(message)
        // A dial that stops answering for 20 seconds is taken as unplugged (cableSession SILENCE_MS).
        if (message.t === 'ping') this.send({ t: 'pong' })
      })
    })
  }

  static async open(): Promise<FakeDial> {
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
    return new FakeDial(bridge, path)
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
  async greet(ms = 60_000): Promise<DialMessage> {
    const hello: DialMessage = { t: 'hello', product: 'harness', proto: 3, mac: 'e2:e0:00:00:00:01', fw: '0.0.0-e2e', hw: 'e2e' }
    const deadline = Date.now() + ms
    for (;;) {
      this.send(hello)
      const welcome = this.messages.find((m) => m.t === 'welcome')
      if (welcome) return welcome
      if (Date.now() > deadline) throw new Error(`the daemon never welcomed the dial (heard: ${this.messages.map((m) => m.t).join(', ') || 'nothing'})`)
      await new Promise((done) => setTimeout(done, 500))
    }
  }

  async close(): Promise<void> {
    if (this.bridge.exitCode !== null) return
    const exited = new Promise<void>((done) => this.bridge.once('exit', () => done()))
    this.bridge.stdin!.end()
    const timer = setTimeout(() => this.bridge.kill('SIGKILL'), 3_000)
    await exited
    clearTimeout(timer)
  }
}
