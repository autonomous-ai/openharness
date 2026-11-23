// `harness device claude inbox` on real Windows (inbox.ts): the follower holds its poll over a real named pipe, proving
// the daemon's token, with the real process table's proof. inbox.spec.ts stands the pipe in by a Unix socket; this is
// the one run of the real pipe. Windows only; windows.yml lists it (plan Task 34).
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeDaemonRecord } from '../lib/daemonRecord.js'
import { listenLocalSocket } from '../lib/localSocket.js'
import { ensureDaemonToken, newPipePath } from '../lib/windows/pipeAuth.js'
import { createDaemonProof, followInbox } from './inbox.js'

const PORT = 4997
const SESSION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

/** A data folder with the daemon's token and its record of a real pipe, served with [serve]'s token: the daemon's own, or another. */
async function daemon(serve: 'daemon' | 'another token'): Promise<string> {
  const data = mkdtempSync(join(tmpdir(), 'inbox-pipe-'))
  cleanup.push(() => rmSync(data, { recursive: true, force: true }))
  const token = ensureDaemonToken(data)
  const pipe = newPipePath()
  const answers = [JSON.stringify({ text: 'hi' }), '{}']
  const served = await listenLocalSocket((req, res) => {
    req.resume()
    req.on('end', () => {
      const answer = answers.shift()
      if (answer) res.end(answer)
      else res.writeHead(404).end('{"error":"NOT_FOUND"}')
    })
  }, pipe, { token: serve === 'daemon' ? token : randomBytes(32) })
  cleanup.push(served.close)
  writeDaemonRecord(data, PORT, PORT, { pipe, pid: process.pid })
  return data
}

/** The follower's lines; the write of line [stopAt] fails, as one to a closed stdout does. */
async function follow(data: string, stopAt?: number): Promise<string[]> {
  const lines: string[] = []
  await followInbox(SESSION, {
    dataDir: data, port: PORT, platform: 'win32', acts: () => true, proof: createDaemonProof(),
    write: async (line) => {
      lines.push(line)
      return lines.length !== stopAt
    },
    wait: async () => {},
    parentAlive: () => true,
    now: Date.now,
  })
  return lines
}

describe.runIf(process.platform === 'win32')('the inbox follower over a real pipe on Windows', () => {
  it('prints what the person said, then {}', async () => {
    expect(await follow(await daemon('daemon'))).toEqual(['{"text":"hi"}', '{}', '{"off":true}'])
  }, 60_000)

  it('a server with another token gives no text line', async () => {
    expect(await follow(await daemon('another token'), 2)).toEqual(['{}', '{}'])
  }, 60_000)
})
