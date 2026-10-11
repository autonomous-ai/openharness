/**
 * The npm wrapper of `harness mcp` (packages/harness-mcp): plain JavaScript with no dependencies, since it runs
 * before anything is installed, so it is imported here by path.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'

interface Package {
  INSTALL: string
  findHarness(env: Record<string, string | undefined>, home: string, executable?: (path: string) => boolean): string | null
  setupAnswer(message: unknown, platform?: string): Record<string, any> | null
  serveSetup(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, platform?: string): Promise<void>
  runHarness(path: string, run: (path: string, args: string[], options: object) => EventEmitter & { kill(signal: string): void }): Promise<number>
}
const where = '../../packages/harness-mcp/index.mjs'
const pkg = await import(where) as Package

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('npx @autonomous-ai/harness-mcp', () => {
  it('finds harness from HARNESS_BIN, the PATH, or where the installer links it', () => {
    const home = mkdtempSync(join(tmpdir(), 'harness-mcp-'))
    dirs.push(home)
    const on = (paths: string[]) => (path: string) => paths.includes(path)
    expect(pkg.findHarness({ HARNESS_BIN: '/opt/h', PATH: '/usr/bin' }, home, on(['/opt/h', '/usr/bin/harness']))).toBe('/opt/h')
    expect(pkg.findHarness({ PATH: '/a:/usr/bin' }, home, on(['/usr/bin/harness']))).toBe('/usr/bin/harness')
    // A client may start it with a PATH that leaves out ~/.local/bin.
    expect(pkg.findHarness({ PATH: '/usr/bin' }, home, on([join(home, '.local', 'bin', 'harness')]))).toBe(join(home, '.local', 'bin', 'harness'))
    expect(pkg.findHarness({}, home, on([]))).toBeNull()
    // The real check: an executable file.
    const bin = join(home, 'harness')
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
    expect(pkg.findHarness({ PATH: home }, '/nowhere')).toBe(bin)
    writeFileSync(join(home, 'plain'), '')
    expect(pkg.findHarness({ HARNESS_BIN: join(home, 'plain') }, '/nowhere')).toBeNull()
  })

  it('without Harness, offers one tool that says how to install it', () => {
    const hello = pkg.setupAnswer({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })!
    expect(hello.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'harness' } })
    expect(hello.result.instructions).toContain(pkg.INSTALL)
    expect(pkg.setupAnswer({ jsonrpc: '2.0', id: 2, method: 'initialize' })!.result.protocolVersion).toBe('2025-06-18')
    expect(pkg.setupAnswer({ jsonrpc: '2.0', id: 3, method: 'tools/list' })!.result.tools.map((t: { name: string }) => t.name)).toEqual(['harness_setup'])
    const told = pkg.setupAnswer({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'harness_setup' } })!
    expect(told.result.content[0].text).toContain(`  ${pkg.INSTALL}\n  harness start`)
    expect(told.result.content[0].text).toContain('ask the person')
    expect(pkg.setupAnswer({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'harness_setup' } }, 'win32')!.result.content[0].text).toContain('WSL')
    expect(pkg.setupAnswer({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'harness_list' } })).toMatchObject({ error: { code: -32602 } })
    expect(pkg.setupAnswer({ jsonrpc: '2.0', id: 7, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
    expect(pkg.setupAnswer({ jsonrpc: '2.0', id: 8, method: 'resources/list' })).toMatchObject({ error: { code: -32601 } })
    expect(pkg.setupAnswer({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
  })

  it('serves that over newline-delimited JSON-RPC', async () => {
    const input = new PassThrough(), output = new PassThrough()
    const lines: string[] = []
    output.on('data', (chunk) => lines.push(...String(chunk).split('\n').filter(Boolean)))
    const served = pkg.serveSetup(input, output, 'darwin')
    input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n\nnope\n${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    await served
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: '2.0', id: 1, result: { tools: [expect.objectContaining({ name: 'harness_setup' })] } },
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    ])
  })

  it('runs harness mcp in its place, with its exit', async () => {
    const asked: Array<[string, string[], object]> = []
    const child = Object.assign(new EventEmitter(), { kill: () => {} })
    const exited = pkg.runHarness('/bin/harness', (path, args, options) => { asked.push([path, args, options]); return child })
    child.emit('exit', 3, null)
    expect(await exited).toBe(3)
    expect(asked).toEqual([['/bin/harness', ['mcp'], { stdio: 'inherit' }]])
    const killed = Object.assign(new EventEmitter(), { kill: () => {} })
    const byStop = pkg.runHarness('/bin/harness', () => killed)
    killed.emit('exit', null, 'SIGTERM')
    expect(await byStop).toBe(1)
    const broken = Object.assign(new EventEmitter(), { kill: () => {} })
    const failed = pkg.runHarness('/bin/harness', () => broken)
    broken.emit('error', new Error('ENOENT'))
    expect(await failed).toBe(1)
  })
})
