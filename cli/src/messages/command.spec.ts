import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatSent, paneOwner, parseSendArgs, SEND_USAGE, sendCommand } from './command.js'
import { MessageError } from './model.js'
import type { Rpc } from './rpc.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'send-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('harness send arguments', () => {
  it('reads recipients, the text, a file and --json', () => {
    expect(parseSendArgs([])).toEqual({ names: [], text: '', json: false })
    expect(parseSendArgs(['api,web', 'is', 'it', 'in?'])).toEqual({ names: ['api', 'web'], text: 'is it in?', json: false })
    expect(parseSendArgs(['api', '--text-file', 'note.md', '--json'], () => 'from file')).toEqual({ names: ['api'], text: 'from file', json: true })
    // After the recipients, dashes are the message's own.
    expect(parseSendArgs(['api', '---', 'do', 'not', '--force', 'push'])).toEqual({ names: ['api'], text: '--- do not --force push', json: false })
  })

  it('refuses what it cannot read, with the usage', () => {
    for (const argv of [['--text-file'], ['--help'], ['-h'], ['--weird'], ['--text-file', 'x']]) {
      expect(() => parseSendArgs(argv, () => 'text')).toThrow(MessageError)
    }
    expect(() => parseSendArgs([',', 'text'])).toThrow(SEND_USAGE)
  })
})

describe('the pane\'s own daemon', () => {
  it('is the one the pane\'s owner tag names in the hook routes', () => {
    const tag = '0123456789abcdef'
    writeFileSync(join(dir, `${tag}.json`), JSON.stringify({ dataDir: '/data/dev', port: 18999 }))
    expect(paneOwner('%3', () => `${tag}\n`, dir)).toEqual({ port: 18999, dataDir: '/data/dev' })
    expect(paneOwner('%3', () => 'not-a-tag', dir)).toBeNull()
    expect(paneOwner('%3', () => { throw new Error('no tmux') }, dir)).toBeNull()
    writeFileSync(join(dir, `${tag}.json`), JSON.stringify({ dataDir: 'relative', port: 18999 }))
    expect(paneOwner('%3', () => tag, dir)).toBeNull()
  })
})

describe('what harness send prints', () => {
  it('says what became of the message for each teammate, or the roster', () => {
    expect(formatSent({ roster: 'Teammates: api' })).toBe('Teammates: api')
    expect(formatSent({ roster: 'Teammates: api', recent: [
      { id: 'm1', to: ['api', 'web'], text: 'first line\nmore', state: 'delivered' },
      { id: 'm2', from: 'api', text: 'x'.repeat(200), state: 'queued' },
    ] })).toBe(`Teammates: api\n\nYour last messages:\n  [m1 to api, web] first line (delivered)\n  [m2 from api] ${'x'.repeat(157)}… (queued)`)
    expect(formatSent({ roster: 'Teammates: api', recent: [{ id: 'm3', from: 'api', state: 'failed' }] })).toBe('Teammates: api\n\nYour last messages:\n  [m3 from api]  (failed)')
    expect(formatSent({ id: 'm1234567', recipients: [
      { name: 'api', state: 'delivered', via: 'prompt' },
      { name: 'web', state: 'queued', reason: 'working: arrives at its next tool call' },
      { name: 'phone', state: 'delivered', via: 'hook' },
    ] })).toBe([
      'm1234567 → api: delivered (as a prompt)',
      'm1234567 → web: queued · working: arrives at its next tool call',
      'm1234567 → phone: delivered (at its tool call)',
    ].join('\n'))
    expect(formatSent({})).toBe('')
  })

  it('asks the pane\'s daemon, and prints its answer or its error', async () => {
    const out: string[] = [], err: string[] = []
    const asked: Array<Record<string, unknown>> = []
    const rpc: Rpc = async (target, payload) => {
      asked.push({ ...payload, port: target.port })
      if (payload.text === 'fail') throw new MessageError('MESSAGES_OFF', 'Agent Messages are off in this tab.')
      return { id: 'm1234567', recipients: [{ name: 'api', state: 'queued' }] }
    }
    const io = { rpc, out: (l: string) => out.push(l), err: (l: string) => err.push(l), pane: '%4', owner: () => ({ port: 19000, dataDir: '/d' }) }
    expect(await sendCommand(['api', 'hello'], io)).toBe(0)
    expect(asked[0]).toEqual({ action: 'send', pane: '%4', to: ['api'], text: 'hello', port: 19000 })
    expect(out.at(-1)).toBe('m1234567 → api: queued')
    expect(await sendCommand(['api', 'hello', '--json'], io)).toBe(0)
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ id: 'm1234567' })
    expect(await sendCommand(['api', 'fail'], io)).toBe(1)
    expect(err.at(-1)).toBe('Agent Messages are off in this tab.')
    expect(await sendCommand(['api', 'fail', '--json'], io)).toBe(1)
    expect(JSON.parse(out.at(-1)!)).toEqual({ error: 'MESSAGES_OFF', detail: 'Agent Messages are off in this tab.' })
    expect(await sendCommand([], { ...io, owner: () => null })).toBe(0)
    expect(asked.at(-1)).toMatchObject({ action: 'send', pane: '%4' })
    expect(asked.at(-1)).not.toHaveProperty('to')
    const failing: Rpc = async () => { throw new Error('plain') }
    expect(await sendCommand(['api', 'x', '--json'], { ...io, rpc: failing })).toBe(1)
    expect(JSON.parse(out.at(-1)!)).toEqual({ error: 'FAILED', detail: 'plain' })
  })

  it('refuses outside a pane, and bad arguments', async () => {
    const err: string[] = []
    expect(await sendCommand(['api', 'x'], { pane: undefined, err: (l) => err.push(l) })).toBe(1)
    expect(err.at(-1)).toMatch(/harness pane/)
    expect(await sendCommand(['--nope'], { err: (l) => err.push(l) })).toBe(2)
    expect(err.at(-1)).toBe(SEND_USAGE)
  })
})
