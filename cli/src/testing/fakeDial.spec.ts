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

/** A daemon's end on a stand-in that keeps settings: it sends one `settings.set`, then waits for the answer and the
 *  greeting after it. */
async function setOnce(name: string, settings: Record<string, unknown>, set: Record<string, unknown>): Promise<{ state: unknown; hello: unknown }> {
  const dir = mkdtempSync(join(tmpdir(), 'fakedial-'))
  dirs.push(dir)
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\fakedial-${name}-${process.pid}` : join(dir, 'dial.sock')
  const dial = await FakeDial.listen(endpoint, { settings, keepsSettings: true })
  const daemon = connect(endpoint)
  const hellos: Record<string, unknown>[] = []
  let answered: (state: Record<string, unknown>) => void = () => {}
  const answer = new Promise<Record<string, unknown>>((resolve) => { answered = resolve })
  const send = (message: object): void => {
    daemon.write(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(message), 'utf8')))
  }
  try {
    const decoder = new CableDecoder()
    daemon.on('data', (chunk: Buffer) => decoder.feed(chunk, (frame) => {
      if (frame.type !== CableType.Json) return
      const message = JSON.parse(Buffer.from(frame.payload).toString('utf8')) as Record<string, unknown>
      if (message.t === 'hello') { hellos.push(message); send({ t: 'welcome' }) }
      if (message.t === 'settings.state') answered(message)
    }))
    await dial.greet(10_000)
    send({ t: 'settings.set', ...set })
    let timer: NodeJS.Timeout | undefined
    const state = await Promise.race([answer, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('the stand-in did not answer the settings.set')), 10_000)
    })]).finally(() => clearTimeout(timer))
    const greeted = hellos.length
    await dial.greet(10_000, dial.messages.length)
    expect(hellos.length).toBeGreaterThan(greeted)
    return { state, hello: hellos.at(-1) }
  } finally {
    daemon.destroy()
    await dial.close()
  }
}

// The Windows desk's stand-in must keep what the daemon sets, as the round firmware does (handle_settings_set), or a
// setting such as Voice language cannot be checked with it: it would greet with what it started with.
it('keeps a settings.set as the firmware does: named fields of the same type, brightness clamped, read back and greeted with', async () => {
  const { state, hello } = await setOnce('set', { brightness: 80, muted: false, voiceLang: 'en' }, { voiceLang: 'vi', brightness: 150, muted: 'yes', quiet: true })

  const kept = { brightness: 100, muted: false, voiceLang: 'vi' }
  expect(state).toEqual({ t: 'settings.state', ok: true, settings: kept })
  expect((hello as { settings?: unknown }).settings).toEqual(kept)
})

// The round firmware holds Focus as its only face, drawn straight across (ui_settings_apply drops character and
// straightTitle), never changes its glass (face, round), stores brightness as a whole number and Voice language in 7
// bytes. A stand-in that took more would show the desk a setting no real dial keeps.
it('keeps none of the rows the round firmware holds fixed, brightness whole and Voice language in 7 bytes', async () => {
  const held = { brightness: 60, character: 0, face: 466, muted: false, quiet: false, straightTitle: false, focusFace: false, scrollReversed: false, round: true, voiceLang: 'en' }
  const { state } = await setOnce('fixed', held, { character: 3, straightTitle: true, face: 100, round: false, brightness: 42.9, voiceLang: 'abcdefghij', focusFace: true, scrollReversed: true })

  expect(state).toEqual({ t: 'settings.state', ok: true, settings: { ...held, brightness: 42, voiceLang: 'abcdefg', focusFace: true, scrollReversed: true } })
})

// The firmware cuts Voice language to 7 bytes, not 7 characters (snprintf into CFG_VLANG_MAX), and reads an empty one
// back as English (config_load_voicelang).
it('cuts Voice language by bytes and reads an empty one back as English, as the firmware does', async () => {
  const held = { brightness: 60, muted: false, voiceLang: 'en' }
  const cut = await setOnce('bytes', held, { voiceLang: 'tiếngViệt' })
  const empty = await setOnce('empty', { ...held, voiceLang: 'vi' }, { voiceLang: '' })

  expect(cut.state).toEqual({ t: 'settings.state', ok: true, settings: { ...held, voiceLang: 'tiếng' } })
  expect(empty.state).toEqual({ t: 'settings.state', ok: true, settings: { ...held, voiceLang: 'en' } })
})
