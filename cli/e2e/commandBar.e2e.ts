/**
 * The command bar, an experiment in a process of its own (services/commandBar.ts), on the real daemon,
 * deciding through a fake JEV on this computer (`HARNESS_TEST_JEV_URL`) with a fixture key: never
 * OpenRouter. Both doors the apps use: the socket's `command_bar` (a window here, as a remote owner's app
 * asks over the relay) and the hook server's `/api/command-bar/*` (the desktop's own command bar).
 *
 * What moving it out of the core must keep: a decision answered as before; two at once per connection,
 * BUSY beyond; a connection that closes has its decisions aborted, which frees their slots. What being an
 * experiment adds: no process until its first request; its process killed in the middle of a decision costs
 * that decision alone, answered SERVICE_UNAVAILABLE at once at either door, while the core and every agent go
 * on; and a command bar that cannot start is refused plainly at both doors.
 */
import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

/** The process the command bar runs in, as the master names it. */
const HOST = 'commandBar'

/** One call the command bar made to JEV: what it asked, whether its caller went, and its answer. */
interface Asked { questions: string[]; closed: boolean; answer(): void }

/** JEV's Decisions endpoint, as the command bar calls it, answering one candidate as a clear choice. */
class FakeJev {
  readonly asked: Asked[] = []
  /** Hold every answer until `answer()` is called on it: a decision in flight. */
  hold = false
  private server: Server | null = null
  url = ''

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        // A caller that went before it finished sending (a process killed) leaves nothing to answer.
        let body: { questions: Record<string, unknown> }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { res.destroy(); return }
        const questions = Object.keys(body.questions)
        const answers = questions.includes('fit')
          ? { fit: { type: 'noul', noul: 0.95 } }
          : {
              intent: { type: 'choice', choice: 'open', probabilities: { open: 0.97, none: 0.03 } },
              pick_open: { type: 'choice', choice: 'c0', probabilities: { c0: 0.97, none: 0.03 } },
            }
        const asked: Asked = {
          questions,
          closed: false,
          answer: () => { if (!res.writableEnded && !res.destroyed) res.end(JSON.stringify({ answers })) },
        }
        res.on('close', () => { if (!res.writableEnded) asked.closed = true })
        this.asked.push(asked)
        if (!this.hold) asked.answer()
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/decisions`
  }

  release(): void {
    this.hold = false
    for (const asked of this.asked) asked.answer()
  }

  async stop(): Promise<void> {
    this.release()
    this.server?.closeAllConnections()
    await new Promise<void>((resolve) => this.server ? this.server.close(() => resolve()) : resolve())
  }
}

/** What the window's command bar sends: the prompt and the one action it could take. */
const REQUEST = { prompt: 'take me back to the release notes', candidates: [{ id: 'open:notes', kind: 'open', title: 'Release notes', detail: 'Writing the release notes' }] }
/** JEV's clear choice of it, as the command bar answers it. */
const DECIDED = { selectedId: 'open:notes', suggestions: [], fit: 0.95, autoExecute: true, reviewReason: null, provider: 'OpenRouter' }

/** The command bar's processes the master started, by the pids it logged: the last is the one running. */
const started = (d: IsolatedDaemon): number[] =>
  [...d.log().matchAll(new RegExp(`\\[harnessd\\] service ${HOST} started \\(pid (\\d+)\\)`, 'g'))].map((match) => Number(match[1]))

/** The hook server's door, as the desktop calls it. */
async function http(d: IsolatedDaemon, route: 'status' | 'resolve', body?: unknown, signal?: AbortSignal): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`http://127.0.0.1:${d.port}/api/command-bar/${route}`, {
    method: route === 'status' ? 'GET' : 'POST',
    headers: { 'x-adapter-local': '1', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  })
  return { status: response.status, body: await response.json() as Record<string, any> }
}

/** A `command_bar` asked without waiting: its answer, when it comes. */
function ask(client: LocalClient): Promise<Record<string, any>> {
  return client.request('command_bar', { request: REQUEST }, 60_000)
}
const withoutTiming = (answer: Record<string, any>) => { const { elapsedMs: _elapsed, requestId: _id, ...rest } = answer; return rest }

describe('the command bar, an experiment in its own process', () => {
  let daemon: IsolatedDaemon | undefined
  let jev: FakeJev | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined; await jev?.stop(); jev = undefined })
  const fresh = async (env: Record<string, string> = {}) => {
    jev = new FakeJev()
    await jev.start()
    const d = await IsolatedDaemon.create({ env: {
      OPENROUTER_API_KEY: 'fixture-only-not-a-key',
      HARNESS_TEST_JEV_URL: jev.url,
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200',
      HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
      ...env,
    } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    return { d, jev }
  }

  it('has no process until its first command, then decides at both doors through it, as it did in the core', async () => {
    const { d } = await fresh()
    const client = await LocalClient.connect(d)
    await until('the services to connect', () => d.log().includes('[services] search connected') || null, 30_000, 200)
    expect(started(d), 'a command bar no one used').toEqual([])
    expect(withoutTiming(await ask(client))).toEqual(DECIDED)
    expect(started(d)).toHaveLength(1)
    const status = await http(d, 'status')
    expect(status).toEqual({ status: 200, body: { success: true, data: { configured: true, provider: 'OpenRouter', model: 'typesafe/jev-1.13' } } })
    const resolved = await http(d, 'resolve', REQUEST)
    expect(resolved.status).toBe(200)
    expect(withoutTiming(resolved.body.data)).toEqual(DECIDED)
    // What it refuses, it refuses in the same words.
    expect(withoutTiming(await client.request('command_bar', { request: { prompt: '' } }))).toEqual({ error: 'INVALID_REQUEST', detail: 'This command or its workspace context is too large or invalid.' })
    expect(await http(d, 'resolve', { prompt: '' })).toEqual({ status: 400, body: { success: false, error: { code: 'INVALID_REQUEST', message: 'This command or its workspace context is too large or invalid.' } } })
    expect(started(d)).toHaveLength(1)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('takes two at once from a connection, BUSY beyond; a connection that closes has its own aborted, and their slots back', async () => {
    const { d, jev } = await fresh()
    const closing = await LocalClient.connect(d)
    const other = await LocalClient.connect(d)
    // On first, so that what follows is the command bar's limits and not its start.
    expect(withoutTiming(await ask(other))).toEqual(DECIDED)
    jev.hold = true
    const asked = jev.asked.length
    // Never answered: their connection closes first.
    void ask(closing).catch(() => null)
    void ask(closing).catch(() => null)
    await until('two decisions to reach JEV', () => jev.asked.length >= asked + 2 || null, 30_000, 100)
    // The connection's third, at once: the socket's own limit, in its own words.
    expect(withoutTiming(await ask(closing))).toEqual({ error: 'BUSY' })
    // Another connection, and the HTTP door: the command bar's two at once in all, in its words.
    expect(withoutTiming(await ask(other))).toEqual({ error: 'BUSY', detail: 'Too many commands at once. Try again in a moment.' })
    expect(await http(d, 'resolve', REQUEST)).toEqual({ status: 429, body: { success: false, error: { code: 'BUSY', message: 'Too many commands at once. Try again in a moment.' } } })
    expect(jev.asked).toHaveLength(asked + 2)
    closing.close()
    await until('JEV to see both of the closed connection\'s calls abandoned', () => jev.asked.slice(asked).every((one) => one.closed) || null, 30_000, 100)
    // Their slots are free again: the other connection decides.
    jev.hold = false
    expect(withoutTiming(await ask(other))).toEqual(DECIDED)
    // The HTTP door: a client that goes before its answer has its decision aborted the same way.
    jev.hold = true
    const before = jev.asked.length
    const going = new AbortController()
    const abandoned = http(d, 'resolve', REQUEST, going.signal).catch(() => null)
    await until('the HTTP decision to reach JEV', () => jev.asked.length > before || null, 30_000, 100)
    going.abort()
    await abandoned
    await until('JEV to see the HTTP decision abandoned', () => jev.asked.at(-1)!.closed || null, 30_000, 100)
    expect(d.coresStarted()).toBe(1)
    other.close()
  })

  it('killed in the middle of a decision: it fails at once at either door, cleanly, and the core and its agents go on', async () => {
    const { d, jev } = await fresh()
    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'command-bar-killed')
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
    expect(created.error).toBeUndefined()
    const agentId = created.agent.id as string
    expect(withoutTiming(await ask(client))).toEqual(DECIDED)
    jev.hold = true
    const asked = jev.asked.length
    const overSocket = ask(client)
    const overHttp = http(d, 'resolve', REQUEST)
    await until('both decisions to reach JEV', () => jev.asked.length >= asked + 2 || null, 30_000, 100)
    const before = started(d)
    process.kill(before.at(-1)!, 'SIGKILL')
    expect(withoutTiming(await overSocket)).toEqual({ error: 'SERVICE_UNAVAILABLE', service: 'commandBar', retryable: true })
    expect(await overHttp).toEqual({ status: 503, body: { success: false, error: { code: 'UNAVAILABLE', message: 'The command bar is off or restarting. Choose an action below, or try again in a moment.' } } })
    // The agent was never the command bar's: it takes its turn as before.
    const ended = client.next((frame: Frame) => frame.type === 'turn_ended' && frame.agentId === agentId, 60_000, 'turn_ended')
    client.send('message', { agentId, content: 'while the command bar was gone' })
    await ended
    expect(d.coresStarted()).toBe(1)
    // The master brings it back, and it decides again.
    jev.release()
    const answer = await until('the command bar to decide again', async () => {
      const again = withoutTiming(await ask(client))
      return again.error ? null : again
    }, 60_000, 500)
    expect(answer).toEqual(DECIDED)
    expect(started(d).length).toBeGreaterThan(before.length)
    client.close()
  })

  it('one that cannot start is refused plainly at both doors, and nothing else notices', async () => {
    const { d } = await fresh({ HARNESSD_TEST_FAULTS: 'commandBar' })
    const client = await LocalClient.connect(d)
    const [overSocket, overHttp] = await Promise.all([ask(client), http(d, 'resolve', REQUEST)])
    expect(withoutTiming(overSocket)).toEqual({ error: 'SERVICE_UNAVAILABLE', service: 'commandBar', retryable: true })
    expect(overHttp).toEqual({ status: 503, body: { success: false, error: { code: 'UNAVAILABLE', message: 'The command bar is off or restarting. Choose an action below, or try again in a moment.' } } })
    expect((await client.request('agents_list', {})).error).toBeUndefined()
    expect(d.coresStarted()).toBe(1)
    client.close()
  }, 120_000)
})
