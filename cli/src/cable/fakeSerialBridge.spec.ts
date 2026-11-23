import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// The e2e on Windows runs this stand-in as the dial's serial helper; its bridge is how a test's dial gets the bytes.
const FAKE = fileURLToPath(new URL('./__fixtures__/fakeHarnessSerial.mjs', import.meta.url))

const roots: string[] = []
const servers: Server[] = []
const children: ReturnType<typeof spawn>[] = []
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const endpoint = () => {
  if (process.platform === 'win32') return `\\\\.\\pipe\\harness-test-${randomBytes(8).toString('hex')}`
  const root = mkdtempSync(join(tmpdir(), 'fake-serial-bridge-'))
  roots.push(root)
  return join(root, 'dial.sock')
}

const serve = async (path: string) => {
  const connected = new Promise<Socket>((resolve) => {
    const server = createServer(resolve)
    servers.push(server)
    server.listen(path)
  })
  return connected
}

const runOpen = (path: string) => {
  const child = spawn(process.execPath, [FAKE, 'open', 'COM77'], {
    env: { ...process.env, FAKE_SERIAL_OPEN: `bridge:${path}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (text: string) => { stdout += text })
  child.stderr.setEncoding('utf8').on('data', (text: string) => { stderr += text })
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  return { child, exited, out: () => stdout, err: () => stderr }
}

const until = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('fakeHarnessSerial open bridge', { timeout: 10_000 }, () => {
  it('carries stdin to the endpoint and the endpoint to stdout, and exits 0 when the endpoint ends', async () => {
    const path = endpoint()
    const connected = serve(path)
    const run = runOpen(path)
    const socket = await connected
    let received = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => { received = Buffer.concat([received, chunk]) })
    await until(() => run.err() === 'open\n')

    const toDial = Buffer.from([0x00, 0x7e, 0xff, 0x0a, 0x41])
    run.child.stdin.write(toDial)
    await until(() => received.length >= toDial.length)
    expect(received).toEqual(toDial)

    socket.write('{"hello":"dial"}\n')
    await until(() => run.out() === '{"hello":"dial"}\n')

    socket.end()
    expect(await run.exited).toBe(0)
  })

  it('exits 0 when its stdin ends', async () => {
    const path = endpoint()
    const connected = serve(path)
    const run = runOpen(path)
    await connected
    await until(() => run.err() === 'open\n')
    run.child.stdin.end()
    expect(await run.exited).toBe(0)
  })

  it('says gone and exits 4 when nothing serves the endpoint', async () => {
    const run = runOpen(endpoint())
    expect(await run.exited).toBe(4)
    expect(run.err()).toBe('gone\n')
  })
})
