/**
 * PERSON-ONLY (daemons/LEARNING.md, "Security"): the one-time nonces, finding the process at the other end
 * of a loopback connection, refusing one that descends from a harness pane, and the CLI's own check. No real
 * tmux, lsof or process table: every source is injected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  APPROVAL_NONCE_TTL_MS, ApprovalNonces, ancestry, harnessPaneEnv, lessonKeyVerdict, lessonLineId, loopbackPeerPid, parseLsofPeer,
  procSocketInode, verifyPerson, type CallerDeps,
} from './approval.js'

describe('one-time nonces', () => {
  it('are spent once, for the action, lesson and process they were issued to, within two minutes', () => {
    let now = 1_000
    const nonces = new ApprovalNonces(() => now)
    const a = nonces.issue('approve', 'beef01', 42)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(nonces.consume('approve', 'beef01', a, 42)).toBe(true)
    expect(nonces.consume('approve', 'beef01', a, 42)).toBe(false)                       // one use
    const b = nonces.issue('approve', 'beef01', 42)
    expect(nonces.consume('approve', 'beef01', b, 43)).toBe(false)                       // another process
    expect(nonces.consume('approve', 'beef01', b, 42)).toBe(false)                       // and a wrong try spends it
    const c = nonces.issue('approve', 'beef01', 42)
    expect(nonces.consume('restore', 'beef01', c, 42)).toBe(false)
    const d = nonces.issue('approve', 'beef01', 42)
    expect(nonces.consume('approve', 'beef02', d, 42)).toBe(false)
    const e = nonces.issue('approve', 'beef01', 42)
    now += APPROVAL_NONCE_TTL_MS
    expect(nonces.consume('approve', 'beef01', e, 42)).toBe(false)                       // expired
    for (const bad of [undefined, '', 'x'.repeat(32), 42, 'AB'.repeat(16)]) expect(nonces.consume('approve', 'beef01', bad, 42)).toBe(false)
  })

  it('keep one live nonce per action and lesson: a new challenge replaces the old one', () => {
    const nonces = new ApprovalNonces(() => 1)
    const first = nonces.issue('approve', 'beef01', 1)
    const second = nonces.issue('approve', 'beef01', 1)
    expect(nonces.consume('approve', 'beef01', first, 1)).toBe(false)
    expect(nonces.consume('approve', 'beef01', second, 1)).toBe(true)
  })

  it('a key line\'s id carries one', () => {
    const a = lessonLineId('beef01')
    expect(a).toMatch(/^lesson:beef01:[0-9a-f]{32}$/)
    expect(lessonLineId('beef01')).not.toBe(a)
  })
})

describe('who is asking', () => {
  // init(1) → launchd-ish 10 → terminal 20 → shell 21 → harness CLI 22;  tmux server 30 → pane shell 31 → agent 32 → its CLI 33
  const rows = [
    { pid: 10, parentPid: 1 }, { pid: 20, parentPid: 10 }, { pid: 21, parentPid: 20 }, { pid: 22, parentPid: 21 },
    { pid: 30, parentPid: 1 }, { pid: 31, parentPid: 30 }, { pid: 32, parentPid: 31 }, { pid: 33, parentPid: 32 },
    { pid: 40, parentPid: 1 }, { pid: 41, parentPid: 40 },
  ]
  const deps = (patch: Partial<CallerDeps> = {}, pids: Record<number, number> = { 5001: 22, 5002: 33, 5003: 41 }): CallerDeps => ({
    peerPort: (connId) => (connId === 'unix' ? null : Number(connId)),
    localPort: () => 7777,
    peerPid: async (port) => pids[port] ?? null,
    processes: async () => rows,
    harnessPanePids: async () => [31],
    selfPid: 40,
    ...patch,
  })

  it('walks a process up to init', () => {
    expect(ancestry(33, rows)).toEqual([33, 32, 31, 30])
    expect(ancestry(99, rows)).toEqual([99])
    expect(ancestry(5, [{ pid: 5, parentPid: 6 }, { pid: 6, parentPid: 5 }])).toEqual([5, 6])   // a loop ends
  })

  it('a terminal outside Harness is the person; an agent in a pane, or anything the daemon started, is not', async () => {
    expect(await verifyPerson('5001', deps())).toEqual({ ok: true, pid: 22 })
    expect(await verifyPerson('5002', deps())).toMatchObject({ ok: false, error: 'INSIDE_HARNESS' })
    expect(await verifyPerson('5003', deps())).toMatchObject({ ok: false, error: 'INSIDE_HARNESS' })
  })

  it('fails closed when it cannot tell: the Unix socket, no process found, no process table, no pane list', async () => {
    expect(await verifyPerson('unix', deps())).toMatchObject({ ok: false, error: 'UNVERIFIED' })
    expect(await verifyPerson('5009', deps())).toMatchObject({ ok: false, error: 'UNVERIFIED' })
    expect(await verifyPerson('5001', deps({ processes: async () => null }))).toMatchObject({ ok: false, error: 'UNVERIFIED' })
    expect(await verifyPerson('5001', deps({ harnessPanePids: async () => null }))).toMatchObject({ ok: false, error: 'UNVERIFIED' })
    expect(await verifyPerson('5001', deps({ peerPid: async () => { throw new Error('lsof') } }))).toMatchObject({ ok: false, error: 'UNVERIFIED' })
    expect(await verifyPerson('5001', deps({ localPort: () => null }))).toMatchObject({ ok: false, error: 'UNVERIFIED' })
  })

  it('a key on a lesson: never a tool client, never a process inside a harness; a window it cannot see holds the nonce', async () => {
    const verify = (connId: string) => verifyPerson(connId, deps())
    expect(await lessonKeyVerdict('5001', { isTool: () => true, verify })).toMatchObject({ ok: false, error: 'PERSON_ONLY' })
    expect(await lessonKeyVerdict('5002', { isTool: () => false, verify })).toMatchObject({ ok: false, error: 'INSIDE_HARNESS' })
    expect(await lessonKeyVerdict('unix', { isTool: () => false, verify })).toEqual({ ok: true })
    expect(await lessonKeyVerdict('5001', { isTool: () => false, verify })).toEqual({ ok: true })
  })
})

describe('the process at the other end of a loopback connection', () => {
  const lsof = [
    'p700', 'f12', 'n127.0.0.1:7777->127.0.0.1:52001',           // the daemon's own end
    'p900', 'f5', 'n127.0.0.1:52001->127.0.0.1:7777',            // the caller
    'p901', 'f5', 'n127.0.0.1:52002->127.0.0.1:7777',
  ].join('\n')

  it('lsof: the pid whose local port is the caller\'s and whose remote is the daemon\'s, never the daemon', async () => {
    expect(parseLsofPeer(lsof, 52001, 7777, 700)).toBe(900)
    expect(parseLsofPeer(lsof, 52003, 7777, 700)).toBeNull()
    expect(parseLsofPeer('p700\nn127.0.0.1:52001->127.0.0.1:7777', 52001, 7777, 700)).toBeNull()
    const calls: string[][] = []
    expect(await loopbackPeerPid(52001, 7777, { selfPid: 700, platform: 'darwin', run: async (file, args) => { calls.push([file, ...args]); return lsof } })).toBe(900)
    expect(calls[0]).toEqual(['lsof', '-nP', '-iTCP:52001', '-sTCP:ESTABLISHED', '-Fpn'])
    expect(await loopbackPeerPid(52001, 7777, { selfPid: 700, platform: 'darwin', run: async () => null })).toBeNull()
  })

  let proc: string
  beforeEach(() => { proc = mkdtempSync(join(tmpdir(), 'learn-proc-')) })
  afterEach(() => rmSync(proc, { recursive: true, force: true }))

  it('Linux without lsof: /proc/net/tcp finds the socket, /proc/<pid>/fd finds its process', async () => {
    const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
    const port = (n: number) => n.toString(16).toUpperCase().padStart(4, '0')
    const tcp = [header,
      `   0: 0100007F:${port(7777)} 0100007F:${port(52001)} 01 00000000:00000000 00:00000000 00000000   501        0 11111 1`,
      `   1: 0100007F:${port(52001)} 0100007F:${port(7777)} 01 00000000:00000000 00:00000000 00000000   501        0 22222 1`,
    ].join('\n')
    expect(procSocketInode([tcp], 52001, 7777)).toBe('22222')
    expect(procSocketInode([tcp], 52009, 7777)).toBeNull()
    mkdirSync(join(proc, 'net'))
    writeFileSync(join(proc, 'net', 'tcp'), tcp)
    for (const [pid, inode] of [['700', '11111'], ['901', '33333'], ['900', '22222']] as const) {
      mkdirSync(join(proc, pid, 'fd'), { recursive: true })
      symlinkSync(`socket:[${inode}]`, join(proc, pid, 'fd', '5'))
    }
    expect(await loopbackPeerPid(52001, 7777, { selfPid: 700, platform: 'linux', proc, run: async () => null })).toBe(900)
    expect(await loopbackPeerPid(52009, 7777, { selfPid: 700, platform: 'linux', proc, run: async () => null })).toBeNull()
  })
})

describe('the CLI\'s own check', () => {
  it('knows the variables Harness sets in its panes', () => {
    expect(harnessPaneEnv({})).toBeNull()
    expect(harnessPaneEnv({ HARNESS_CONTEXT_FILE: '/p/.harness/runtime/k/CONTEXT.md' })).toBe('HARNESS_CONTEXT_FILE')
    expect(harnessPaneEnv({ HARNESSD_PAIR_TOKEN_FILE: '/t' })).toBe('HARNESSD_PAIR_TOKEN_FILE')
    expect(harnessPaneEnv({ HARNESS_DSH: '' })).toBeNull()
  })
})
