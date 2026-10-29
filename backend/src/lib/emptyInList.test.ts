import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unguardedInLists } from './emptyInList.test-support.js'

const lint = (code: string) => unguardedInLists(code, 'case.ts').map(f => f.list)

describe('the empty id list check', () => {
  it('flags a list in a variable that is never tested first', () => {
    expect(lint(`async function f(tx, ids: string[]) { return tx.machine.findMany({ where: { machineId: { in: ids } } }) }`)).toEqual(['ids'])
    expect(lint(`async function f(tx, rows) { return tx.user.findMany({ where: { id: { in: rows.map(r => r.id) } } }) }`)).toEqual(['rows.map(r => r.id)'])
    expect(lint(`async function f(db, ids) { return db.superTab.findMany({ where: { id: { in: ids } } }) }`)).toEqual(['ids'])
    expect(lint(`async function f(db, ids) { return db.superTab.aggregateRaw({ pipeline: [{ $match: { _id: { $in: ids } } }] }) }`)).toEqual(['ids'])
  })

  it('accepts a list tested earlier in the function, or around the call', () => {
    expect(lint(`async function f(tx, ids) { if (!ids.length) return []; return tx.machine.findMany({ where: { machineId: { in: ids } } }) }`)).toEqual([])
    expect(lint(`async function f(tx, share) { return share.emails.length ? tx.user.findMany({ where: { email: { in: share.emails } } }) : [] }`)).toEqual([])
    expect(lint(`async function f(tx, ids) { return ids.size && tx.user.findMany({ where: { id: { in: ids } } }) }`)).toEqual([])
  })

  it('does not count a test in another function, or one after the read', () => {
    expect(lint(`function a(ids) { if (!ids.length) return }\nasync function f(tx, ids) { return tx.machine.findMany({ where: { machineId: { in: ids } } }) }`)).toEqual(['ids'])
    expect(lint(`async function f(tx, ids) { const rows = await tx.machine.findMany({ where: { machineId: { in: ids } } }); if (!ids.length) return [] }`)).toEqual(['ids'])
  })

  it('counts a test of the list a map or a set was built from, not of a filtered one', () => {
    expect(lint(`async function f(tx, rows) { if (!rows.length) return []; return tx.user.findMany({ where: { id: { in: rows.map(r => r.id) } } }) }`)).toEqual([])
    expect(lint(`async function f(tx, rows) { if (!rows.length) return []; return tx.user.findMany({ where: { id: { in: [...new Set(rows.map(r => r.id))] } } }) }`)).toEqual([])
    expect(lint(`async function f(tx, rows) { if (!rows.length) return []; return tx.user.findMany({ where: { id: { in: rows.filter(r => r.ok).map(r => r.id) } } }) }`))
      .toEqual(['rows.filter(r => r.ok).map(r => r.id)'])
  })

  it('follows a const to what it was built from', () => {
    expect(lint(`async function f(tx, usable) { if (!usable.length) return []; const ids = [...new Set(usable.map(u => u.id))]; return tx.user.findMany({ where: { id: { in: ids } } }) }`)).toEqual([])
    expect(lint(`async function f(tx, usable) { const ids = usable.filter(u => u.ok); return tx.user.findMany({ where: { id: { in: ids } } }) }`)).toEqual(['ids'])
  })

  it('accepts a literal list, a constant and other models', () => {
    expect(lint(`async function f(tx) { return tx.machine.findMany({ where: { authMode: { in: BILLED_MODES } } }) }`)).toEqual([])
    expect(lint(`async function f(tx) { return tx.machine.findMany({ where: { sessionKind: { in: ['team', 'person'] } } }) }`)).toEqual([])
    expect(lint(`async function f(tx, ids) { return tx.swarmMachine.findMany({ where: { tabId: { in: ids } } }) }`)).toEqual([])
  })

  it('finds none in the backend: no read of machines, users or SuperTab can send an empty list', () => {
    const root = join(process.cwd(), 'src')
    const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? files(path) : /\.ts$/.test(name) && !/\.test(-support)?\.ts$/.test(name) ? [path] : []
    })
    const found = files(root).flatMap(file => unguardedInLists(readFileSync(file, 'utf8'), relative(process.cwd(), file)))
    expect(found.map(f => `${f.file}:${f.line} ${f.list}`)).toEqual([])
  })
})
