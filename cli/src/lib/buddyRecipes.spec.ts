import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { DB_SIZE_SCRIPT, buddyReadCommand } from './buddyRecipes.js'

// Harness's read-only recipes for a Buddy (docs/specs/2026-10-30-buddy-read-access.md): Juno's database read (Lead, 10-30),
// with the read-only login its person keeps in ~/.secrets/, which the Buddy itself never sees.
const parent = realpathSync(mkdtempSync(join(tmpdir(), 'buddy-recipes-')))
afterAll(() => rmSync(parent, { recursive: true, force: true }))
const URL = 'mongodb+srv://reader:Sup3rS3cret@cluster0.example.net/harness'
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } })

// The person's home, their clone, a Swarm worktree of it and a folder outside any clone: the login is the home's alone,
// wherever the command runs (Ken's Mac, 10-30: run from a Swarm worktree, the clone's .secrets was not found).
const home = join(parent, 'home'), clone = join(parent, 'openharness'), worktree = join(parent, 'worktrees', 'buddy'), elsewhere = join(parent, 'elsewhere')
mkdirSync(home); mkdirSync(clone); mkdirSync(elsewhere)
git(clone, 'init', '-q', '-b', 'main')
writeFileSync(join(clone, 'README.md'), 'x\n'); git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'x')
git(clone, 'worktree', 'add', '-q', worktree)
const secrets = join(home, '.secrets'), envFile = join(secrets, 'mongodb-prod-readonly.env')

// A stand-in mongosh: it records its arguments and whether the login reached it by environment, and answers as told.
const bin = join(parent, 'bin'), seen = join(parent, 'seen.json')
mkdirSync(bin)
function mongosh(answer: { stdout?: string; stderr?: string; status?: number }) {
  writeFileSync(join(parent, 'stdout'), answer.stdout ?? ''); writeFileSync(join(parent, 'stderr'), answer.stderr ?? '')
  writeFileSync(join(bin, 'mongosh'), `#!/bin/sh\nnode -e 'require("fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args: process.argv.slice(1), url: process.env.HARNESS_RO_DB_URL ?? null, track: process.env.MONGOSH_FORCE_DISABLE_TELEMETRY_FOR_TESTING ?? null }))' -- "$@"\n`
    + `cat '${join(parent, 'stdout')}'\ncat '${join(parent, 'stderr')}' >&2\nexit ${answer.status ?? 0}\n`)
  chmodSync(join(bin, 'mongosh'), 0o755)
}
async function run(args: string[], cwd = worktree) {
  const out: string[] = []
  const was = process.cwd()
  process.chdir(cwd)
  try {
    const code = await buddyReadCommand(args, { home, path: `${bin}:${process.env.PATH}`, write: (text) => out.push(text) })
    return { code, out: out.join('') }
  } finally { process.chdir(was) }
}
const login = (text: string) => { mkdirSync(secrets, { recursive: true }); writeFileSync(envFile, text) }

describe('harness buddy-read db-size', () => {
  beforeEach(() => {
    for (const folder of [secrets, join(clone, '.secrets'), join(worktree, '.secrets')]) rmSync(folder, { recursive: true, force: true })
    rmSync(seen, { force: true })
  })

  it('reads its person\'s read-only login itself, hands it to mongosh by environment only, and prints its answer', async () => {
    login(`# Read-only\nexport MONGODB_PROD_RO_URL="${URL}"\nOTHER=1\n`)
    mongosh({ stdout: '{"database":"harness","collections":{"SuperTab":12},"attachmentBytes":2048}\n' })
    const { code, out } = await run(['db-size'])
    expect(code).toBe(0)
    expect(out).toBe('{"database":"harness","collections":{"SuperTab":12},"attachmentBytes":2048}\n')
    const called = JSON.parse(readFileSync(seen, 'utf8'))
    expect(called.url).toBe(URL)
    expect(called.args).toEqual(['--nodb', '--quiet', '--norc', '--eval', DB_SIZE_SCRIPT])
    expect(JSON.stringify(called.args)).not.toContain('Sup3rS3cret')
    // mongosh sends no usage data from this run (review of #2310).
    expect(called.track).toBe('1')
  })

  // Ken's Mac, 10-30: run from a Swarm worktree, the recipe looked in that project's clone and found no login.
  it.each([['a Swarm worktree', worktree], ['the clone', clone], ['a folder outside any clone', elsewhere]])('finds the same login run from %s', async (_, cwd) => {
    login(`MONGODB_PROD_RO_URL=${URL}\n`)
    mongosh({ stdout: '{}\n' })
    expect((await run(['db-size'], cwd)).code).toBe(0)
    expect(JSON.parse(readFileSync(seen, 'utf8')).url).toBe(URL)
  })

  // One place only: a login in the folder it runs from, which a pull request could add, is never used.
  it.each([['the clone', clone], ['the worktree', worktree]])('never reads a login kept in %s', async (_, folder) => {
    mkdirSync(join(folder, '.secrets'))
    writeFileSync(join(folder, '.secrets', 'mongodb-prod-readonly.env'), `MONGODB_PROD_RO_URL=${URL}\n`)
    mongosh({ stdout: '{}' })
    const { code } = await run(['db-size'], folder)
    expect(code).toBe(1)
    expect(() => readFileSync(seen)).toThrow()
  })

  it.each([['KEY=value', `MONGODB_PROD_RO_URL=${URL}`], ['single quotes', `MONGODB_PROD_RO_URL='${URL}'`]])('reads the login written as %s', async (_, line) => {
    login(`${line}\n`)
    mongosh({ stdout: '{}\n' })
    expect((await run(['db-size'])).code).toBe(0)
    expect(JSON.parse(readFileSync(seen, 'utf8')).url).toBe(URL)
  })

  it.each([['no file', null], ['a file without the login', 'OTHER=1\n'], ['an empty login', 'MONGODB_PROD_RO_URL=\n']])('says where the login goes, never a value, with %s', async (_, text) => {
    if (text !== null) login(text)
    mongosh({ stdout: '{}' })
    const { code, out } = await run(['db-size'])
    expect(code).toBe(1)
    expect(out).toBe(`No read-only database login on this machine. Put MONGODB_PROD_RO_URL=<the read-only connection string> in ${envFile}, `
      + 'in the home of the person this machine belongs to, readable by them alone (chmod 600). It is read from there wherever this runs.\n')
    expect(() => readFileSync(seen)).toThrow()
  })

  it('keeps every connection string out of what it prints, mongosh\'s errors included', async () => {
    login(`MONGODB_PROD_RO_URL=${URL}\n`)
    mongosh({ stderr: `MongoServerSelectionError: could not reach ${URL} (password Sup3rS3cret)\n`, status: 1 })
    const { code, out } = await run(['db-size'])
    expect(code).toBe(1)
    expect(out).not.toContain('Sup3rS3cret')
    expect(out).not.toContain('reader:')
    expect(out).toContain('MongoServerSelectionError')
  })

  it('says the login is not read-only when mongosh refuses it', async () => {
    login(`MONGODB_PROD_RO_URL=${URL}\n`)
    mongosh({ stdout: '{"refused":"not read-only","roles":["readWrite"]}\n', status: 3 })
    const { code, out } = await run(['db-size'])
    expect(code).toBe(3)
    expect(out).toContain('not read-only')
  })

  it.each([[[]], [['db-size', '--uri', URL]], [['anything-else']]])('runs nothing for %j', async (args) => {
    login(`MONGODB_PROD_RO_URL=${URL}\n`)
    mongosh({ stdout: '{}' })
    expect((await run(args)).code).toBe(2)
    expect(() => readFileSync(seen)).toThrow()
  })
})

// The script mongosh runs, run here with a stand-in for mongosh's globals: Juno's reads and nothing wider.
describe('the db-size script', () => {
  const READ = ['find', 'listCollections', 'listIndexes', 'collStats', 'dbStats', 'killCursors']
  type Privilege = { resource: Record<string, unknown>; actions: string[] }
  function database(roles: string[], collections: Record<string, number>, attachmentBytes: number | null, actions: string[] | Privilege[] = READ) {
    const calls: unknown[] = []
    const privileges = typeof actions[0] === 'object' ? actions as Privilege[] : [{ resource: { db: '', collection: '' }, actions: actions as string[] }]
    const db = {
      getName: () => 'harness',
      runCommand: (command: unknown) => { calls.push(command); return { authInfo: { authenticatedUserRoles: roles.map(role => ({ role, db: 'admin' })),
        authenticatedUserPrivileges: privileges } } },
      getCollectionNames: () => Object.keys(collections),
      getCollection: (name: string) => ({ estimatedDocumentCount: () => collections[name] }),
      SuperTabAttachment: { aggregate: (pipeline: unknown) => { calls.push(pipeline); return { toArray: () => attachmentBytes === null ? [] : [{ _id: null, bytes: attachmentBytes }] } } },
    }
    const printed: string[] = []
    let quit: number | null = null
    runInNewContext(`try { ${DB_SIZE_SCRIPT} } catch (stop) { if (stop !== 'quit') throw stop }`, {
      process: { env: { HARNESS_RO_DB_URL: URL } }, connect: (url: string) => { calls.push(url); return db },
      print: (text: string) => printed.push(text), quit: (code: number) => { quit = code; throw 'quit' }, JSON,
    })
    return { calls, printed, quit }
  }

  it('prints the row count of each collection and the attachments\' bytes', () => {
    const { calls, printed, quit } = database(['readAnyDatabase'], { SuperTab: 12, SuperTabAttachment: 3 }, 2048)
    expect(quit).toBeNull()
    expect(JSON.parse(printed.join(''))).toEqual({ database: 'harness', collections: { SuperTab: 12, SuperTabAttachment: 3 }, attachmentBytes: 2048 })
    expect(calls).toEqual([URL, { connectionStatus: 1, showPrivileges: true }, [{ $group: { _id: null, bytes: { $sum: '$size' } } }]])
  })

  it('counts no attachments as 0 bytes', () => {
    expect(JSON.parse(database(['read'], {}, null).printed.join('')).attachmentBytes).toBe(0)
  })

  it.each([[['readWrite']], [['read', 'dbAdmin']], [['atlasAdmin']], [['clusterMonitor']], [[]]])('refuses a login with roles %j before reading anything', roles => {
    const { calls, printed, quit } = database(roles, { SuperTab: 12 }, 1)
    expect(quit).toBe(3)
    expect(calls).toEqual([URL, { connectionStatus: 1, showPrivileges: true }])
    expect(printed.join('')).toContain('not read-only')
  })

  // A role is a name; what it may do is its privileges (review of #2310): a custom role named "read" that may insert.
  it.each([[['insert']], [['find', 'update']], [['find', 'dropCollection']], [[]]])('refuses a read role whose privileges include %j', actions => {
    const { calls, quit } = database(['read'], { SuperTab: 12 }, 1, actions)
    expect(quit).toBe(3)
    expect(calls).toEqual([URL, { connectionStatus: 1, showPrivileges: true }])
  })

  // MongoDB 8.0's own definitions of its read and readAnyDatabase roles (src/mongo/db/auth/builtin_roles.yml on branch v8.0,
  // last changed in 99e206a3, read 10-30): read's actions, on every ordinary collection, system.js and time-series buckets,
  // and listDatabases on the cluster. planCacheRead is among them: Ken's read-only login was refused for it on production
  // (MongoDB 8.0, 10-30). 7.0 grants the same; 8.2 adds performRawDataOperations, which is not allowed here.
  const MONGO_8_0_READ = ['changeStream', 'collStats', 'dbHash', 'dbStats', 'find', 'killCursors', 'listCollections', 'listIndexes',
    'listSearchIndexes', 'planCacheRead']
  const MONGO_8_0_READ_ANY_DATABASE: Privilege[] = [
    { resource: { db: '', collection: '' }, actions: MONGO_8_0_READ },
    { resource: { cluster: true }, actions: ['listDatabases'] },
    { resource: { db: '', collection: 'system.js' }, actions: MONGO_8_0_READ },
    { resource: { db: '', system_buckets: '' }, actions: MONGO_8_0_READ },
  ]

  it.each([['readAnyDatabase', MONGO_8_0_READ_ANY_DATABASE],
    ['read', [{ resource: { db: 'harness', collection: '' }, actions: MONGO_8_0_READ }, { resource: { db: 'harness', collection: 'system.js' }, actions: MONGO_8_0_READ }]],
  ] as [string, Privilege[]][])('reads with MongoDB 8.0\'s built-in %s role, every action it grants', (role, privileges) => {
    const { printed, quit } = database([role], { SuperTab: 12 }, 1, privileges)
    expect(quit).toBeNull()
    expect(JSON.parse(printed.join('')).collections).toEqual({ SuperTab: 12 })
  })

  // What MongoDB 8.0's readWrite role adds to read (the same file), and the planner, operation and setting changes beside
  // planCacheRead (security reviews of #2338): each one alone, beside every read action, is refused.
  it.each(['cleanupStructuredEncryptionData', 'compactStructuredEncryptionData', 'convertToCapped', 'createCollection', 'createIndex',
    'createSearchIndexes', 'dropCollection', 'dropIndex', 'dropSearchIndex', 'insert', 'remove', 'renameCollectionSameDB', 'update',
    'updateSearchIndex', 'performRawDataOperations', 'planCacheWrite', 'killop', 'setParameter'])('refuses readAnyDatabase with %s added', action => {
    const privileges = [...MONGO_8_0_READ_ANY_DATABASE, { resource: { db: 'harness', collection: '' }, actions: [action] }]
    const { calls, quit } = database(['readAnyDatabase'], { SuperTab: 12 }, 1, privileges)
    expect(quit).toBe(3)
    expect(calls).toEqual([URL, { connectionStatus: 1, showPrivileges: true }])
  })
})
