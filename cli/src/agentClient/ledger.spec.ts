import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Ledger, LedgerBusyError, ledgerPath, parsePending, parseStarted, PENDING_WITHIN_MS, ROTATE_BYTES, type Closed, type Pending, type Started, type Told } from './ledger.js'

const dirs: string[] = []
const fresh = (): Ledger => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
  dirs.push(dir)
  return new Ledger(ledgerPath(dir))
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const row = (by: string, child: string, depth = 1, at = 1): Started => ({
  at, depth,
  by: { machineId: 'm', agentId: by, name: by, engine: 'claude' },
  child: { machineId: 'm', agentId: child, name: child },
})

describe('the ledger of who started which harness', () => {
  it('reads nothing from a file that is not there', () => {
    const ledger = fresh()
    expect(ledger.all()).toEqual([])
    expect(ledger.parentOf({ machineId: 'm', agentId: 'x' })).toBeNull()
    expect(ledger.depthOf({ machineId: 'm', agentId: 'x' })).toBe(0)
  })

  it('answers parents, children and depth from what was appended', () => {
    const ledger = fresh()
    ledger.append(row('lead', 'a'))
    ledger.append(row('lead', 'b'))
    ledger.append(row('a', 'a1', 2))
    expect(ledger.childrenOf({ machineId: 'm', agentId: 'lead' }).map((r) => r.child.agentId)).toEqual(['a', 'b'])
    expect(ledger.parentOf({ machineId: 'm', agentId: 'a1' })?.by.agentId).toBe('a')
    expect(ledger.depthOf({ machineId: 'm', agentId: 'a1' })).toBe(2)
    // Another machine's harness with the same id is another harness.
    expect(ledger.childrenOf({ machineId: 'other', agentId: 'lead' })).toEqual([])
    expect(ledger.parentOf({ machineId: 'other', agentId: 'a1' })).toBeNull()
    expect(statSync(ledger.path).mode & 0o777).toBe(0o600)
  })

  it('reads the file again only when it changed, and skips lines it cannot read', () => {
    const ledger = fresh()
    ledger.append(row('lead', 'a'))
    const first = ledger.all()
    expect(ledger.all()).toBe(first)
    writeFileSync(ledger.path, `${readFileSync(ledger.path, 'utf8')}not json\n{"at":1}\n${JSON.stringify(row('lead', 'b'))}\n`)
    expect(ledger.all().map((r) => r.child.agentId)).toEqual(['a', 'b'])
  })

  it('moves its lines aside past its size, and still reads them', () => {
    const ledger = fresh()
    ledger.append(row('lead', 'first'))
    writeFileSync(ledger.path, `${JSON.stringify(row('lead', 'first'))}\n`.padEnd(ROTATE_BYTES + 1, ' ') + '\n')
    ledger.append(row('lead', 'second'))
    expect(existsSync(ledger.previous)).toBe(true)
    expect(existsSync(ledger.path)).toBe(false)
    ledger.append(row('lead', 'third'))
    expect(ledger.all().map((r) => r.child.agentId)).toEqual(['first', 'second', 'third'])
  })

  it('checks every line it reads', () => {
    expect(parseStarted('')).toBeNull()
    expect(parseStarted('null')).toBeNull()
    expect(parseStarted(JSON.stringify({ ...row('a', 'b'), depth: 0 }))).toBeNull()
    expect(parseStarted(JSON.stringify({ ...row('a', 'b'), by: { machineId: 'm' } }))).toBeNull()
    expect(parseStarted(JSON.stringify({ ...row('a', 'b'), child: { machineId: '', agentId: 'b' } }))).toBeNull()
    const bare = { at: 1, depth: 1, by: { machineId: 'm', agentId: 'a' }, child: { machineId: 'm', agentId: 'b' } }
    expect(parseStarted(JSON.stringify(bare))).toEqual({ at: 1, depth: 1, by: { machineId: 'm', agentId: 'a', name: '', engine: '' }, child: { machineId: 'm', agentId: 'b', name: '' } })
  })

  it('keeps a harness asked for and not started until it has a started line, for half an hour, one line a creation', () => {
    const ledger = fresh()
    const lead = { machineId: 'm', agentId: 'lead' }
    const asked = (creationId: string, at = 10, name = 'cx'): Pending => ({ at, depth: 1, by: { ...lead, name: 'lead', engine: 'claude' },
      creation: { machineId: 'm', creationId, name, engine: 'codex' } })
    ledger.append(asked('c1')); ledger.append(asked('c1', 20, 'cx2')); ledger.append(asked('c2')); ledger.append(asked('c3', 10 - PENDING_WITHIN_MS))
    ledger.append(row('other', 'x'))
    expect(ledger.pendingOf(lead, 10).map((p) => [p.creation.creationId, p.creation.name])).toEqual([['c1', 'cx2'], ['c2', 'cx']])
    expect(ledger.pendingOf({ machineId: 'm', agentId: 'other' }, 10)).toEqual([])
    // Started: its line names the creation, and it is no longer pending. Older readers see only started lines.
    ledger.append({ ...row('lead', 'k1'), child: { machineId: 'm', agentId: 'k1', name: 'cx', creationId: 'c1' } })
    expect(ledger.pendingOf(lead, 10).map((p) => p.creation.creationId)).toEqual(['c2'])
    expect(ledger.all().map((r) => r.child.agentId)).toEqual(['x', 'k1'])
    expect(ledger.parentOf({ machineId: 'm', agentId: 'k1' })?.child.creationId).toBe('c1')
    // Recorded once, whichever verb sees it made first.
    ledger.record({ ...row('lead', 'k1'), child: { machineId: 'm', agentId: 'k1', name: 'cx', creationId: 'c1' } })
    ledger.record(row('lead', 'k2'))
    expect(ledger.all().map((r) => r.child.agentId)).toEqual(['x', 'k1', 'k2'])
  })

  it('checks every pending line it reads', () => {
    const line = { at: 1, depth: 1, by: { machineId: 'm', agentId: 'a' }, creation: { machineId: 'm', creationId: 'c' } }
    expect(parsePending(JSON.stringify(line))).toEqual({ at: 1, depth: 1, by: { machineId: 'm', agentId: 'a', name: '', engine: '' }, creation: { machineId: 'm', creationId: 'c', name: '', engine: '' } })
    for (const bad of ['', 'null', JSON.stringify({ ...line, depth: 0 }), JSON.stringify({ ...line, creation: { machineId: 'm' } }), JSON.stringify({ ...line, creation: undefined })]) {
      expect(parsePending(bad), bad).toBeNull()
    }
  })
})

describe('one lock for every writer of the ledger', () => {
  const ME = { machineId: 'm', agentId: 'lead' }
  const KID = { machineId: 'm', agentId: 'kid' }
  const STARTED = row('lead', 'kid')
  const told = (agentId: string, probe: string): Told => ({ at: 1, by: ME, told: { machineId: 'm', agentId }, probe })
  const CLOSED: Closed = { at: 1, by: ME, closed: KID }
  const lines = (...rows: unknown[]): string => rows.map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n'
  const placed = (): Ledger => {
    const ledger = fresh()
    mkdirSync(dirname(ledger.path), { recursive: true })
    return ledger
  }
  // Another process's writer: it writes the lock naming itself, and lets go 300 ms later.
  const HOLD_LOCK = `const fs = require('node:fs'); const lock = process.argv[1]
fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startMarker: '' }), { flag: 'wx', mode: 0o600 })
setTimeout(() => fs.unlinkSync(lock), 300)`
  const until = (ok: () => boolean): Promise<true> => vi.waitUntil(ok, { timeout: 10_000, interval: 5 })
  const exited = async (child: ChildProcess): Promise<number | null> => child.exitCode ?? (await once(child, 'exit'))[0] as number | null
  // A process that ran and was reaped: its pid names no one.
  const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid

  it('forgets what a harness was told, in both files, and keeps every other line', () => {
    const ledger = placed()
    writeFileSync(ledger.previous, lines(STARTED, told('kid', 'email zanzibar'), told('other', 'keep me')))
    writeFileSync(ledger.path, lines(CLOSED, told('kid', 'again'), 'not json'))
    expect(ledger.forgetTold('kid')).toBe(2)
    const text = readFileSync(ledger.previous, 'utf8') + readFileSync(ledger.path, 'utf8')
    expect(text).not.toContain('zanzibar'); expect(text).not.toContain('again')
    expect(text).toContain('keep me'); expect(text).toContain('not json')
    // Every other line, byte for byte.
    expect(readFileSync(ledger.previous, 'utf8')).toBe(lines(STARTED, told('other', 'keep me')))
    expect(readFileSync(ledger.path, 'utf8')).toBe(lines(CLOSED, 'not json'))
    expect(ledger.parentOf(KID)).not.toBeNull()
    expect(ledger.closedBy(ME, KID)).not.toBeNull()
    expect(ledger.toldBy(ME, KID)).toBeNull()
    expect(statSync(ledger.path).mode & 0o777).toBe(0o600)
    expect(existsSync(`${ledger.path}.lock`)).toBe(false)
    // Nothing to forget, and no file at all: nothing written.
    expect(ledger.forgetTold('kid')).toBe(0)
    const none = fresh()
    expect(none.forgetTold('kid')).toBe(0)
    expect(existsSync(none.path)).toBe(false)
  })

  it('an append made while another process holds the lock lands once it is released', async () => {
    const ledger = placed()
    const holder = spawn(process.execPath, ['-e', HOLD_LOCK, `${ledger.path}.lock`])
    await until(() => existsSync(`${ledger.path}.lock`))
    ledger.append(STARTED)
    expect(ledger.all()).toHaveLength(1)
    // The append returned after the holder let go, and the holder removed its own lock: it was waited for, not taken.
    expect(existsSync(`${ledger.path}.lock`)).toBe(false)
    expect(await exited(holder)).toBe(0)
  })

  it('takes over a lock whose owner is gone', () => {
    const ledger = placed()
    writeFileSync(`${ledger.path}.lock`, JSON.stringify({ pid: deadPid(), startMarker: '' }))
    ledger.append(STARTED)
    expect(ledger.all()).toHaveLength(1)
    expect(existsSync(`${ledger.path}.lock`)).toBe(false)
  })

  it('gives up after its wait with nothing written, an append and a rewrite alike', () => {
    const path = placed().path
    const held = new Ledger(path, 50)
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.ppid, startMarker: '' }))
    expect(() => held.append(STARTED)).toThrow(new LedgerBusyError())
    expect(() => held.forgetTold('kid')).toThrow('The agent ledger is busy. Try again.')
    expect(existsSync(path)).toBe(false)
    // A live owner's lock is its own.
    expect(existsSync(`${path}.lock`)).toBe(true)
  })
})
