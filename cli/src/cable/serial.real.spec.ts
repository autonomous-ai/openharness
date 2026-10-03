import { execFile, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const hasPty = process.platform !== 'win32' && spawnSync('python3', ['-c', 'import pty']).status === 0

it.skipIf(!hasPty || process.platform !== 'darwin')('arbitrates competing macOS serial owners and releases the claim after a crash', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'serial-claim-'))
  try {
    const worker = join(scratch, 'serial-claim.mjs')
    await build({
      entryPoints: [fileURLToPath(new URL('./__fixtures__/serialClaim.ts', import.meta.url))],
      outfile: worker, bundle: true, platform: 'node', format: 'esm', target: 'node20',
    })
    const driver = fileURLToPath(new URL('./__fixtures__/serialClaim.py', import.meta.url))
    const { stdout } = await promisify(execFile)('python3', [driver, process.execPath, worker], { timeout: 12000 })
    expect(stdout).toContain('exclusive claim, orderly handoff and crash recovery passed')
  } finally { await rm(scratch, { recursive: true, force: true }) }
}, 15000)

it.skipIf(!hasPty)('keeps DNS and file I/O working across repeated silent tty closes with one worker', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'serial-idle-'))
  // The master stays open and sends nothing. This exercises the real kernel tty and native reads,
  // without touching a USB device or requiring a native production dependency.
  const python = spawn('python3', ['-u', '-c',
    'import os, pty, sys\nmaster, slave = pty.openpty()\nprint(os.ttyname(slave), flush=True)\nsys.stdin.read()\n',
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: python.stdout })
  try {
    const [path] = await once(lines, 'line')
    const worker = join(scratch, 'serial-idle.mjs')
    await build({
      entryPoints: [fileURLToPath(new URL('./__fixtures__/serialIdle.ts', import.meta.url))],
      outfile: worker, bundle: true, platform: 'node', format: 'esm', target: 'node20',
    })
    const { stdout } = await promisify(execFile)(process.execPath, [worker, path], {
      env: { ...process.env, UV_THREADPOOL_SIZE: '1' }, timeout: 10_000,
    })
    expect(stdout).toContain('8 idle reopen cycles: DNS, HTTP, file I/O and close succeeded')
  } finally {
    lines.close()
    python.kill()
    await rm(scratch, { recursive: true, force: true })
  }
}, 15_000)

it.skipIf(!hasPty).each(['duplex', 'disconnect', 'close'])(
  'preserves binary serial frames and handles %s while writes are backpressured', async mode => {
    const scratch = await mkdtemp(join(tmpdir(), 'serial-duplex-'))
    try {
      const worker = join(scratch, 'serial-duplex.mjs')
      await build({
        entryPoints: [fileURLToPath(new URL('./__fixtures__/serialDuplex.ts', import.meta.url))],
        outfile: worker, bundle: true, platform: 'node', format: 'esm', target: 'node20',
      })
      const driver = fileURLToPath(new URL('./__fixtures__/serialDuplex.py', import.meta.url))
      const { stdout } = await promisify(execFile)('python3', [driver, process.execPath, worker, mode], { timeout: 12_000 })
      expect(JSON.parse(stdout)).toEqual({ mode, passed: true, sessionLeader: true })
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }, 15_000,
)
