import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dropSwarmCollections, SWARM_COLLECTIONS } from './dropCollections.js'

/** A database that answers the commands the drop sends, with the errors Mongo gives for a missing collection and a user who may not drop. */
class Database {
  readonly collections = new Map<string, string[]>()
  readonly commands: Array<Record<string, unknown>> = []
  denyDrop = false
  failFind = new Set<string>()
  /** Deletes that answer ok and remove nothing, as when something writes the rows back. */
  stuck = new Set<string>()
  /** Runs before each delete, as another pod's write would. */
  beforeDelete: (collection: string) => void = () => {}
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
      this.beforeDelete(name)
      if (this.stuck.has(name)) return { n: 0, ok: 1 }
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
const asDb = (database: Database) => database as unknown as Parameters<typeof dropSwarmCollections>[0]

describe('dropping the collections only the Swarm used', () => {
  it('drops each, counts the rows it found, and touches no other collection', async () => {
    const database = new Database()
    for (const [i, name] of SWARM_COLLECTIONS.entries()) database.fill(name, i + 1)
    database.fill('harness_shares', 7).fill('machines', 3).fill('push_devices', 5)

    const report = await dropSwarmCollections(asDb(database))

    expect(report.done).toBe(true)
    expect(report.failed).toEqual([])
    expect(report.collections.map(c => [c.collection, c.rows, c.dropped]).sort()).toEqual(SWARM_COLLECTIONS.map((name, i) => [name, i + 1, true]).sort())
    expect([...database.collections.keys()].sort()).toEqual(['harness_shares', 'machines', 'push_devices'])
    expect([7, 3, 5]).toEqual(['harness_shares', 'machines', 'push_devices'].map(name => database.collections.get(name)!.length))
    // Dropped at once: no row was removed one by one.
    expect(database.commands.filter(c => 'delete' in c)).toEqual([])
    // No command, not even a read, named a collection outside the list.
    expect([...database.named()].filter(name => !(SWARM_COLLECTIONS as readonly string[]).includes(name))).toEqual([])
  })

  it('reports counts and names only: no row, id or content', async () => {
    const database = new Database().fill('SuperTabMessage', 2)
    const report = await dropSwarmCollections(asDb(database))
    expect(JSON.stringify(report)).not.toContain('SuperTabMessage:')
    expect(Object.keys(report.collections[0]!).sort()).toEqual(['collection', 'dropped', 'rows'])
  })

  it('empties a collection where the database user may not drop it, in chunks of at most 500, with a pause between them', async () => {
    const database = new Database().fill('SuperTabMessage', 1050)
    database.denyDrop = true
    let pauses = 0

    const report = await dropSwarmCollections(asDb(database), { pause: async () => { pauses++ } })

    expect(report).toEqual({ collections: [{ collection: 'SuperTabMessage', rows: 1050, dropped: false }], failed: [], done: true })
    expect(database.collections.get('SuperTabMessage')).toEqual([])
    const deletes = database.commands.filter(c => 'delete' in c) as Array<{ deletes: Array<{ q: { _id: { $in: string[] } } }> }>
    expect(deletes.map(d => d.deletes[0]!.q._id.$in.length)).toEqual([500, 500, 50])
    expect(pauses).toBe(2)
  })

  it('goes on until the collection is empty when another pod removes some of the same rows meanwhile', async () => {
    const database = new Database().fill('SwarmGroup', 1200)
    database.denyDrop = true
    let raced = false
    database.beforeDelete = name => { if (!raced) { raced = true; database.collections.set(name, database.collections.get(name)!.slice(200)) } }

    const report = await dropSwarmCollections(asDb(database))

    expect(database.collections.get('SwarmGroup')).toEqual([])
    expect(report).toEqual({ collections: [{ collection: 'SwarmGroup', rows: 1200, dropped: false }], failed: [], done: true })
  })

  it('names a collection whose rows stay after every chunk it may take, does the others, and is not done', async () => {
    const database = new Database().fill('SwarmGroup', 1200).fill('SuperTabRun', 2)
    database.denyDrop = true
    database.stuck.add('SwarmGroup')

    const report = await dropSwarmCollections(asDb(database))

    expect(report.failed).toEqual(['SwarmGroup'])
    expect(report.done).toBe(false)
    expect(report.collections.map(c => c.collection)).toEqual(['SuperTabRun'])
    // 1,200 rows are three chunks and five more are allowed, then it gives up: nine tries at most, not for ever.
    expect(database.commands.filter(c => 'delete' in c && c.delete === 'SwarmGroup')).toHaveLength(9)
    expect(database.collections.get('SwarmGroup')).toHaveLength(1200)
  })

  it('names a collection it cannot empty and leaves what it holds', async () => {
    const database = new Database().fill('SwarmHead', 2)
    database.denyDrop = true
    database.failFind.add('SwarmHead')
    expect(await dropSwarmCollections(asDb(database))).toEqual({ collections: [], failed: ['SwarmHead'], done: false })
    expect(database.collections.get('SwarmHead')).toHaveLength(2)
  })

  it('leaves a collection that is not there alone, and a second pass only lists', async () => {
    const database = new Database().fill('SuperTab', 3).fill('machines', 4)
    expect((await dropSwarmCollections(asDb(database))).collections).toHaveLength(1)
    const commands = database.commands.length

    const second = await dropSwarmCollections(asDb(database))

    expect(second).toEqual({ collections: [], failed: [], done: true })
    expect(database.commands.slice(commands).map(c => Object.keys(c)[0])).toEqual(['listCollections'])
    expect(database.collections.get('machines')).toHaveLength(4)
  })

  it('finishes when two passes run at once, whichever drops a collection first', async () => {
    const database = new Database()
    for (const name of SWARM_COLLECTIONS) database.fill(name, 3)

    const [a, b] = await Promise.all([dropSwarmCollections(asDb(database)), dropSwarmCollections(asDb(database))])

    expect([a.failed, b.failed, a.done, b.done]).toEqual([[], [], true, true])
    expect(database.collections.size).toBe(0)
  })

  it('stops at once when aborted, leaving the rest, and is not done', async () => {
    const database = new Database().fill('SuperTabDelivery', 1200)
    database.denyDrop = true
    const control = new AbortController()

    const report = await dropSwarmCollections(asDb(database), { signal: control.signal, pause: async () => { control.abort() } })

    expect(report.done).toBe(false)
    expect(database.collections.get('SuperTabDelivery')).toHaveLength(700)
  })

  it('lists no model of the schema, whose push would make it again, and every Swarm model the schema had', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
    const models = new Set([...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map(match => match[1]))
    expect(SWARM_COLLECTIONS.filter(name => models.has(name))).toEqual([])
    expect([...models].filter(name => /^(SuperTab|Swarm|GitHub)/.test(name!))).toEqual([])
    expect(new Set(SWARM_COLLECTIONS).size).toBe(SWARM_COLLECTIONS.length)
  })
})
