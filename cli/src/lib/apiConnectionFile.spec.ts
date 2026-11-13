import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readApiConnectionFile, savedBearerApi } from './apiConnectionFile.js'
import { ApiConnectionError, readApiConnectionStore } from './apiConnectionMetadata.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'api-file-'))
  roots.push(root)
  return root
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'openrouter', provider: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1',
  keyEnv: 'OPENROUTER_API_KEY', authHeader: 'Authorization', authPrefix: 'Bearer', apiKey: 'sk-x', ...over,
})

function save(dir: string, store: unknown): void {
  mkdirSync(join(dir, 'api-connections'), { recursive: true })
  writeFileSync(join(dir, 'api-connections', 'connections.json'), typeof store === 'string' ? store : JSON.stringify(store))
}

describe('the saved APIs\' file', () => {
  it('is nothing where no API was saved: no folder, or a folder with no file', () => {
    const dir = dataDir()
    expect(readApiConnectionFile(dir)).toBeUndefined()
    expect(readApiConnectionStore(dir)).toEqual({ version: 1, connections: [] })
    mkdirSync(join(dir, 'api-connections'))
    expect(readApiConnectionFile(dir)).toBeUndefined()
    expect(readApiConnectionStore(dir)).toEqual({ version: 1, connections: [] })
    expect(savedBearerApi(dir)).toBe(false)
  })

  it('is read whole, and the checked read gives the same rows', () => {
    const dir = dataDir()
    const store = { version: 1, connections: [row()] }
    save(dir, store)
    expect(readApiConnectionFile(dir)).toEqual(store)
    expect(readApiConnectionStore(dir)).toEqual(store)
  })

  it.skipIf(process.platform === 'win32')('refuses a link in place of the folder or the file', () => {
    const real = dataDir()
    save(real, { version: 1, connections: [row()] })
    const linkedFolder = dataDir()
    symlinkSync(join(real, 'api-connections'), join(linkedFolder, 'api-connections'))
    expect(() => readApiConnectionFile(linkedFolder)).toThrow()
    expect(() => readApiConnectionStore(linkedFolder)).toThrow(ApiConnectionError)
    expect(savedBearerApi(linkedFolder)).toBe(false)
    const linkedFile = dataDir()
    mkdirSync(join(linkedFile, 'api-connections'))
    symlinkSync(join(real, 'api-connections', 'connections.json'), join(linkedFile, 'api-connections', 'connections.json'))
    expect(() => readApiConnectionFile(linkedFile)).toThrow()
    expect(() => readApiConnectionStore(linkedFile)).toThrow(ApiConnectionError)
    expect(savedBearerApi(linkedFile)).toBe(false)
  })

  it('refuses a folder in place of the file, a file past 2 MiB, and what is not JSON', () => {
    const folder = dataDir()
    mkdirSync(join(folder, 'api-connections', 'connections.json'), { recursive: true })
    expect(() => readApiConnectionFile(folder)).toThrow()
    const large = dataDir()
    save(large, JSON.stringify({ version: 1, connections: [row()], pad: 'x'.repeat(2 * 1024 * 1024) }))
    expect(() => readApiConnectionFile(large)).toThrow()
    expect(savedBearerApi(large)).toBe(false)
    const torn = dataDir()
    save(torn, '{"version":1,"connections":[')
    expect(() => readApiConnectionFile(torn)).toThrow()
    expect(() => readApiConnectionStore(torn)).toThrow(ApiConnectionError)
    expect(savedBearerApi(torn)).toBe(false)
  })
})

describe('whether a saved API serves Claude Code', () => {
  it('says yes for a key sent as Authorization: Bearer, in any letter case', () => {
    const dir = dataDir()
    save(dir, { version: 1, connections: [row({ id: 'a', authHeader: 'x-api-key', authPrefix: '' }), row({ authHeader: 'authorization', authPrefix: 'bearer' })] })
    expect(savedBearerApi(dir)).toBe(true)
  })

  it('says no where every key goes out another way', () => {
    const dir = dataDir()
    save(dir, { version: 1, connections: [row({ authHeader: 'x-api-key', authPrefix: '' }), row({ id: 'b', authHeader: 'Authorization', authPrefix: 'Token' })] })
    expect(savedBearerApi(dir)).toBe(false)
  })

  it('says no for a file of another version, or one whose rows are not rows', () => {
    const other = dataDir()
    save(other, { version: 2, connections: [row()] })
    expect(savedBearerApi(other)).toBe(false)
    const noList = dataDir()
    save(noList, { version: 1, connections: { 0: row() } })
    expect(savedBearerApi(noList)).toBe(false)
    const odd = dataDir()
    save(odd, { version: 1, connections: [null, 'Authorization Bearer', { authHeader: 'Authorization' }, { authHeader: 1, authPrefix: 'Bearer' }] })
    expect(savedBearerApi(odd)).toBe(false)
  })

  it('tells a file that holds null from no file: the checked read refuses it, as it did', () => {
    const dir = dataDir()
    save(dir, 'null')
    expect(readApiConnectionFile(dir)).toBeNull()
    expect(() => readApiConnectionStore(dir)).toThrow(ApiConnectionError)
    expect(savedBearerApi(dir)).toBe(false)
  })

  it('reads the two fields alone: a row the checked read refuses for another field still counts', () => {
    // The launch reads the whole store checked, and is what says "Saved APIs could not be read" then.
    const dir = dataDir()
    save(dir, { version: 1, connections: [row({ keyEnv: 'NODE_OPTIONS' })] })
    expect(() => readApiConnectionStore(dir)).toThrow(ApiConnectionError)
    expect(savedBearerApi(dir)).toBe(true)
  })
})
