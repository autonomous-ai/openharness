/**
 * PERSON-ONLY, at its edges: a nonce is never guessable by shape, never outlives the cap, never works for
 * another action; the caller check fails closed on every error; and the lsof and /proc lookups survive
 * whatever the machine hands them. lsof is a stub on PATH; /proc is a temp folder.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalNonces, PERSON_ACTIONS, isPersonAction, lessonKeyVerdict, loopbackPeerPid, procSocketInode, verifyPerson, type CallerDeps } from './approval.js'

describe('nonces', () => {
  it('only 32 live at once: the oldest goes first', () => {
    const nonces = new ApprovalNonces(() => 1000)
    const issued = Array.from({ length: 33 }, (_, i) => nonces.issue('approve', `id${i}`))
    expect(nonces.consume('approve', 'id0', issued[0])).toBe(false)
    expect(nonces.consume('approve', 'id1', issued[1])).toBe(true)
    expect(nonces.consume('approve', 'id32', issued[32])).toBe(true)
  })

  it('anything not 32 lowercase hex characters is refused before any compare', () => {
    const nonces = new ApprovalNonces(() => 1, () => Buffer.alloc(16, 0xab))
    const good = nonces.issue('approve', 'abc')
    expect(good).toBe('ab'.repeat(16))
    for (const bad of [undefined, null, 42, { nonce: good }, good.toUpperCase(), good.slice(1), `${good}0`, ` ${good}`, 'zz'.repeat(16)]) {
      expect(nonces.consume('approve', 'abc', bad)).toBe(false)
    }
    expect(nonces.consume('approve', 'abc', good)).toBe(true)
  })

  it('a nonce spent on the wrong action, lesson or process is gone for the right one too', () => {
    const nonces = new ApprovalNonces(() => 1)
    for (const [action, id, pid] of [['restore', 'abc', 7], ['approve', 'abd', 7], ['approve', 'abc', 8]] as const) {
      const n = nonces.issue('approve', 'abc', 7)
      expect(nonces.consume(action, id, n, pid)).toBe(false)
      expect(nonces.consume('approve', 'abc', n, 7)).toBe(false)
    }
  })

  it('knows its person-only actions', () => {
    expect(PERSON_ACTIONS).toEqual(['approve', 'restore', 'export'])
    expect(['approve', 'restore', 'export'].every(isPersonAction)).toBe(true)
    for (const other of ['revert', 'skip', 'APPROVE', '', 'approve ']) expect(isPersonAction(other)).toBe(false)
  })
})

describe('who is asking, when the machine will not say', () => {
  const rows = [{ pid: 20, parentPid: 1 }, { pid: 21, parentPid: 20 }]
  const deps = (patch: Partial<CallerDeps> = {}): CallerDeps => ({
    peerPort: () => 5001, localPort: () => 7777, peerPid: async () => 21, processes: async () => rows, harnessPanePids: async () => [], selfPid: 99, ...patch,
  })

  it('a process table or pane list that throws is UNVERIFIED, never a yes', async () => {
    expect(await verifyPerson('c', deps({ processes: async () => { throw new Error('ps') } }))).toMatchObject({ ok: false, error: 'UNVERIFIED' })
    expect(await verifyPerson('c', deps({ harnessPanePids: async () => { throw new Error('tmux') } }))).toMatchObject({ ok: false, error: 'UNVERIFIED' })
    expect(await verifyPerson('c', deps({ peerPort: () => null }))).toMatchObject({ ok: false, error: 'UNVERIFIED' })
    expect(await verifyPerson('c', deps())).toEqual({ ok: true, pid: 21 })
  })

  it('without a selfPid, the daemon is this process: a child of it is inside Harness', async () => {
    const child = [{ pid: process.pid, parentPid: 1 }, { pid: 424242, parentPid: process.pid }]
    const { selfPid: _drop, ...rest } = deps({ peerPid: async () => 424242, processes: async () => child })
    expect(await verifyPerson('c', rest)).toMatchObject({ ok: false, error: 'INSIDE_HARNESS' })
  })

  it('a key: a verifier that throws lets a window through (it holds the nonce), and an UNVERIFIED one too', async () => {
    expect(await lessonKeyVerdict('c', { isTool: () => false, verify: async () => { throw new Error('boom') } })).toEqual({ ok: true })
    expect(await lessonKeyVerdict('c', { isTool: () => false, verify: async () => ({ ok: false, error: 'UNVERIFIED', detail: 'x' }) })).toEqual({ ok: true })
  })
})

describe('lsof on PATH (a stub)', () => {
  let bin: string
  let path: string | undefined
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'learn-lsof-'))
    path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
  })
  afterEach(() => {
    process.env.PATH = path
    rmSync(bin, { recursive: true, force: true })
  })
  const stub = (script: string) => { writeFileSync(join(bin, 'lsof'), `#!/bin/sh\n${script}\n`); chmodSync(join(bin, 'lsof'), 0o755) }

  it('runs lsof with the connection\'s port and reads its answer', async () => {
    stub(`[ "$1 $2 $3 $4" = "-nP -iTCP:52001 -sTCP:ESTABLISHED -Fpn" ] || exit 2\nprintf 'p900\\nf5\\nn127.0.0.1:52001->127.0.0.1:7777\\n'`)
    expect(await loopbackPeerPid(52001, 7777, { platform: 'darwin' })).toBe(900)
  })

  it('an lsof that fails is no answer; off Linux there is nothing else to ask', async () => {
    stub('echo nope >&2; exit 1')
    expect(await loopbackPeerPid(52001, 7777, { platform: 'darwin', selfPid: 1 })).toBeNull()
  })

  it('never answers with the daemon itself', async () => {
    stub(`printf 'p${process.pid}\\nn127.0.0.1:52001->127.0.0.1:7777\\np901\\nn127.0.0.1:52001->127.0.0.1:7777\\n'`)
    expect(await loopbackPeerPid(52001, 7777, { platform: 'darwin' })).toBe(901)
  })
})

describe('/proc on Linux, as the machine hands it over', () => {
  let proc: string
  beforeEach(() => { proc = mkdtempSync(join(tmpdir(), 'learn-proc-more-')) })
  afterEach(() => { try { chmodSync(proc, 0o755) } catch { /* gone */ } rmSync(proc, { recursive: true, force: true }) })
  const port = (n: number) => n.toString(16).toUpperCase().padStart(4, '0')
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
  const row = (local: number, remote: number, st = '01', inode = '22222') => `   1: 0100007F:${port(local)} 0100007F:${port(remote)} ${st} 00000000:00000000 00:00000000 00000000   501        0 ${inode} 1`

  it('only an ESTABLISHED row with both ports; short or odd rows are passed over', () => {
    const table = [header, '   0: short row', '   2: 0100007F 0100007F 01 0 0 0 0 0 0 99999', row(52001, 7777, '0A', '11111'), row(52001, 7777)].join('\n')
    expect(procSocketInode([table], 52001, 7777)).toBe('22222')
    expect(procSocketInode(['', table.replace(row(52001, 7777), '')], 52001, 7777)).toBeNull()
    // tcp6 is read too.
    expect(procSocketInode(['', [header, row(52001, 7777, '01', '66666')].join('\n')], 52001, 7777)).toBe('66666')
  })

  function tables(): void {
    mkdirSync(join(proc, 'net'))
    writeFileSync(join(proc, 'net', 'tcp'), [header, row(52001, 7777)].join('\n'))
  }

  it('a process with no fd folder, an fd that is not a link, and a process that owns no match: none is the answer', async () => {
    tables()
    mkdirSync(join(proc, '100'))
    mkdirSync(join(proc, '101', 'fd'), { recursive: true })
    writeFileSync(join(proc, '101', 'fd', '3'), 'not a link')
    mkdirSync(join(proc, '102', 'fd'), { recursive: true })
    symlinkSync('socket:[99999]', join(proc, '102', 'fd', '4'))
    mkdirSync(join(proc, 'self'))
    expect(await loopbackPeerPid(52001, 7777, { selfPid: 1, platform: 'linux', proc, run: async () => null })).toBeNull()
    mkdirSync(join(proc, '103', 'fd'), { recursive: true })
    symlinkSync('socket:[22222]', join(proc, '103', 'fd', '9'))
    expect(await loopbackPeerPid(52001, 7777, { selfPid: 1, platform: 'linux', proc, run: async () => null })).toBe(103)
    // The daemon's own socket is never the answer.
    expect(await loopbackPeerPid(52001, 7777, { selfPid: 103, platform: 'linux', proc, run: async () => null })).toBeNull()
  })

  it('a /proc it cannot list is no answer', async () => {
    tables()
    mkdirSync(join(proc, '103', 'fd'), { recursive: true })
    symlinkSync('socket:[22222]', join(proc, '103', 'fd', '9'))
    chmodSync(proc, 0o311)
    expect(await loopbackPeerPid(52001, 7777, { selfPid: 1, platform: 'linux', proc, run: async () => null })).toBeNull()
  })

  it('lsof wins when it answers, even on Linux', async () => {
    tables()
    expect(await loopbackPeerPid(52001, 7777, { selfPid: 1, platform: 'linux', proc, run: async () => 'p555\nn127.0.0.1:52001->127.0.0.1:7777\n' })).toBe(555)
  })
})
