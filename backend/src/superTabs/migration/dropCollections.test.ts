import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHUNK, dropRemovedCollections, REMOVED_COLLECTIONS } from './dropCollections.js'

/** A database that answers the commands the drop sends, with the errors Mongo gives for a missing collection and a user who may not drop. */
class Database {
  readonly collections = new Map<string, string[]>()
  readonly commands: Array<Record<string, unknown>> = []
  denyDrop = false
  failFind = new Set<string>()
  failDelete = new Set<string>()
  /** Each command yields first, so two passes on one database interleave as two pods do. */
  async $runCommandRaw(command: Record<string, unknown>): Promise<unknown> {
    await new Promise(resolve => setImmediate(resolve))
    this.commands.push(command)
    if ('listCollections' in command) {
      const named = ((command.filter as { name: { $in: string[] } }).name.$in)
      return { cursor: { firstBatch: [...this.collections.keys()].filter(name => named.includes(name)).map(name => ({ name })) } }
    }
    if ('count' in command) return { n: this.collections.get(command.count as string)?.length ?? 0 }
    if ('find' in command) {
      const name = command.find as string
      if (this.failFind.has(name)) throw new Error('the database is busy')
      return { cursor: { firstBatch: (this.collections.get(name) ?? []).slice(0, command.limit as number).map(_id => ({ _id })) } }
    }
    if ('delete' in command) {
      const name = command.delete as string
      if (this.failDelete.has(name)) return { n: 0, writeErrors: [{ index: 0 }] }
      const gone = new Set(((command.deletes as Array<{ q: { _id: { $in: string[] } } }>)[0]!.q._id.$in))
      const rows = this.collections.get(name) ?? []
      const kept = rows.filter(id => !gone.has(id))
      if (this.collections.has(name)) this.collections.set(name, kept)
      return { n: rows.length - kept.length, ok: 1 }
    }
    if ('drop' in command) {
      const name = command.drop as string
      if (this.denyDrop) throw new Error(`not authorized on db to execute command { drop: "${name}" } Code: \`13\``)
      if (!this.collections.delete(name)) throw new Error('Command failed: Error code 26 (NamespaceNotFound): ns not found Code: `26`')
      return { ok: 1 }
    }
    throw new Error(`unexpected command ${Object.keys(command)[0]}`)
  }
  fill(name: string, rows: number): this {
    this.collections.set(name, Array.from({ length: rows }, (_, i) => `${name}:${i}`))
    return this
  }
  /** The collections the commands named, by the field that names one. */
  named(): Set<string> {
    return new Set(this.commands.flatMap(command => ['count', 'find', 'delete', 'drop'].filter(key => key in command).map(key => command[key] as string)))
  }
}
const asDb = (database: Database) => database as unknown as Parameters<typeof dropRemovedCollections>[0]

describe('dropping the collections Swarm v4 removed', () => {
  it('empties and drops each, counts the rows it found, and touches no other collection', async () => {
    const database = new Database()
    for (const [i, name] of REMOVED_COLLECTIONS.entries()) database.fill(name, i + 1)
    database.fill('SwarmHead', 7).fill('SuperTab', 3).fill('SwarmGroup', 5)

    const report = await dropRemovedCollections(asDb(database))

    expect(report.done).toBe(true)
    expect(report.failed).toEqual([])
    expect(report.collections.map(c => [c.collection, c.rows, c.dropped]).sort()).toEqual(REMOVED_COLLECTIONS.map((name, i) => [name, i + 1, true]).sort())
    expect([...database.collections.keys()].sort()).toEqual(['SuperTab', 'SwarmGroup', 'SwarmHead'])
    expect([database.collections.get('SwarmHead')!.length, database.collections.get('SuperTab')!.length, database.collections.get('SwarmGroup')!.length]).toEqual([7, 3, 5])
    // No command, not even a read, named a collection outside the list.
    expect([...database.named()].filter(name => !(REMOVED_COLLECTIONS as readonly string[]).includes(name))).toEqual([])
  })

  it('reports counts and names only: no row, id or content', async () => {
    const database = new Database().fill('SwarmWorkspace', 2)
    const report = await dropRemovedCollections(asDb(database))
    expect(JSON.stringify(report)).not.toContain('SwarmWorkspace:')
    expect(Object.keys(report.collections[0]!).sort()).toEqual(['collection', 'dropped', 'rows'])
  })

  it('removes in chunks of at most the chunk size, with a pause between them', async () => {
    const database = new Database().fill('SwarmWorkspaceMember', 1050)
    let pauses = 0

    const report = await dropRemovedCollections(asDb(database), { chunk: 500, pause: async () => { pauses++ } })

    expect(report.collections).toEqual([{ collection: 'SwarmWorkspaceMember', rows: 1050, dropped: true }])
    const deletes = database.commands.filter(c => 'delete' in c) as Array<{ deletes: Array<{ q: { _id: { $in: string[] } } }> }>
    expect(deletes.map(d => d.deletes[0]!.q._id.$in.length)).toEqual([500, 500, 50])
    expect(pauses).toBe(2)
    expect(CHUNK).toBe(500)
  })

  it('leaves a collection that is not there alone, and a second pass finds nothing to do', async () => {
    const database = new Database().fill('SuperTabScorecard', 3).fill('SwarmHead', 4)
    expect((await dropRemovedCollections(asDb(database))).collections).toHaveLength(1)
    const commands = database.commands.length

    const second = await dropRemovedCollections(asDb(database))

    expect(second).toEqual({ collections: [], failed: [], done: true })
    // Only the one listing, which names the collections it asks about and reads nothing.
    expect(database.commands.slice(commands).map(c => Object.keys(c)[0])).toEqual(['listCollections'])
    expect(database.collections.get('SwarmHead')).toHaveLength(4)
  })

  it('finishes when two passes run at once, whichever drops a collection first', async () => {
    const database = new Database()
    for (const name of REMOVED_COLLECTIONS) database.fill(name, 1200)

    const [a, b] = await Promise.all([dropRemovedCollections(asDb(database), { chunk: 100 }), dropRemovedCollections(asDb(database), { chunk: 100 })])

    expect([a.failed, b.failed, a.done, b.done]).toEqual([[], [], true, true])
    expect(database.collections.size).toBe(0)
  })

  it('leaves a collection empty, and says so, where the database user may not drop it', async () => {
    const database = new Database().fill('SwarmWorkspace', 3)
    database.denyDrop = true

    const report = await dropRemovedCollections(asDb(database))

    expect(report).toEqual({ collections: [{ collection: 'SwarmWorkspace', rows: 3, dropped: false }], failed: [], done: true })
    expect(database.collections.get('SwarmWorkspace')).toEqual([])
  })

  it('names a collection it cannot empty, does the others, and is not done', async () => {
    const database = new Database().fill('SwarmWorkspace', 2).fill('SuperTabScorecard', 2).fill('SuperTabNativeContext', 2)
    database.failFind.add('SuperTabScorecard')

    const report = await dropRemovedCollections(asDb(database))

    expect(report.failed).toEqual(['SuperTabScorecard'])
    expect(report.done).toBe(false)
    expect(report.collections.map(c => c.collection).sort()).toEqual(['SuperTabNativeContext', 'SwarmWorkspace'])
    expect(database.collections.get('SuperTabScorecard')).toHaveLength(2)
  })

  it('names a collection whose removals the database refuses, and leaves what it holds', async () => {
    const database = new Database().fill('SwarmWorkspaceRemoval', 2)
    database.failDelete.add('SwarmWorkspaceRemoval')
    expect(await dropRemovedCollections(asDb(database))).toEqual({ collections: [], failed: ['SwarmWorkspaceRemoval'], done: false })
    expect(database.collections.get('SwarmWorkspaceRemoval')).toHaveLength(2)
  })

  it('stops at once when aborted, leaving the rest, and is not done', async () => {
    const database = new Database().fill('SwarmWorkspaceMember', 1000)
    const control = new AbortController()

    const report = await dropRemovedCollections(asDb(database), { chunk: 100, signal: control.signal, pause: async () => { control.abort() } })

    expect(report.done).toBe(false)
    expect(database.collections.get('SwarmWorkspaceMember')).toHaveLength(900)
  })

  it('a collection listed here is no model of the schema: its push would make it again', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
    const models = new Set([...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map(match => match[1]))
    expect(REMOVED_COLLECTIONS.filter(name => models.has(name))).toEqual([])
  })
})
