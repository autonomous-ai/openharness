import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import * as fs from 'node:fs'
import * as crypto from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API_PRESETS, ApiConnections, apiConnectionsRequest } from './apiConnections.js'
import { encryptDownFrame, encryptRpcResult } from './e2ee/applicationFrames.js'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync), fsyncSync: vi.fn(actual.fsyncSync) }
})
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) }
})

let directory: string, store: ApiConnections
const secret = 'fixture-private-credential-never-in-metadata'
const custom = { provider: 'custom', name: 'My images', baseUrl: 'https://images.example.test/v2', apiKey: secret }
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'harness-api-store-')); store = new ApiConnections(directory) })
afterEach(() => { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) })

describe('saved API connections', () => {
  it('lists empty storage and presets without creating a file or calling any API', () => {
    expect(store.list()).toEqual([])
    const result = apiConnectionsRequest(store, { action: 'list' })
    expect(result).toEqual({ connections: [], presets: API_PRESETS })
    expect(API_PRESETS.map(row => row.provider)).toEqual(['openrouter', 'fal', 'openai', 'anthropic', 'replicate'])
    expect(encryptDownFrame('api_connections')).toBe(true)
    expect(encryptRpcResult('api_connections_result')).toBe(true)
  })

  it.each(API_PRESETS)('saves $name with its default authentication and returns no credential', preset => {
    const connection = store.save({ provider: preset.provider, apiKey: `  ${secret}  ` })
    expect(connection).toMatchObject({ name: preset.name, baseUrl: preset.baseUrl, keyEnv: preset.keyEnv })
    expect(JSON.stringify(store.list())).not.toContain(secret)
    expect(JSON.stringify(connection)).not.toContain('apiKey')
    const environment = store.toolEnvironment(connection.id)
    expect(environment).toEqual({ [preset.keyEnv]: secret, HARNESS_API_BASE_URL: preset.baseUrl })
    const request = store.requestConfig(connection.id, '/models?limit=2')
    expect(request.url.toString()).toBe(`${preset.baseUrl}/models?limit=2`)
    expect(request.headers[preset.authHeader]).toBe(`${preset.authPrefix ? preset.authPrefix + ' ' : ''}${secret}`)
    if (preset.provider === 'anthropic') expect(request.headers['anthropic-version']).toBe('2023-06-01')
  })

  it('supports any named API, a custom header, no prefix, and explicit SDK environment variable', () => {
    const saved = store.save({ ...custom, authHeader: 'x-vendor-key', authPrefix: '', keyEnv: 'VENDOR_TOKEN' })
    expect(saved.id).toBe('my-images')
    expect(store.requestConfig(saved.id, 'render').headers).toEqual({ 'x-vendor-key': secret })
    expect(store.toolEnvironment(saved.id).VENDOR_TOKEN).toBe(secret)
    expect(new ApiConnections(directory).list()).toEqual([saved])
  })

  it('keeps the key on edit, can rotate it, preserves the id, and removes without exposing it', () => {
    const saved = store.save(custom)
    const edited = store.save({ ...saved, name: 'Work images', apiKey: '' })
    expect(edited.id).toBe(saved.id)
    expect(store.toolEnvironment(saved.id).MY_IMAGES_API_KEY).toBe(secret)
    store.save({ ...edited, apiKey: 'rotated-fixture-key' })
    expect(store.toolEnvironment(saved.id).MY_IMAGES_API_KEY).toBe('rotated-fixture-key')
    store.remove(saved.id)
    store.remove(saved.id)
    expect(store.list()).toEqual([])
    expect(() => store.toolEnvironment(saved.id)).toThrow('not saved')
    expect(() => store.save({ ...saved, apiKey: secret })).toThrow('was removed')
  })

  it('keeps multiple connections for one provider and refuses duplicate names', () => {
    store.save({ provider: 'openrouter', apiKey: secret })
    store.save({ provider: 'openrouter', name: 'OpenRouter Work', apiKey: 'second-private-key' })
    expect(store.list()).toHaveLength(2)
    expect(() => store.save({ provider: 'openrouter', name: 'OPENROUTER', apiKey: secret })).toThrow('already exists')
    expect(() => store.save({ ...custom, name: 'OpenRouter!' })).toThrow('already exists')
  })

  it('writes owner-only credentials atomically outside the project', () => {
    store.save(custom)
    const path = join(directory, 'api-connections', 'connections.json')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(directory, 'api-connections')).mode & 0o777).toBe(0o700)
    expect(JSON.parse(readFileSync(path, 'utf8')).connections[0].apiKey).toBe(secret)
    store.save({ ...store.list()[0], apiKey: 'new-key' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it.each([
    { name: '' }, { name: 'has\na newline' }, { provider: 'not-a-preset' }, { name: '🧠' },
    { baseUrl: 'not-a-url' }, { baseUrl: 'file:///tmp/private' },
    { baseUrl: 'https://user:password@example.test' }, { baseUrl: 'https://api.test?key=private' },
    { baseUrl: 'https://api.test/#private' }, { apiKey: '' }, { apiKey: 'line\nbreak' },
    { apiKey: 'a'.repeat(8193) }, { keyEnv: 'NODE_OPTIONS' }, { keyEnv: 'PATH' },
    { keyEnv: 'LD_PRELOAD' }, { keyEnv: 'DYLD_INSERT_LIBRARIES' }, { keyEnv: 'bad-name' },
    { authHeader: 'Host' }, { authHeader: 'Content-Length' }, { authHeader: 'x-key\r\nevil' },
    { authPrefix: 'Bearer\nevil' }, { authPrefix: 'a'.repeat(41) },
  ])('rejects malformed connection settings without saving anything: %j', fields => {
    const result = apiConnectionsRequest(store, { action: 'save', connection: { ...custom, ...fields } })
    expect(result.error).toBe('API_CONNECTIONS_FAILED')
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(store.list()).toEqual([])
  })

  it.each(['https://other.test/steal', '//other.test/steal', 'file:///tmp/key'])('refuses a request to another endpoint: %s', path => {
    const saved = store.save(custom)
    expect(() => store.requestConfig(saved.id, path)).toThrow('relative')
  })

  it('refuses a corrupt store instead of overwriting saved credentials', () => {
    store.save(custom)
    const path = join(directory, 'api-connections', 'connections.json')
    const original = '{broken' + secret
    writeFileSync(path, original)
    expect(apiConnectionsRequest(store, { action: 'save', connection: custom })).toEqual({
      error: 'API_CONNECTIONS_FAILED', detail: 'Saved APIs could not be read. Your keys have not been changed.',
    })
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('refuses symlinked credential storage', () => {
    const target = join(directory, 'outside'); mkdirSync(target)
    symlinkSync(target, join(directory, 'api-connections'))
    expect(() => store.save(custom)).toThrow('could not be read')
  })

  it('keeps the old credentials after failed writes and cleans up only its own temporary file', () => {
    store.save(custom)
    const previous = readFileSync(join(directory, 'api-connections', 'connections.json'), 'utf8')
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error(secret) })
    expect(() => store.save({ ...store.list()[0], apiKey: 'new-key' })).toThrow('could not be saved')
    expect(readFileSync(join(directory, 'api-connections', 'connections.json'), 'utf8')).toBe(previous)
    expect(fs.readdirSync(join(directory, 'api-connections'))).toEqual(['connections.json'])
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw new Error(secret) })
    expect(() => store.save({ ...store.list()[0], apiKey: 'new-key' })).toThrow('could not be saved')
    expect(readFileSync(join(directory, 'api-connections', 'connections.json'), 'utf8')).toBe(previous)
    const uuid = '00000000-0000-4000-8000-000000000000'
    vi.mocked(crypto.randomUUID).mockReturnValueOnce(uuid)
    const collision = join(directory, 'api-connections', `.connections-${uuid}.tmp`)
    writeFileSync(collision, 'another operation owns this file')
    expect(() => store.save({ ...store.list()[0], apiKey: 'new-key' })).toThrow('could not be saved')
    expect(readFileSync(collision, 'utf8')).toBe('another operation owns this file')
  })

  it('refuses non-files, duplicate stored ids, oversized storage and too many connections', () => {
    mkdirSync(join(directory, 'api-connections'))
    expect(store.list()).toEqual([])
    const path = join(directory, 'api-connections', 'connections.json')
    mkdirSync(path)
    expect(() => store.list()).toThrow('could not be read')
    rmSync(path, { recursive: true })
    writeFileSync(path, 'x'.repeat(2 * 1024 * 1024 + 1))
    expect(() => store.list()).toThrow('could not be read')
    rmSync(path)
    store.save(custom)
    const row = JSON.parse(readFileSync(path, 'utf8')).connections[0]
    writeFileSync(path, JSON.stringify({ version: 1, connections: [row, row] }))
    expect(() => store.list()).toThrow('could not be read')
    writeFileSync(path, JSON.stringify({ version: 1, connections: Array.from({ length: 100 }, (_, n) => ({ ...row, id: `api-${n}`, name: `API ${n}` })) }))
    expect(() => store.save(custom)).toThrow('Remove an API')
    expect(store.list()).toHaveLength(100)
  })

  it('sanitizes RPC failures, validates actions, and returns the updated list on save/remove', () => {
    expect(apiConnectionsRequest(store, { action: 'save', connection: [] }).error).toBeTruthy()
    expect(apiConnectionsRequest(store, { action: 'save' }).error).toBeTruthy()
    expect(apiConnectionsRequest(store, { action: 'unknown' }).error).toBeTruthy()
    expect(apiConnectionsRequest(store, { action: 'remove', id: '../private' }).error).toBeTruthy()
    expect(apiConnectionsRequest(store, { action: 'save', connection: custom }).connections).toHaveLength(1)
    expect(apiConnectionsRequest(store, { action: 'remove', id: 'my-images' }).connections).toEqual([])
    vi.spyOn(store, 'list').mockImplementation(() => { throw new Error(secret) })
    const failed = apiConnectionsRequest(store, { action: 'list' })
    expect(failed).toEqual({ error: 'API_CONNECTIONS_FAILED', detail: 'APIs are unavailable. Try again.' })
  })
})
