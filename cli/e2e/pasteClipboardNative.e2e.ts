/** Real native owners under private homes/displays. Never use the login session's clipboard. */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { startClipboardOwner, type ClipboardOwner } from '../src/services/pasteClipboardNative.js'
import { captureClipboardGroup, captureProcess, cleanupPasteFixture, processGone, terminateProcess, type OwnedProcess } from '../src/testing/pasteNativeProof.js'
import { until } from './harness/daemon.js'

const exec = promisify(execFile)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPa0AAAAASUVORK5CYII=', 'base64')
const deadline = <T>(promise: Promise<T>, label: string): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(label)), 10_000)
  promise.then((value) => { clearTimeout(timer); resolve(value) }, (error) => { clearTimeout(timer); reject(error) })
})
const closed = (child: ChildProcess) => new Promise<void>((resolve, reject) => {
  child.once('error', reject); child.once('close', () => resolve())
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-native-paste-'))
  const home = join(root, 'home'), temporary = join(root, 'tmp')
  mkdirSync(home, { mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 })
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: home, CFFIXED_USER_HOME: home, TMPDIR: temporary }
  return { root, env, file() {
    const path = join(root, `${randomUUID()}.png`)
    writeFileSync(path, png, { mode: 0o600, flag: 'wx' })
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    unlinkSync(path); writeFileSync(path, 'pathname replacement', { mode: 0o600, flag: 'wx' })
    return { path, descriptor, current: () => true, close: () => closeSync(descriptor) }
  }, close: () => rmSync(root, { recursive: true, force: true }) }
}

it.skipIf(process.platform !== 'darwin')('the actual Mac helper publishes inherited bytes to a private named pasteboard', async () => {
  const f = fixture(), board = `harness-native-fixture-${randomUUID()}`
  let owner: ClipboardOwner | undefined
  try {
    owner = startClipboardOwner(f.file(), { env: f.env, privateBoard: board })
    expect(await owner.ready).toEqual({ state: 'written' })
    await deadline(owner.settled, 'PASTE_NATIVE_MAC_OWNER_NOT_SETTLED')
    const script = `ObjC.import('Foundation'); ObjC.import('AppKit');
const board = $.NSPasteboard.pasteboardWithName($(${JSON.stringify(board)}));
let bytes; try { bytes = ObjC.unwrap(board.dataForType($('public.png')).base64EncodedStringWithOptions(0)); }
finally { board.releaseGlobally; } bytes;`
    const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { env: f.env, timeout: 5_000, maxBuffer: 4096 })
    expect(Buffer.from(stdout.trim(), 'base64')).toEqual(png)
  } finally {
    await cleanupPasteFixture([
      ['Mac owner cancellation', () => owner?.cancel()],
      ['Mac owner settlement', async () => { if (owner) await deadline(owner.settled, 'PASTE_NATIVE_MAC_CLEANUP_FAILED') }],
      // Release the fixture board even if preparation or settlement failed; report a failed release.
      ['private pasteboard release', async () => { await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
        `ObjC.import('AppKit'); $.NSPasteboard.pasteboardWithName($(${JSON.stringify(board)})).releaseGlobally;`],
      { env: f.env, timeout: 5_000, maxBuffer: 4096 }) }],
      ['private root removal', f.close],
    ])
  }
}, 30_000)

it.skipIf(process.platform !== 'linux')('a real forked xclip owner survives launcher exit, then cancels and dies with its worker', async () => {
  const f = fixture()
  const server = spawn('/usr/bin/Xvfb', ['-displayfd', '3', '-screen', '0', '800x600x24', '-nolisten', 'tcp'],
    { env: f.env, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })
  const serverClosed = closed(server)
  let owner: ClipboardOwner | undefined, worker: ChildProcess | undefined, workerClosed: Promise<void> | undefined
  let serverIdentity: OwnedProcess | undefined, workerIdentity: OwnedProcess | undefined
  const groups: OwnedProcess[][] = []
  const gone = async (owners: OwnedProcess[]): Promise<void> => {
    await until('captured native owner identities to disappear', () => owners.every(identity => processGone(identity)), 10_000, 20)
  }
  try {
    serverIdentity = captureProcess(server.pid!)
    const display = await deadline(new Promise<string>((resolve, reject) => {
      let value = ''
      server.once('error', reject)
      server.stdio[3]!.on('data', (chunk: Buffer) => {
        value += chunk.toString()
        if (value.length > 16) reject(new Error('PASTE_NATIVE_DISPLAY_LIMIT'))
        else if (value.endsWith('\n')) /^\d+\n$/.test(value) ? resolve(`:${value.trim()}`) : reject(new Error('PASTE_NATIVE_INVALID_DISPLAY'))
      })
      server.once('exit', () => reject(new Error('PASTE_NATIVE_DISPLAY_EXITED')))
    }), 'PASTE_NATIVE_DISPLAY_TIMEOUT')
    const bin = join(f.root, 'bin'); mkdirSync(bin, { mode: 0o700 })
    // Record the owned group leader before the real xclip forks. The actual tool receives unchanged argv/fd0.
    writeFileSync(join(bin, 'xclip'), '#!/bin/sh\n/bin/cat "/proc/$$/stat" > "$PASTE_FIXTURE_OWNER_MARKER"\nexec /usr/bin/xclip "$@"\n', { mode: 0o700 })
    const env = { ...f.env, DISPLAY: display, PATH: `${bin}:/usr/bin:/bin` }
    const capture = async (marker: string) => {
      const { stdout } = await exec('/bin/ps', ['-eo', 'pid=,pgid='], { env, timeout: 5_000, maxBuffer: 64 * 1024 })
      const group = captureClipboardGroup(readFileSync(marker, 'utf8'), stdout)
      groups.push(group)
      return group
    }
    const read = () => exec('/usr/bin/xclip', ['-selection', 'clipboard', '-target', 'image/png', '-out'],
      { env, timeout: 5_000, maxBuffer: 4096, encoding: 'buffer' })
    const firstMarker = join(f.root, 'first-owner.stat')
    owner = startClipboardOwner(f.file(), { env: { ...env, PASTE_FIXTURE_OWNER_MARKER: firstMarker } })
    expect(await owner.ready).toEqual({ state: 'written' })
    let settled = false; void owner.settled.then(() => { settled = true })
    expect((await read()).stdout).toEqual(png)
    expect(settled).toBe(false) // A successful read after launcher exit proves the fork still serves selection.
    const firstOwners = await capture(firstMarker)
    owner.cancel(); await deadline(owner.settled, 'PASTE_NATIVE_OWNER_CANCEL_TIMEOUT')
    expect(settled).toBe(true)
    await gone(firstOwners)

    const bundle = join(f.root, 'native-owner.mjs')
    await build({ entryPoints: [resolve('src/services/pasteClipboardNative.ts')], outfile: bundle, bundle: true,
      platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent' })
    const file = f.file()
    const workerMarker = join(f.root, 'worker-owner.stat')
    try {
      worker = spawn(process.execPath, ['--input-type=module', '-e', `
import { startClipboardOwner } from ${JSON.stringify(pathToFileURL(bundle).href)};
import { closeSync } from 'node:fs';
const owner = startClipboardOwner({ path: '', descriptor: 3, current: () => true, close() { closeSync(3); } });
process.stdout.write(JSON.stringify(await owner.ready) + '\\n');
await owner.settled;`], { env: { ...env, PASTE_FIXTURE_OWNER_MARKER: workerMarker }, stdio: ['ignore', 'pipe', 'pipe', file.descriptor] })
      workerClosed = closed(worker)
      worker.stderr!.resume()
      workerIdentity = captureProcess(worker.pid!)
    } finally { file.close() }
    const ready = await deadline(new Promise<string>((resolve, reject) => {
      let answer = ''
      worker!.once('error', reject)
      worker!.stdout!.on('data', (chunk: Buffer) => {
        answer += chunk.toString()
        if (answer.length > 1024) reject(new Error('PASTE_NATIVE_WORKER_REPLY_LIMIT'))
        else if (answer.endsWith('\n')) resolve(answer)
      })
      worker!.once('exit', () => reject(new Error('PASTE_NATIVE_WORKER_EARLY_EXIT')))
    }), 'PASTE_NATIVE_WORKER_READY_TIMEOUT')
    expect(JSON.parse(ready)).toEqual({ state: 'written' })
    expect((await read()).stdout).toEqual(png)
    const workerOwners = await capture(workerMarker)
    terminateProcess(workerIdentity!); await deadline(workerClosed!, 'PASTE_NATIVE_WORKER_EXIT_TIMEOUT')
    await gone(workerOwners)
  } finally {
    await cleanupPasteFixture([
      ['clipboard owner cancellation', () => owner?.cancel()],
      ['worker termination', () => { if (workerIdentity) terminateProcess(workerIdentity) }],
      ...groups.flat().map(identity => ['native owner termination', () => terminateProcess(identity)] as const),
      ['clipboard owner settlement', async () => { if (owner) await deadline(owner.settled, 'PASTE_NATIVE_OWNER_CLEANUP_TIMEOUT') }],
      ['worker exit', async () => { if (workerClosed) await deadline(workerClosed, 'PASTE_NATIVE_WORKER_CLEANUP_TIMEOUT') }],
      ...groups.map(group => ['native owner disappearance', () => gone(group)] as const),
      ['private display termination', () => { if (serverIdentity) terminateProcess(serverIdentity) }],
      ['private display exit', async () => { await deadline(serverClosed, 'PASTE_NATIVE_DISPLAY_CLEANUP_TIMEOUT') }],
      ['private root removal', f.close],
    ])
  }
}, 60_000)
