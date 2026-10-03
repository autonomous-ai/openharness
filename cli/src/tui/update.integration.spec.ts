import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Poller } from '../lib/selfUpdate.js'

let updater: Poller | undefined
const server = createServer()
let home = ''
afterEach(async () => {
  updater?.stop()
  server.closeAllConnections()
  if (server.listening) await new Promise<void>(done => server.close(() => done()))
  vi.unstubAllEnvs()
  if (home) rmSync(home, { recursive: true, force: true })
})

it('follows an hn-only release over HTTP, preserves the old binary on failure and retries', async () => {
  // Real HTTP, executable-version checks and disk replacement; no real daemon, tmux or user home.
  home = mkdtempSync(join(tmpdir(), 'hn-auto-http-'))
  const target = join(home, '.harness', 'bin', 'harness-tui')
  const binary = (version: string): Buffer => Buffer.from(`#!/bin/sh\nprintf 'hn ${version} (tmux 3.5a)\\n'\n`)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, binary('0.1.1'), { mode: 0o755 })
  let version = '0.1.2'
  let corrupt = false
  let downloads = 0
  let base = ''
  server.on('request', (req, res) => {
    const bytes = binary(version)
    if (req.url === '/metadata.json') {
      res.end(JSON.stringify({ version, builds: {
        [`${process.platform}-${process.arch}`]: { url: `${base}/hn`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length },
      } }))
    } else if (req.url === '/hn') {
      downloads++
      res.end(corrupt ? Buffer.from('incomplete') : bytes)
    } else { res.statusCode = 404; res.end() }
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture did not listen')
  base = `http://127.0.0.1:${address.port}`
  vi.stubEnv('HOME', home)
  vi.stubEnv('HARNESS_TUI_BIN', undefined)
  vi.stubEnv('HARNESS_TUI_MANIFEST_URL', `${base}/metadata.json`)
  vi.resetModules()
  const { startTuiUpdater } = await import('./update.js')
  const log = vi.fn()
  updater = startTuiUpdater({ currentVersion: '0.3.28', isInstalledCopy: true, disabled: false, intervalMs: 100, log })
  await vi.waitFor(() => expect(readFileSync(target)).toEqual(binary('0.1.2')), { timeout: 5000 })
  expect(downloads).toBe(1)
  // Keep the CLI at exactly the same version and publish only hn.
  version = '0.1.3'
  corrupt = true
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('will retry')), { timeout: 5000 })
  expect(readFileSync(target)).toEqual(binary('0.1.2'))
  corrupt = false
  await vi.waitFor(() => expect(readFileSync(target)).toEqual(binary('0.1.3')), { timeout: 5000 })
  updater.stop()
}, 15_000)
