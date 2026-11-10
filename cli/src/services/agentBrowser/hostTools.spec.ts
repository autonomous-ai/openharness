import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ownProcessGroup } from '../../lib/windows/noWindow.js'
import { download, run, sha256 } from './hostTools.js'

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return { ...real, execFile: vi.fn(real.execFile) }
})

let dir = ''
let server: Server | null = null
afterEach(() => {
  server?.close()
  server = null
  if (dir) rmSync(dir, { recursive: true, force: true })
  vi.mocked(execFile).mockClear()
})

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler)
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('download', () => {
  it('writes the file, following a redirect', async () => {
    dir = mkdtempSync(join(tmpdir(), 'host-tools-'))
    const base = await serve((request, response) => {
      if (request.url === '/latest') return void response.writeHead(302, { Location: '/podman.pkg' }).end()
      response.end('the installer')
    })
    await download(`${base}/latest`, join(dir, 'podman.pkg'), 5_000)
    expect(readFileSync(join(dir, 'podman.pkg'), 'utf8')).toBe('the installer')
  })

  it('a refusal and a download past its time throw', async () => {
    dir = mkdtempSync(join(tmpdir(), 'host-tools-'))
    const base = await serve((request, response) => {
      if (request.url === '/missing') return void response.writeHead(404).end()
      response.write('part')
    })
    await expect(download(`${base}/missing`, join(dir, 'a'), 5_000)).rejects.toThrow('answered 404')
    await expect(download(`${base}/slow`, join(dir, 'b'), 200)).rejects.toThrow()
  })
})

describe('sha256', () => {
  it('hashes the file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'host-tools-'))
    writeFileSync(join(dir, 'f'), 'abc')
    expect(await sha256(join(dir, 'f'))).toBe(createHash('sha256').update('abc').digest('hex'))
  })
})

describe('run', () => {
  it('answers the code and output, hidden and in its own group, and never rejects', async () => {
    expect(await run(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err")'], { timeoutMs: 10_000 }))
      .toEqual({ code: 0, stdout: 'out', stderr: 'err' })
    expect(vi.mocked(execFile).mock.calls[0]![2]).toEqual(expect.objectContaining({ ...ownProcessGroup(), timeout: 10_000 }))
    expect(await run(process.execPath, ['-e', 'process.stderr.write("no"); process.exit(3)'], { timeoutMs: 10_000 }))
      .toEqual({ code: 3, stdout: '', stderr: 'no' })
    expect(await run(process.execPath, ['-e', 'process.exit(4)'], { timeoutMs: 10_000 })).toMatchObject({ code: 4, stderr: expect.stringContaining('Command failed') })
    expect(await run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 }))
      .toEqual({ code: 1, stdout: '', stderr: `${process.execPath} timed out after 200 ms` })
    expect(await run('/no/such/program', [], { timeoutMs: 1_000 })).toMatchObject({ code: 1, stderr: expect.stringContaining('ENOENT') })
  })
})
