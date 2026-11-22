import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { CableDecoder, CableType, encodeCableFrame } from '../cable/cableFrame.js'
import { echoesCodeMoves } from '../cable/cableSession.js'
import { shouldOffer } from '../cable/fwPush.js'

const { FakeDial } = await import('../../e2e/harness/fakeDial.js' as string) as {
  FakeDial: { listen(endpoint: string): Promise<{ greet(ms?: number): Promise<unknown>; close(): Promise<void> }> }
}

const roundFw = readFileSync(join(process.cwd(), '../devices/harness-device/firmware/version.txt'), 'utf8').trim()
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

// The fake stands in for a round dial on today's firmware: one that greets as older firmware would turn the daemon's
// echo guard on for every e2e run and the dial eval, a path no current dial takes.
it('greets as a round dial on the current firmware, which echoes no code moves and is never offered an update', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fakedial-'))
  dirs.push(dir)
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\fakedial-${process.pid}` : join(dir, 'dial.sock')
  const dial = await FakeDial.listen(endpoint)
  const daemon = connect(endpoint)
  let hello: Record<string, unknown> | undefined
  try {
    // The daemon's end: each greeting is welcomed, and `greet` waits, bounded, for that welcome.
    const decoder = new CableDecoder()
    daemon.on('data', (chunk: Buffer) => decoder.feed(chunk, (frame) => {
      if (frame.type !== CableType.Json) return
      hello ??= JSON.parse(Buffer.from(frame.payload).toString('utf8')) as Record<string, unknown>
      daemon.write(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify({ t: 'welcome' }), 'utf8')))
    }))
    await dial.greet(10_000)
  } finally {
    daemon.destroy()
    await dial.close()
  }

  const fw = hello?.fw as string
  expect(fw.startsWith(`${roundFw}-`)).toBe(true)
  expect(echoesCodeMoves(fw, undefined)).toBe(false)
  expect(shouldOffer(fw, '9.9.9')).toBe(false)
})
