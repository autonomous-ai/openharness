import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { CableDecoder, CableType, encodeCableFrame } from '../cable/cableFrame.js'
import { echoesCodeMoves } from '../cable/cableSession.js'
import { shouldOffer } from '../cable/fwPush.js'

const { FakeDial } = await import('../../e2e/harness/fakeDial.js' as string) as {
  FakeDial: {
    listen(endpoint: string, options?: { settings?: Record<string, unknown>; keepsSettings?: boolean }): Promise<{
      readonly messages: unknown[]
      greet(ms?: number, since?: number): Promise<unknown>
      close(): Promise<void>
    }>
  }
}

const roundFw = readFileSync(join(process.cwd(), '../devices/harness-device/firmware/version.txt'), 'utf8').trim()
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

// The fake stands in for a round dial on today's firmware: one that greets as older firmware would turn the daemon's
// echo guard on for every e2e run and the dial eval, a path no current dial takes.
it('greets as a round dial on the current firmware, which echoes no code moves and is never offered an update', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fakedial-'))
  dirs.push(dir)
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\fakedial-${process.pid}` : join(dir, 'dial.sock')
  const dial = await FakeDial.listen(endpoint)
  const daemon = connect(endpoint)
  let hello: Record<string, unknown> | undefined
  try {
    // The daemon's end: each greeting is welcomed, and `greet` waits, bounded, for that welcome.
    const decoder = new CableDecoder()
    daemon.on('data', (chunk: Buffer) => decoder.feed(chunk, (frame) => {
      if (frame.type !== CableType.Json) return
      hello ??= JSON.parse(Buffer.from(frame.payload).toString('utf8')) as Record<string, unknown>
      daemon.write(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify({ t: 'welcome' }), 'utf8')))
    }))
    await dial.greet(10_000)
  } finally {
    daemon.destroy()
    await dial.close()
  }

  const fw = hello?.fw as string
  expect(fw.startsWith(`${roundFw}-`)).toBe(true)
  expect(echoesCodeMoves(fw, undefined)).toBe(false)
  expect(shouldOffer(fw, '9.9.9')).toBe(false)
})

// The Windows desk's stand-in must keep what the daemon sets, as the round firmware does (handle_settings_set), or a
// setting such as Voice language cannot be checked with it: it would greet with what it started with.
it('keeps a settings.set as the firmware does: named fields of the same type, brightness clamped, read back and greeted with', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fakedial-'))
  dirs.push(dir)
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\fakedial-set-${process.pid}` : join(dir, 'dial.sock')
  const dial = await FakeDial.listen(endpoint, { settings: { brightness: 80, muted: false, voiceLang: 'en' }, keepsSettings: true })
  const daemon = connect(endpoint)
  const hellos: Record<string, unknown>[] = []
  let state: Record<string, unknown> | undefined
  const send = (message: object): void => {
    daemon.write(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(message), 'utf8')))
  }
  try {
    const decoder = new CableDecoder()
    daemon.on('data', (chunk: Buffer) => decoder.feed(chunk, (frame) => {
      if (frame.type !== CableType.Json) return
      const message = JSON.parse(Buffer.from(frame.payload).toString('utf8')) as Record<string, unknown>
      if (message.t === 'hello') { hellos.push(message); send({ t: 'welcome' }) }
      if (message.t === 'settings.state') state = message
    }))
    await dial.greet(10_000)
    send({ t: 'settings.set', voiceLang: 'vi', brightness: 150, muted: 'yes', quiet: true })
    const deadline = Date.now() + 10_000
    while (!state && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
    const greeted = hellos.length
    await dial.greet(10_000, dial.messages.length)
    expect(hellos.length).toBeGreaterThan(greeted)
  } finally {
    daemon.destroy()
    await dial.close()
  }

  const kept = { brightness: 100, muted: false, voiceLang: 'vi' }
  expect(state).toEqual({ t: 'settings.state', ok: true, settings: kept })
  expect(hellos.at(-1)?.settings).toEqual(kept)
})
