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

  it('follows a filter built in its own variable and passed to the read', () => {
    expect(lint(`async function f(tx, ids) { const where = { id: { in: ids } }; return tx.user.findMany({ where }) }`)).toEqual(['ids'])
    expect(lint(`async function f(tx, ids) { const filter = { id: { in: ids }, active: true }; return tx.user.findMany({ where: filter }) }`)).toEqual(['ids'])
    expect(lint(`async function f(tx, ids) { const base = { id: { in: ids } }; return tx.machine.findMany({ where: { ...base, ok: true } }) }`)).toEqual(['ids'])
    expect(lint(`async function f(tx, ids) { if (!ids.length) return []; const where = { id: { in: ids } }; return tx.user.findMany({ where }) }`)).toEqual([])
    // A filter for another model, or one never passed to a read of these three, is not this check's business.
    expect(lint(`async function f(tx, ids) { const where = { id: { in: ids } }; return tx.swarmMachine.findMany({ where }) }`)).toEqual([])
  })

  it('counts only a test that tells empty from not empty', () => {
    const read = `return tx.user.findMany({ where: { id: { in: ids } } })`
    const guarded = ['if (!ids.length) return []', 'if (ids.length === 0) return []', 'if (ids.length == 0) return []', 'if (0 === ids.length) return []',
      'if (ids.length < 1) return []', 'if (ids.length <= 0) return []', 'if (ids.length > 0) { return tx.user.findMany({ where: { id: { in: ids } } }) }',
      'if (ids.length !== 0) { return tx.user.findMany({ where: { id: { in: ids } } }) }', 'if (ids.length >= 1) { return tx.user.findMany({ where: { id: { in: ids } } }) }',
      'if (ids.length) { return tx.user.findMany({ where: { id: { in: ids } } }) }', 'if (!ids.size) return []', 'if (!ids.length || ok) return []']
    for (const guard of guarded) {
      const code = guard.includes('return tx') ? `async function f(tx, ids) { ${guard} return [] }` : `async function f(tx, ids) { ${guard}; ${read} }`
      expect(lint(code), guard).toEqual([])
    }
    // Looking at the length is not testing it: these let an empty list through.
    for (const guard of ['if (ids.length > 5) return []', 'if (ids.length === 3) return []', 'if (ids.length < max) return []', 'if (!ok) return [ids.length]',
      'console.log(ids.length)', 'if (xids.length === 0) return []',
      'if (ids.lengthy === 0) return []', 'if (!ok && ids.length > 5) return []']) {
      expect(lint(`async function f(tx, ids) { ${guard}; ${read} }`), guard).toEqual(['ids'])
    }
  })

  it('counts a comparison only when it tells empty from not empty', () => {
    const read = `return tx.user.findMany({ where: { id: { in: ids } } })`
    // Empty or not empty, whichever way round the two sides are written.
    for (const test of ['ids.length === 0', 'ids.length == 0', 'ids.length !== 0', 'ids.length != 0', 'ids.length > 0', 'ids.length <= 0', 'ids.length < 1', 'ids.length >= 1',
      '0 === ids.length', '0 !== ids.length', '0 < ids.length', '0 >= ids.length', '1 > ids.length', '1 <= ids.length']) {
      expect(lint(`async function f(tx, ids) { if (${test}) return []; ${read} }`), test).toEqual([])
    }
    // Always or never true, or about some other size: the empty list still goes through.
    for (const test of ['ids.length < 0', 'ids.length >= 0', 'ids.length > 1', 'ids.length <= 1', 'ids.length === 1', 'ids.length !== 1', 'ids.length < 2', 'ids.length >= 2',
      '0 > ids.length', '0 <= ids.length', '1 < ids.length', '1 >= ids.length', '0 === ids.length + 1']) {
      expect(lint(`async function f(tx, ids) { if (${test}) return []; ${read} }`), test).toEqual(['ids'])
    }
  })

  it('reads the filter variable visible at the read, not another of the same name', () => {
    // An unused inner `where` does not hide the unsafe one the read uses.
    expect(lint(`async function f(tx, ids) { const where = { id: { in: ids } }; { const where = { ok: true }; use(where) } return tx.user.findMany({ where }) }`)).toEqual(['ids'])
    // An unsafe filter in an inner block is not the one the read uses.
    expect(lint(`async function f(tx, ids, x) { const where = { ok: true }; if (x) { const where = { id: { in: ids } }; use(where) } return tx.user.findMany({ where }) }`)).toEqual([])
    // The read inside the inner block sees the inner one.
    expect(lint(`async function f(tx, ids, x) { const where = { ok: true }; if (x) { const where = { id: { in: ids } }; return tx.user.findMany({ where }) } }`)).toEqual(['ids'])
    // A filter the check cannot see into is flagged, not passed: a parameter, one declared after the read, a call's result, an import.
    expect(lint(`async function f(tx, ids) { const where = { id: { in: ids } }; return (where2 => tx.user.findMany({ where: where2 }))({ ok: true }) }`)).toEqual(['where2'])
    expect(lint(`async function f(tx, ids) { const where = { id: { in: ids } }; const g = (where) => tx.user.findMany({ where }); return g }`)).toEqual(['where'])
    expect(lint(`async function f(tx, ids) { const found = tx.user.findMany({ where }); const where = { id: { in: ids } }; return found }`)).toEqual(['where'])
    expect(lint(`async function f(tx, ids) { const where = buildWhere(ids); return tx.user.findMany({ where }) }`)).toEqual(['where'])
    // An import is fixed when the module loads: it holds no list of this call.
    expect(lint(`import { where } from './w.js'\nasync function f(tx) { return tx.machine.findMany({ where }) }`)).toEqual([])
    expect(lint(`import { machineAlive } from './prisma.js'\nasync function f(tx) { return tx.machine.findMany({ where: { ...machineAlive, ok: true } }) }`)).toEqual([])
    expect(lint(`async function f(tx, args) { return tx.user.findMany(args) }`)).toEqual(['args'])
    // Known limit: a spread of a name it cannot see into is a part of a filter, and passes.
    expect(lint(`async function f(tx, base) { return tx.user.findMany({ where: { ...base, ok: true } }) }`)).toEqual([])
    // A spread it can see into is followed, through a conditional too.
    expect(lint(`async function f(tx, ids, on) { const part = on ? { id: { in: ids } } : {}; return tx.user.findMany({ where: { ...part, ok: true } }) }`)).toEqual(['ids'])
    expect(lint(`async function f(tx, ids, on) { const where = on ? { id: { in: ids } } : { ok: true }; return tx.user.findMany({ where }) }`)).toEqual(['ids'])
    // Another model is not this check's business.
    expect(lint(`async function f(tx, where) { return tx.swarmMachine.findMany({ where }) }`)).toEqual([])
  })

  it('follows a filter named inside a conditional, in either branch, wherever the conditional stands', () => {
    const f = (where: string) => lint(`async function f(tx, ids, on) { const filter = { id: { in: ids } }; return tx.user.findMany(${where}) }`)
    expect(f('{ where: on ? filter : {} }')).toEqual(['ids'])
    expect(f('{ where: on ? {} : filter }')).toEqual(['ids'])
    expect(f('{ where: on ? { ok: true } : (filter) }')).toEqual(['ids'])
    expect(f('{ where: { ...(on ? filter : {}), ok: true } }')).toEqual(['ids'])
    expect(f('on ? { where: filter } : {}')).toEqual(['ids'])
    expect(f('on ? { where: {} } : { where: filter }')).toEqual(['ids'])
    // A branch it cannot see into is flagged; one that holds no list is not.
    expect(f('{ where: on ? build(ids) : {} }')).toEqual(['build(ids)'])
    expect(f('{ where: on ? { ok: true } : {} }')).toEqual([])
    expect(lint(`async function f(tx, ids, on) { if (!ids.length) return []; const filter = { id: { in: ids } }; return tx.user.findMany({ where: on ? filter : {} }) }`)).toEqual([])
    // One finding for one list, however many ways the read reaches it.
    expect(f('{ where: on ? filter : filter }')).toEqual(['ids'])
  })

  it('sees an earlier declarator of the same statement', () => {
    expect(lint(`function f(tx, ids) { const base = { id: { in: ids } }, where = base; return tx.user.findMany({ where }) }`)).toEqual(['ids'])
    expect(lint(`function f(tx, ids) { const base = { id: { in: ids } }, where = { ...base, ok: true }; return tx.user.findMany({ where }) }`)).toEqual(['ids'])
    expect(lint(`function f(tx, ids) { if (!ids.length) return []; const base = { id: { in: ids } }, where = base; return tx.user.findMany({ where }) }`)).toEqual([])
    // A later declarator of that statement is not yet declared where an earlier one is built.
    expect(lint(`function f(tx, ids) { const where = base, base = { id: { in: ids } }; return tx.user.findMany({ where }) }`)).toEqual(['base'])
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
