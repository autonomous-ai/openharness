import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Ledger, ledgerPath, parseStarted, ROTATE_BYTES, type Started } from './ledger.js'

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

  it('answers parents, children, depth and links from what was appended', () => {
    const ledger = fresh()
    ledger.append(row('lead', 'a'))
    ledger.append(row('lead', 'b'))
    ledger.append(row('a', 'a1', 2))
    expect(ledger.childrenOf({ machineId: 'm', agentId: 'lead' }).map((r) => r.child.agentId)).toEqual(['a', 'b'])
    expect(ledger.parentOf({ machineId: 'm', agentId: 'a1' })?.by.agentId).toBe('a')
    expect(ledger.depthOf({ machineId: 'm', agentId: 'a1' })).toBe(2)
    expect(ledger.linked({ machineId: 'm', agentId: 'a' }, { machineId: 'm', agentId: 'lead' })).toBe(true)
    expect(ledger.linked({ machineId: 'm', agentId: 'b' }, { machineId: 'm', agentId: 'a' })).toBe(false)
    expect(ledger.links({ machineId: 'm', agentId: 'a' })).toEqual([{ machineId: 'm', agentId: 'lead' }, { machineId: 'm', agentId: 'a1' }])
    // Another machine's harness with the same id is another harness.
    expect(ledger.links({ machineId: 'other', agentId: 'a' })).toEqual([])
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
})
