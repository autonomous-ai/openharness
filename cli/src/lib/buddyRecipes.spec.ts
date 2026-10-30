import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { DB_SIZE_SCRIPT, buddyReadCommand } from './buddyRecipes.js'

// Harness's read-only recipes for a Buddy (docs/specs/2026-10-30-buddy-read-access.md): Juno's database read (Lead, 10-30),
// with the read-only login Ken's clone keeps in .secrets/, which the Buddy itself never sees.
const parent = realpathSync(mkdtempSync(join(tmpdir(), 'buddy-recipes-')))
afterAll(() => rmSync(parent, { recursive: true, force: true }))
const URL = 'mongodb+srv://reader:Sup3rS3cret@cluster0.example.net/harness'
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } })

// Ken's clone, and a Buddy's worktree of it: the .secrets folder is the clone's alone, never in a worktree.
const clone = join(parent, 'openharness'), worktree = join(parent, 'worktrees', 'buddy')
mkdirSync(clone)
git(clone, 'init', '-q', '-b', 'main')
writeFileSync(join(clone, 'README.md'), 'x\n'); git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'x')
git(clone, 'worktree', 'add', '-q', worktree)
const envFile = join(clone, '.secrets', 'mongodb-prod-readonly.env')

// A stand-in mongosh: it records its arguments and whether the login reached it by environment, and answers as told.
const bin = join(parent, 'bin'), seen = join(parent, 'seen.json')
mkdirSync(bin)
function mongosh(answer: { stdout?: string; stderr?: string; status?: number }) {
  writeFileSync(join(parent, 'stdout'), answer.stdout ?? ''); writeFileSync(join(parent, 'stderr'), answer.stderr ?? '')
  writeFileSync(join(bin, 'mongosh'), `#!/bin/sh\nnode -e 'require("fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args: process.argv.slice(1), url: process.env.HARNESS_RO_DB_URL ?? null }))' -- "$@"\n`
    + `cat '${join(parent, 'stdout')}'\ncat '${join(parent, 'stderr')}' >&2\nexit ${answer.status ?? 0}\n`)
  chmodSync(join(bin, 'mongosh'), 0o755)
}
async function run(args: string[], cwd = worktree) {
  const out: string[] = []
  const code = await buddyReadCommand(args, { cwd, path: `${bin}:${process.env.PATH}`, write: (text) => out.push(text) })
  return { code, out: out.join('') }
}

describe('harness buddy-read db-size', () => {
  beforeEach(() => { rmSync(join(clone, '.secrets'), { recursive: true, force: true }); rmSync(seen, { force: true }) })

  it('reads the clone\'s read-only login itself, hands it to mongosh by environment only, and prints its answer', async () => {
    mkdirSync(join(clone, '.secrets'))
    writeFileSync(envFile, `# Read-only\nexport MONGODB_PROD_RO_URL="${URL}"\nOTHER=1\n`)
    mongosh({ stdout: '{"database":"harness","collections":{"SuperTab":12},"attachmentBytes":2048}\n' })
    const { code, out } = await run(['db-size'])
    expect(code).toBe(0)
    expect(out).toBe('{"database":"harness","collections":{"SuperTab":12},"attachmentBytes":2048}\n')
    const called = JSON.parse(readFileSync(seen, 'utf8'))
    expect(called.url).toBe(URL)
    expect(called.args).toEqual(['--nodb', '--quiet', '--norc', '--eval', DB_SIZE_SCRIPT])
    expect(JSON.stringify(called.args)).not.toContain('Sup3rS3cret')
  })

  it.each([['KEY=value', `MONGODB_PROD_RO_URL=${URL}`], ['single quotes', `MONGODB_PROD_RO_URL='${URL}'`]])('reads the login written as %s', async (_, line) => {
    mkdirSync(join(clone, '.secrets')); writeFileSync(envFile, `${line}\n`)
    mongosh({ stdout: '{}\n' })
    expect((await run(['db-size'])).code).toBe(0)
    expect(JSON.parse(readFileSync(seen, 'utf8')).url).toBe(URL)
  })

  it('names the file it needs, never a value, when the clone has no read-only login', async () => {
    mongosh({ stdout: '{}' })
    const { code, out } = await run(['db-size'])
    expect(code).toBe(1)
    expect(out).toContain(join('.secrets', 'mongodb-prod-readonly.env'))
    expect(out).toContain('MONGODB_PROD_RO_URL')
    expect(() => readFileSync(seen)).toThrow()
  })

  it('keeps every connection string out of what it prints, mongosh\'s errors included', async () => {
    mkdirSync(join(clone, '.secrets')); writeFileSync(envFile, `MONGODB_PROD_RO_URL=${URL}\n`)
    mongosh({ stderr: `MongoServerSelectionError: could not reach ${URL} (password Sup3rS3cret)\n`, status: 1 })
    const { code, out } = await run(['db-size'])
    expect(code).toBe(1)
    expect(out).not.toContain('Sup3rS3cret')
    expect(out).not.toContain('reader:')
    expect(out).toContain('MongoServerSelectionError')
  })

  it('says the login is not read-only when mongosh refuses it', async () => {
    mkdirSync(join(clone, '.secrets')); writeFileSync(envFile, `MONGODB_PROD_RO_URL=${URL}\n`)
    mongosh({ stdout: '{"refused":"not read-only","roles":["readWrite"]}\n', status: 3 })
    const { code, out } = await run(['db-size'])
    expect(code).toBe(3)
    expect(out).toContain('not read-only')
  })

  it.each([[[]], [['db-size', '--uri', URL]], [['anything-else']]])('runs nothing for %j', async (args) => {
    mongosh({ stdout: '{}' })
    expect((await run(args)).code).toBe(2)
    expect(() => readFileSync(seen)).toThrow()
  })
})

// The script mongosh runs, run here with a stand-in for mongosh's globals: Juno's reads and nothing wider.
describe('the db-size script', () => {
  function database(roles: string[], collections: Record<string, number>, attachmentBytes: number | null) {
    const calls: unknown[] = []
    const db = {
      getName: () => 'harness',
      runCommand: (command: unknown) => { calls.push(command); return { authInfo: { authenticatedUserRoles: roles.map(role => ({ role, db: 'admin' })) } } },
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
    expect(calls).toEqual([URL, { connectionStatus: 1 }, [{ $group: { _id: null, bytes: { $sum: '$size' } } }]])
  })

  it('counts no attachments as 0 bytes', () => {
    expect(JSON.parse(database(['read'], {}, null).printed.join('')).attachmentBytes).toBe(0)
  })

  it.each([[['readWrite']], [['read', 'dbAdmin']], [['atlasAdmin']], [[]]])('refuses a login with roles %j before reading anything', roles => {
    const { calls, printed, quit } = database(roles, { SuperTab: 12 }, 1)
    expect(quit).toBe(3)
    expect(calls).toEqual([URL, { connectionStatus: 1 }])
    expect(printed.join('')).toContain('not read-only')
  })
})
