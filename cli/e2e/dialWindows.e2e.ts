/**
 * The dial on Windows, end to end (docs/plans/2026-11-19-dial-windows-design.md, part A): a real daemon from the run's
 * bundle, sealed in a throwaway profile whose name has spaces, Vietnamese letters, `'`, `&` and `%`, with a stand-in dial
 * behind its serial stand-in (harness/windowsDaemon.ts). The devices listen on a pipe of their own, and every client
 * reaches them there with the devices' token:
 * - `harness device notify` says `no dial` before the dial greets and `shown <id>` after, and the dial gets the line;
 *   its agent's `--list` shows the card and `--done <id>` takes it off the dial;
 * - the Notifications setting, asked over the pipe, is answered and kept in the data folder;
 * - the real `harness device vscode link` names the pipe, its token and its record, and a window's stream signed with
 *   that token is answered with the proof and stays open;
 * - a request with another token is refused, and an answer without the proof is dropped;
 * - signed in, the stand-in dial's attach reaches the gateway's report queue: the devices and the gateway, both inside
 *   the core's process here, meet at the devices' dial-usage.json (docs/plans/2026-11-23-dial-usage-counts-design.md).
 * Windows only: the Linux and macOS e2e runs find this file and skip it.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { NOTIFY_MODE_FILE } from '../src/cable/notifyMode.js'
import { askDevices } from '../src/devices/listenerClient.js'
import { DEVICES_TOKEN_FILE, writeDevicesRecord } from '../src/devices/listenerPipe.js'
import { ensureDaemonToken, newPipeNonce, newPipePath, PIPE_AUTH_HEADER, pipeAuthValue, pipeProven } from '../src/lib/windows/pipeAuth.js'
import { until } from './harness/daemon.js'
import { FakeBackend } from './harness/fakeBackend.js'
import { PROFILE_NAME, startWindowsDaemon, type WindowsDaemon } from './harness/windowsDaemon.js'

const LINE = 'Need you'
const PIPE = /^\\\\\.\\pipe\\harness-[0-9a-f]{32}$/

/** One signed `POST /` of [body] to [pipe], as the extension sends it: the answer as it starts, and its nonce. */
function post(pipe: string, token: Buffer, body: string): Promise<{ answer: IncomingMessage; nonce: string; cancel(): void }> {
  const nonce = newPipeNonce(pipe)
  return new Promise((resolve, reject) => {
    const sent = request({ socketPath: pipe, method: 'POST', path: '/', agent: false, headers: { [PIPE_AUTH_HEADER]: pipeAuthValue(token, nonce) } },
      (answer) => resolve({ answer, nonce, cancel: () => sent.destroy() }))
    sent.once('error', reject)
    sent.end(body)
  })
}

async function text(answer: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of answer) body += String(chunk)
  return body
}

describe.runIf(process.platform === 'win32')('the dial on Windows', () => {
  let d: WindowsDaemon
  beforeAll(async () => { d = await startWindowsDaemon() })
  afterAll(async () => { await d?.close() })
  const showLog = (): void => onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })

  it('harness device notify says no dial before the dial greets, and shown after; the dial gets the line, --list shows it and --done closes it', async () => {
    showLog()
    expect(d.dataDir).toContain(PROFILE_NAME)
    // Sealed: the daemon's one PATH names Windows' own folders or the root's, never the account's, whose engines it
    // would run.
    const paths = Object.entries(d.env).filter(([name]) => name.toUpperCase() === 'PATH').map(([, value]) => value ?? '')
    expect(paths).toHaveLength(1)
    const systemRoot = process.env.SystemRoot!.toLowerCase()
    expect(paths[0]!.split(';').filter((entry) => !entry.toLowerCase().startsWith(systemRoot) && !entry.startsWith(d.root))).toEqual([])
    // Why the CLI said `no dial` or failed is on its stderr (a reason line), not in the daemon's log.
    const stderrs: string[] = []
    onTestFailed(() => { console.log(`---- harness device notify stderr\n${stderrs.join('\n')}`) })
    const before = await d.harness(['device', 'notify', LINE])
    stderrs.push(before.stderr)
    expect({ code: before.code, out: before.stdout.trim() }).toEqual({ code: 0, out: 'no dial' })

    await d.dial.greet(90_000)
    await d.dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    // The rest runs as a Codex session's commands: `--list` and `--done` name the caller's own cards. harness() spawns with
    // this very env, so the variable is set on it and taken off after.
    d.env.CODEX_THREAD_ID = 'e2e-dial-windows-codex'
    try {
      const since = d.dial.messages.length
      const after = await d.harness(['device', 'notify', LINE])
      stderrs.push(after.stderr)
      expect({ code: after.code, out: after.stdout.trim() }).toEqual({ code: 0, out: expect.stringMatching(/^shown [0-9a-f]{8}$/) })
      const id = after.stdout.trim().slice('shown '.length)
      const question = await d.dial.next((m) => m.t === 'question' && JSON.stringify(m).includes(LINE), 45_000, 'the notice', since)

      const listed = await d.harness(['device', 'notify', '--list'])
      expect({ code: listed.code, out: listed.stdout.trim() }).toEqual({ code: 0, out: expect.stringMatching(new RegExp(`^${id} \\d+[smh] plain ${LINE}$`)) })

      const done = await d.harness(['device', 'notify', '--done', id])
      expect({ code: done.code, out: done.stdout.trim() }).toEqual({ code: 0, out: '' })
      await d.dial.next((m) => m.t === 'question.close' && m.agentId === question.agentId && m.id === question.id, 45_000, 'the card closed', since)
    } finally {
      delete d.env.CODEX_THREAD_ID
    }
  })

  it('the Notifications setting is answered over the pipe and kept in the data folder', async () => {
    showLog()
    expect(await askDevices(d.dataDir, { type: 'notify', mode: 'you' })).toEqual({ mode: 'you' })
    expect(JSON.parse(readFileSync(join(d.dataDir, NOTIFY_MODE_FILE), 'utf8'))).toEqual({ mode: 'you' })
  })

  it('vscode link names the pipe, its token and its record, and a signed window stream stays open with the proof', async () => {
    showLog()
    const linked = await d.harness(['device', 'vscode', 'link'])
    expect(linked.code).toBe(0)
    const link = JSON.parse(linked.stdout) as Record<string, unknown>
    expect(link).toEqual({
      daemon: true, devicesPipe: expect.stringMatching(PIPE), devicesToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      devicesReady: true, devicesRecord: join(d.dataDir, 'devices.json'),
    })

    const token = Buffer.from(link.devicesToken as string, 'hex')
    const { answer, nonce, cancel } = await post(link.devicesPipe as string, token, JSON.stringify({ type: 'vscode', window: randomUUID() }))
    try {
      expect(answer.statusCode).toBe(200)
      expect(pipeProven(answer.headers, token, nonce)).toBe(true)
      let ended = false
      answer.once('end', () => { ended = true })
      answer.once('close', () => { ended = true })
      answer.resume()
      // A stream, not an answer: the devices hold it open once they count the window, and it has not ended by then.
      await until('the devices to count the window', () => d.log().includes('[devices] vscode stream · open · windows 1'), 30_000)
      expect(ended).toBe(false)
    } finally {
      cancel()
    }
  })

  it('a request with another token is refused, and an answer without the proof is dropped', async () => {
    showLog()
    const link = JSON.parse((await d.harness(['device', 'vscode', 'link'])).stdout) as { devicesPipe: string }
    const { answer } = await post(link.devicesPipe, randomBytes(32), JSON.stringify({ type: 'notify', mode: 'full' }))
    expect(answer.statusCode).toBe(401)
    expect(JSON.parse(await text(answer))).toEqual({ error: 'PIPE_AUTH_REQUIRED' })

    // A data folder whose record names a pipe that something else serves: it answers 200 with a body, and no proof.
    const other = mkdtempSync(join(tmpdir(), 'harness-dial-win-other-'))
    const pipe = newPipePath()
    const plain: Server = createServer((_, reply) => { reply.writeHead(200, { 'content-type': 'application/json' }).end('{"mode":"you"}') })
    try {
      await new Promise<void>((done) => plain.listen(pipe, done))
      ensureDaemonToken(other, DEVICES_TOKEN_FILE)
      writeDevicesRecord(other, { pipe, pid: process.pid })
      expect(await askDevices(other, { type: 'notify', mode: 'you' })).toBeNull()
    } finally {
      await new Promise<void>((done) => plain.close(() => done()))
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('signed in, the stand-in dial\'s attach reaches the gateway\'s report queue', async () => {
    const backend = await FakeBackend.start()
    backend.productUsage = { enabled: true, revision: 0, reports: [] }
    const machine = { machineId: 'd2'.repeat(16), computerId: 'e2e-dial-usage-windows', name: 'fixture', token: 'e2e-dial-usage-windows-token' }
    backend.addMachine(machine)
    let signedIn: WindowsDaemon | undefined
    try {
      signedIn = await startWindowsDaemon({
        env: { BACKEND_WS_URL: backend.wsUrl, WEB_URL: backend.httpUrl, ADAPTER_COMPUTER_ID: machine.computerId },
        prepare: ({ auth }) => writeFileSync(join(auth, 'session.json'), JSON.stringify({ version: 1, accessToken: machine.token,
          autonomousEnv: 'prod', computerId: machine.computerId, machineId: machine.machineId,
          expiresAt: Date.now() + 86_400_000, updatedAt: Date.now(), signInEpoch: 'e2e' })),
      })
      const daemon = signedIn
      onTestFailed(() => { console.log(`---- signed-in daemon log\n${daemon.log().split('\n').slice(-200).join('\n')}`) })
      const day = new Date().toISOString().slice(0, 10)
      await daemon.dial.greet(90_000)
      await daemon.dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
      // The gateway's tick, at most a minute after its start and then 45 to 75 seconds apart (gateway/productUsage.ts),
      // takes the day into its queue, a file per account: the report it goes in is the macOS run's to wait for.
      const queues = join(daemon.dataDir, 'product-usage')
      await until('the gateway to take the dial\'s attach', () => existsSync(queues) && readdirSync(queues)
        .filter((name) => name.endsWith('.json'))
        .some((name) => (JSON.parse(readFileSync(join(queues, name), 'utf8')) as { dial?: { sent?: Record<string, Record<string, number>> } })
          .dial?.sent?.[day]?.dial_connected_installation_days === 1) || null, 150_000, 1_000)
    } finally {
      await signedIn?.close()
      await backend.close()
    }
  }, 600_000)
})
