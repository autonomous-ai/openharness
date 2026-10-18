/**
 * The Desktop's download marker as the daemon reads it, the pane's check exactly (lib/engineLaunch.ts
 * `harness_wait_download`): real files in a private home and real processes, never the person's `~/.harness`.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DOWNLOAD_HOLD_MS, engineDownloading } from './downloadMarker.js'

let home: string, run: string
const children: ChildProcess[] = []
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'download-marker-')); run = join(home, '.harness', 'run'); mkdirSync(run, { recursive: true }) })
afterEach(() => { for (const child of children.splice(0)) child.kill('SIGKILL'); rmSync(home, { recursive: true, force: true }) })

/** As the Desktop starts its download: `sh -c '<script>; exit $?' harness-download`, the name its $0. */
async function download(): Promise<number> {
  const child = spawn('/bin/sh', ['-c', 'sleep 30; exit $?', 'harness-download'], { stdio: 'ignore' })
  children.push(child)
  await new Promise(done => child.once('spawn', done))
  return child.pid!
}
const mark = (text: string, engine = 'codex') => writeFileSync(join(run, `downloading-${engine}`), text)

it('is a live process the marker names whose command line names the download, for that engine alone', async () => {
  const pid = await download()
  mark(String(pid))
  expect(await engineDownloading('codex', home)).toBe(true)
  expect(await engineDownloading('claude', home)).toBe(false)
  // The pane reads it through `$(cat …)`, which drops trailing newlines.
  mark(`${pid}\n`)
  expect(await engineDownloading('codex', home)).toBe(true)
})

it('is no download for a missing, malformed, oversized or stale marker, or one that is not a file', async () => {
  const pid = await download()
  expect(await engineDownloading('codex', home)).toBe(false)
  for (const text of ['', ' 12', `${pid}x`, '-1', '0', '12345678901', `${pid}\n${pid}`]) {
    mark(text)
    expect(await engineDownloading('codex', home), JSON.stringify(text)).toBe(false)
  }
  mark(`${pid}`.padEnd(40, '\n'))
  expect(await engineDownloading('codex', home)).toBe(false)
  // Older than a pane waits for a download.
  mark(String(pid))
  const old = (Date.now() - DOWNLOAD_HOLD_MS - 60_000) / 1000
  utimesSync(join(run, 'downloading-codex'), old, old)
  expect(await engineDownloading('codex', home)).toBe(false)
  expect(await engineDownloading('codex', home, () => Date.now() - DOWNLOAD_HOLD_MS)).toBe(true)
  // A folder, and a FIFO with no writer, which must not hold the read.
  rmSync(join(run, 'downloading-codex'))
  mkdirSync(join(run, 'downloading-codex'))
  expect(await engineDownloading('codex', home)).toBe(false)
  execFileSync('mkfifo', [join(run, 'downloading-claude')])
  expect(await engineDownloading('claude', home)).toBe(false)
})

it('is no download for a process that is gone, another user\'s, or anything but the download', async () => {
  const ended = spawn('/bin/sh', ['-c', 'exit 0', 'harness-download'], { stdio: 'ignore' })
  await new Promise(done => ended.once('exit', done))
  mark(String(ended.pid))
  expect(await engineDownloading('codex', home)).toBe(false)
  // pid 1 is the system's: signalling it is refused, as `kill -0` is refused it (and as root, it is not the download).
  mark('1')
  expect(await engineDownloading('codex', home)).toBe(false)
  // A stale marker's pid taken over by another process: this test's runner.
  mark(String(process.pid))
  expect(await engineDownloading('codex', home)).toBe(false)
})
