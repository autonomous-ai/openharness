/**
 * The dial on Windows, end to end (docs/plans/2026-11-19-dial-windows-design.md, part A): a real daemon from the run's
 * bundle, sealed in a throwaway profile whose name has spaces, Vietnamese letters, `'`, `&` and `%`, with a stand-in dial
 * behind its serial stand-in (harness/windowsDaemon.ts). The devices listen on a pipe of their own, and every client
 * reaches them there with the devices' token:
 * - `harness device notify` says `no dial` before the dial greets and `shown` after, and the dial gets the line;
 * - the Notifications setting, asked over the pipe, is answered and kept in the data folder;
 * - the real `harness device vscode link` names the pipe, its token and its record, and a window's stream signed with
 *   that token is answered with the proof and stays open;
 * - a request with another token is refused, and an answer without the proof is dropped.
 * Windows only: the Linux and macOS e2e runs find this file and skip it.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { NOTIFY_MODE_FILE } from '../src/cable/notifyMode.js'
import { askDevices } from '../src/devices/listenerClient.js'
import { DEVICES_TOKEN_FILE, writeDevicesRecord } from '../src/devices/listenerPipe.js'
import { ensureDaemonToken, newPipeNonce, newPipePath, PIPE_AUTH_HEADER, pipeAuthValue, pipeProven } from '../src/lib/windows/pipeAuth.js'
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

  it('harness device notify says no dial before the dial greets, and shown after; the dial gets the line', async () => {
    showLog()
    expect(d.dataDir).toContain(PROFILE_NAME)
    const before = await d.harness(['device', 'notify', LINE])
    expect({ code: before.code, out: before.stdout.trim() }).toEqual({ code: 0, out: 'no dial' })

    await d.dial.greet(90_000)
    await d.dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    const after = await d.harness(['device', 'notify', LINE])
    expect({ code: after.code, out: after.stdout.trim() }).toEqual({ code: 0, out: 'shown' })
    await d.dial.next((m) => JSON.stringify(m).includes(LINE), 45_000, 'the notice')
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
      // What is checked is that nothing ends it for this long: a stream, not an answer.
      await new Promise((done) => setTimeout(done, 2_000))
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
})
