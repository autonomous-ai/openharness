import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiConnections } from './apiConnections.js'
import { apiCommand } from './apiCommand.js'
import { prepareApiInstructions } from './apiInstructions.js'

let directory: string, store: ApiConnections, server: Server | undefined
const secret = 'fixture-key-for-local-http-only'
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'harness-api-command-'))
  store = new ApiConnections(directory)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined }
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

describe('API tools', () => {
  it('lists metadata, handles help/invalid commands, and never prints keys', async () => {
    expect(await apiCommand([], store)).toBe(0)
    expect(await apiCommand(['help'], store)).toBe(0)
    expect(await apiCommand(['--help'], store)).toBe(0)
    expect(await apiCommand(['list'], store)).toBe(0)
    store.save({ provider: 'fal', apiKey: secret })
    expect(await apiCommand(['list', '--json'], store)).toBe(0)
    expect(await apiCommand(['list'], store)).toBe(0)
    for (const command of [['wrong'], ['wrong', 'fal'], ['run', 'fal'], ['request', 'fal'], ['request', 'fal', 'jobs', '--wrong', 'v'], ['request', 'fal', 'jobs', '--method']]) {
      expect(await apiCommand(command, store)).toBe(1)
    }
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(secret)
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secret)
  })

  it('gives the selected key only to a real child tool, preserves arguments and exit code', async () => {
    store.save({ provider: 'fal', apiKey: secret })
    const marker = join(directory, 'child.txt')
    const program = `require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ok: process.env.FAL_KEY === '${secret}',url: process.env.HARNESS_API_BASE_URL,arg: process.argv[2]})); process.exit(7)`
    const before = process.env.FAL_KEY
    expect(await apiCommand(['run', 'fal-ai', '--', process.execPath, '-e', program, marker, 'literal $(no-shell)'], store)).toBe(7)
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ ok: true, url: 'https://queue.fal.run', arg: 'literal $(no-shell)' })
    expect(process.env.FAL_KEY).toBe(before)
    expect(await apiCommand(['run', 'fal-ai', '--', '/nonexistent-fixture-command'], store)).toBe(1)
    expect(await apiCommand(['run', 'missing', '--', process.execPath], store)).toBe(1)
  })

  it('makes a real authenticated HTTP call, supports JSON files, and reports provider rejection', async () => {
    const requests: { url: string; key: string; body: string; method: string }[] = []
    server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk
      requests.push({ url: request.url!, key: request.headers['x-api-key'] as string, body, method: request.method! })
      response.writeHead(request.url === '/v1/denied' ? 401 : 200, { 'Content-Type': 'application/json' })
      response.end('{"answer":"fixture"}')
    })
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as { port: number }).port
    store.save({ provider: 'custom', name: 'Fixture', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: secret, authHeader: 'x-api-key', authPrefix: '' })
    const body = join(directory, 'request.json'); writeFileSync(body, '{"prompt":"hello"}')
    expect(await apiCommand(['request', 'fixture', 'generate', '--method', 'POST', '--data', '@' + body], store)).toBe(0)
    expect(requests[0]).toEqual({ url: '/v1/generate', key: secret, body: '{"prompt":"hello"}', method: 'POST' })
    expect(await apiCommand(['request', 'fixture', 'generate', '--method', 'POST', '--data', '{"inline":true}'], store)).toBe(0)
    expect(requests[1].body).toBe('{"inline":true}')
    expect(await apiCommand(['request', 'fixture', 'denied'], store)).toBe(1)
    expect(await apiCommand(['request', 'fixture', 'generate', '--method', 'TRACE'], store)).toBe(1)
    expect(await apiCommand(['request', 'fixture', 'generate', '--data', '{}'], store)).toBe(1)
    expect(await apiCommand(['request', 'fixture', 'generate', '--method', 'POST', '--data', '@/missing-file-fixture'], store)).toBe(1)
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(secret)
  })

  it('does not follow redirects or print network errors containing credentials', async () => {
    server = createServer((_request, response) => { response.writeHead(302, { Location: 'http://127.0.0.1:1/steal' }); response.end() })
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as { port: number }).port
    store.save({ provider: 'custom', name: 'Redirect', baseUrl: `http://127.0.0.1:${port}`, apiKey: secret })
    expect(await apiCommand(['request', 'redirect', ''], store)).toBe(1)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(secret))
    expect(await apiCommand(['request', 'redirect', ''], store)).toBe(1)
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secret)
  })

  it.each(['codex', 'claude', 'gemini'])('makes API tools discoverable in %s without keys or replacing existing instructions', engine => {
    prepareApiInstructions(store, directory, engine)
    store.save({ provider: 'fal', apiKey: secret })
    const file = join(directory, engine === 'claude' ? 'CLAUDE.md' : engine === 'gemini' ? 'GEMINI.md' : 'AGENTS.md')
    writeFileSync(file, '# My project\nKeep these instructions.\n')
    prepareApiInstructions(store, directory, engine)
    prepareApiInstructions(store, directory, engine)
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('# My project\nKeep these instructions.')
    expect(text.split('<!-- harness:apis -->')).toHaveLength(2)
    expect(text).toContain('harness api run')
    expect(text).not.toContain(secret)
  })

  it('creates instructions only when needed and leaves terminal and symlinked instruction files alone', () => {
    store.save({ provider: 'fal', apiKey: secret })
    prepareApiInstructions(store, directory, 'terminal')
    expect(existsSync(join(directory, 'AGENTS.md'))).toBe(false)
    prepareApiInstructions(store, directory, 'codex')
    expect(readFileSync(join(directory, 'AGENTS.md'), 'utf8')).toContain('harness api list')
    const target = join(directory, 'my-instructions.md'); writeFileSync(target, 'Preserve me')
    symlinkSync(target, join(directory, 'CLAUDE.md'))
    prepareApiInstructions(store, directory, 'claude')
    expect(readFileSync(target, 'utf8')).toBe('Preserve me')
  })
})
