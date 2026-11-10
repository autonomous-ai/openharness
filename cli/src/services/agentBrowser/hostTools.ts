/**
 * What setup does on this computer itself (setup.ts takes them as its dependencies): download the pinned Podman
 * installer, check its SHA-256, and run the installer, each bounded in time and started without a window
 * (docs/windows-rules.md, rule 1).
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ownProcessGroup } from '../../lib/windows/noWindow.js'

// Enough of what an installer said to name its failure.
const OUTPUT_LIMIT = 4 * 1024 * 1024

/** The release file, to `to`, within `timeoutMs` for the whole download. A refusal or a cut-off download throws. */
export async function download(url: string, to: string, timeoutMs: number): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`)
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(to))
}

export async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/** Never rejects: a command that could not start, failed or ran out of time answers a non-zero code and why. */
export function run(cmd: string, args: string[], opts: { timeoutMs: number }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeoutMs, maxBuffer: OUTPUT_LIMIT, ...ownProcessGroup() }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr })
      const code = typeof error.code === 'number' ? error.code : 1
      resolve({ code, stdout, stderr: error.killed ? `${cmd} timed out after ${opts.timeoutMs} ms` : stderr || error.message })
    })
  })
}
