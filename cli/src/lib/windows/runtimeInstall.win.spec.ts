import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// nodejs.org's Windows zip shape (node-v<version>-win-<arch>/node.exe), unpacked by System32's tar.exe, as
// ensureManagedRuntime does on a real Windows computer. The archive holds a copy of the Node running this test,
// so the --version check before the pointer is written is real too.
describe.runIf(process.platform === 'win32')('ensureManagedRuntime on Windows', () => {
  let root = ''
  let runtimeDir = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harness-runtime-win-'))
    runtimeDir = join(root, '.harness', 'runtime')
    mkdirSync(runtimeDir, { recursive: true })
    process.env.ADAPTER_RUNTIME_DIR = runtimeDir
    process.env.ADAPTER_RUNTIME_METADATA_URL = 'https://example.test/runtime/metadata.json'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(root, { recursive: true, force: true })
    delete process.env.ADAPTER_RUNTIME_DIR
    delete process.env.ADAPTER_RUNTIME_METADATA_URL
  })

  it('downloads the zip, unpacks node.exe with Windows\' tar.exe, and records it with a CRLF pointer', async () => {
    const key = `win32-${process.arch}`
    const archiveRoot = `node-v22.0.0-win-${process.arch}`
    const source = join(root, 'src')
    mkdirSync(join(source, archiveRoot), { recursive: true })
    copyFileSync(process.execPath, join(source, archiveRoot, 'node.exe'))
    const zip = join(root, 'node.zip')
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', zip, '-C', source, archiveRoot])
    const bytes = readFileSync(zip)
    const manifest = {
      node: { [key]: { version: 'v22.0.0', url: 'https://example.test/runtime/node.zip', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, archiveRoot } },
    }
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('metadata.json')) return { ok: true, json: async () => manifest } as unknown as Response
      if (url.endsWith('.zip')) return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } as unknown as Response
      return { ok: false, status: 404 } as unknown as Response
    })
    vi.resetModules()
    const { ensureManagedRuntime } = await import('../runtimeInstall.js')

    const node = await ensureManagedRuntime()

    expect(node).toBe(join(runtimeDir, `node-v22.0.0-${key}`, 'node.exe'))
    expect(existsSync(node!)).toBe(true)
    expect(readFileSync(join(runtimeDir, 'current-node'), 'utf8')).toBe(`${node}\r\n`)
    expect(readdirSync(runtimeDir).filter((name) => name.startsWith('.node-staging-'))).toEqual([])
  }, 180_000)
})
