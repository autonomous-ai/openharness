import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiConnectionMetadata } from './apiConnectionMetadata.js'
import { ApiConnections } from './apiConnections.js'
import { prepareApiInstructions } from './apiInstructions.js'

const secret = 'fixture-key-the-core-never-reads'
const ROOT_USER = process.getuid?.() === 0
const MARKER = '<!-- harness:apis -->'

// Every launch parsed the store, keys included, to learn whether an API was saved (core audit, section 1). What a
// launch reads is now a list of its own, without the keys; only the models service and `harness api` open the store.
describe('what a launch reads of the saved APIs holds no key', () => {
  let dir: string, projects: string, project: string, store: string
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'api-list-')))
    projects = join(dir, 'harnesses')
    project = join(projects, 'scratch')
    mkdirSync(project, { recursive: true })
    store = join(dir, 'api-connections', 'connections.json')
  })
  afterEach(() => {
    try { chmodSync(store, 0o600) } catch { /* not there */ }
    rmSync(dir, { recursive: true, force: true })
  })
  const note = () => prepareApiInstructions(new ApiConnectionMetadata(dir), project, 'codex', projects)
  const noted = () => readdirSync(project).includes('AGENTS.md') && readFileSync(join(project, 'AGENTS.md'), 'utf8').includes(MARKER)

  it('keeps a list of the saved APIs beside the store, owner-only and without a key', () => {
    new ApiConnections(dir).save({ provider: 'openrouter', apiKey: secret })
    const list = join(dir, 'api-connections', 'list.json')
    expect(statSync(list).mode & 0o777).toBe(0o600)
    const text = readFileSync(list, 'utf8')
    expect(text).not.toContain(secret)
    expect(JSON.parse(text)).toEqual({ version: 1, connections: [{ id: 'openrouter', provider: 'openrouter', name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', authHeader: 'Authorization', authPrefix: 'Bearer' }] })
  })

  it.skipIf(ROOT_USER)('notes a launch from the list, with the store closed to it', () => {
    new ApiConnections(dir).save({ provider: 'openrouter', apiKey: secret })
    chmodSync(store, 0o000)
    note()
    expect(noted()).toBe(true)
  })

  it('refuses a list that carries a key, and reads nothing from it', () => {
    mkdirSync(join(dir, 'api-connections'), { mode: 0o700 })
    writeFileSync(join(dir, 'api-connections', 'list.json'), JSON.stringify({ version: 1, connections: [{ id: 'openrouter',
      provider: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY',
      authHeader: 'Authorization', authPrefix: 'Bearer', apiKey: secret }] }), { mode: 0o600 })
    expect(note).toThrow('Saved APIs could not be read')
    expect(noted()).toBe(false)
  })

  it('says nothing is saved when the list says so, or when there is no store at all', () => {
    note()
    expect(noted()).toBe(false)
    const apis = new ApiConnections(dir)
    apis.remove(apis.save({ provider: 'openrouter', apiKey: secret }).id)
    note()
    expect(noted()).toBe(false)
  })

  // Migration: a store an older build wrote has no list. Its being there answers, unread, until the store is first read
  // in this build, which writes the list.
  it.skipIf(ROOT_USER)('takes a store an older build wrote, unread, until the store is read and writes the list', () => {
    mkdirSync(join(dir, 'api-connections'), { mode: 0o700 })
    writeFileSync(store, JSON.stringify({ version: 1, connections: [], recognizedBases: [] }), { mode: 0o600 })
    chmodSync(store, 0o000)
    note()
    expect(noted()).toBe(true)
    chmodSync(store, 0o600)
    rmSync(join(project, 'AGENTS.md'))
    expect(new ApiConnections(dir).list()).toEqual([])
    note()
    expect(noted()).toBe(false)
  })
})
