import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PTY_PROTOCOL } from '../ptyHost/protocol.js'
import { DigestMismatchError } from '../selfUpdate.js'
import {
  PTY_PAYLOAD_FILES, PtyPayloadRefused, fetchPtyEntry, preparePtyPayload, ptyManifestUrl, ptyPlatformKey, probeVersionLine, ptyUpdateWanted, sweepStagingFolders, type PtyEntry,
} from './ptyPayload.js'

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'pty-payload-')) })
afterEach(() => { vi.useRealTimers(); rmSync(tmp, { recursive: true, force: true }) })

function zipOf(names: readonly string[]): Buffer {
  const src = join(tmp, 'src'); rmSync(src, { recursive: true, force: true }); mkdirSync(src)
  for (const n of names) writeFileSync(join(src, n), n)
  const out = join(tmp, 'p.zip'); rmSync(out, { force: true })
  execFileSync('zip', ['-q', '-j', out, ...names.map((n) => join(src, n))])
  return readFileSync(out)
}

const entry: PtyEntry = { version: '0.11.0', url: 'https://cdn.example/p.zip', sha256: 'a'.repeat(64), size: 10 }
const goodProbe = (host: object = {}, serial: object = {}) => async (bin: string) =>
  bin.endsWith('harness-pty.exe')
    ? { version: '0.11.0', protocol: 2, features: ['seed'], ...host }
    : { version: '0.11.0', ...serial }
const run = (deps: Parameters<typeof preparePtyPayload>[2], files: readonly string[] = PTY_PAYLOAD_FILES) =>
  preparePtyPayload(entry, tmp + '/rt', { download: async () => zipOf(files), probe: goodProbe(), ...deps })
const leftovers = () => (existsSync(join(tmp, 'rt', 'pty')) ? readdirSync(join(tmp, 'rt', 'pty')) : [])

describe('ptyManifestUrl', () => {
  it('swaps the last two segments', () => {
    expect(ptyManifestUrl('https://x.example/a/cli/metadata.json')).toBe('https://x.example/a/pty/metadata.json')
  })
  it('throws on any other url', () => {
    expect(() => ptyManifestUrl('https://x.example/a/other.json')).toThrow()
  })
})

describe('ptyPlatformKey', () => {
  it('maps x64 and arm64, and nothing else', () => {
    expect(ptyPlatformKey('x64')).toBe('win32-x64')
    expect(ptyPlatformKey('arm64')).toBe('win32-arm64')
    expect(ptyPlatformKey('ia32')).toBeNull()
  })
})

describe('ptyUpdateWanted', () => {
  const cli = '1.2.3'
  it('newer is wanted', () => expect(ptyUpdateWanted(entry, { pty: '0.10.0', cli }, [])).toBe(true))
  it('same and older are not', () => {
    expect(ptyUpdateWanted(entry, { pty: '0.11.0', cli }, [])).toBe(false)
    expect(ptyUpdateWanted(entry, { pty: '0.12.0', cli }, [])).toBe(false)
  })
  it('a dev CLI never updates', () => expect(ptyUpdateWanted(entry, { pty: '0.10.0', cli: '1.2.3-dev.abc' }, [])).toBe(false))
  it('a rejected version is not', () => expect(ptyUpdateWanted(entry, { pty: '0.10.0', cli }, ['0.11.0'])).toBe(false))
  // Without a current-pty there is no previous version for probation to roll back to (install.ps1 installs the first).
  it('no installed pty wants none', () => expect(ptyUpdateWanted(entry, { pty: null, cli }, [])).toBe(false))
})

describe('preparePtyPayload', () => {
  it('a good zip is unpacked into a staging folder', async () => {
    const p = await run({})
    expect(p).toMatchObject({ version: '0.11.0', protocol: 2, features: ['seed'] })
    expect(p.staging.startsWith(join(tmp, 'rt', 'pty', '.staging-'))).toBe(true)
    expect(readdirSync(p.staging).sort()).toEqual([...PTY_PAYLOAD_FILES].sort())
  })
  it('a digest mismatch is refused and leaves nothing', async () => {
    await expect(run({ download: async () => { throw new DigestMismatchError('bad') } })).rejects.toBeInstanceOf(PtyPayloadRefused)
    expect(leftovers()).toEqual([])
  })
  it('a missing or extra file is refused', async () => {
    await expect(run({}, PTY_PAYLOAD_FILES.slice(1))).rejects.toThrow(/expected/)
    await expect(run({}, [...PTY_PAYLOAD_FILES, 'extra.dll'])).rejects.toThrow(/expected/)
    expect(leftovers()).toEqual([])
  })
  it('a host that names another version is refused', async () => {
    await expect(run({ probe: goodProbe({ version: '0.9.0' }) })).rejects.toThrow(/harness-pty reports version 0.9.0/)
    expect(leftovers()).toEqual([])
  })
  it('a protocol this CLI does not support is refused when it is below, and paired when it is above', async () => {
    // Supported: installed on its own, with any CLI build.
    const supported = await run({})
    expect(supported.paired).toBe(false)
    rmSync(supported.staging, { recursive: true, force: true })
    // Above: a host for a CLI build that needs it (spec §5, the pairing rule), canaried like any other and installed
    // only in that build's handover.
    const above = await run({ probe: goodProbe({ protocol: PTY_PROTOCOL + 1 }) })
    expect(above).toMatchObject({ version: '0.11.0', protocol: PTY_PROTOCOL + 1, paired: true })
    expect(readdirSync(above.staging).sort()).toEqual([...PTY_PAYLOAD_FILES].sort())
    rmSync(above.staging, { recursive: true, force: true })
    await expect(run({ probe: goodProbe({ protocol: PTY_PROTOCOL + 1 }, { version: '0.9.0' }) })).rejects.toThrow(/harness-serial reports version 0.9.0/)
    await expect(run({ probe: goodProbe({ protocol: PTY_PROTOCOL + 1, features: 'seed' }) })).rejects.toThrow(/features/)
    // Below every supported one, or not a protocol: no CLI will ever need it.
    await expect(run({ probe: goodProbe({ protocol: 0 }) })).rejects.toThrow(/protocol 0/)
    await expect(run({ probe: goodProbe({ protocol: 2.5 }) })).rejects.toThrow(/protocol 2.5/)
    expect(leftovers()).toEqual([])
  })
  it('a serial binary that names another version is refused', async () => {
    await expect(run({ probe: goodProbe({}, { version: '0.9.0' }) })).rejects.toThrow(/harness-serial reports version 0.9.0/)
    expect(leftovers()).toEqual([])
  })
  it('a canary that hangs past 5 s is refused', async () => {
    // Only the timers are faked: unzip is a real process and needs real time to finish.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let started = false
    const p = run({ probe: () => { started = true; return new Promise(() => {}) } })
    const assertion = expect(p).rejects.toThrow(/no answer within 5000 ms/)
    while (!started) await new Promise((r) => setImmediate(r))
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
    expect(leftovers()).toEqual([])
  })
})

describe('preparePtyPayload failure kinds', () => {
  it('a network error from the download is rethrown as it is, leaving no staging', async () => {
    const boom = new Error('ECONNRESET')
    const err = await run({ download: async () => { throw boom } }).catch((e) => e)
    expect(err).toBe(boom)
    expect(err).not.toBeInstanceOf(PtyPayloadRefused)
    expect(leftovers()).toEqual([])
  })
  it('an unzip that fails to spawn is rethrown as it is, leaving no staging', async () => {
    const boom = new Error('spawn unzip ENOENT')
    const err = await run({ unzip: async () => { throw boom } }).catch((e) => e)
    expect(err).toBe(boom)
    expect(leftovers()).toEqual([])
  })
  it('a probe that rejects is a refusal', async () => {
    await expect(run({ probe: async () => { throw new Error('exit 1') } })).rejects.toBeInstanceOf(PtyPayloadRefused)
    expect(leftovers()).toEqual([])
  })
})

describe('probeVersionLine', () => {
  // The same `<bin> version` run as ptyHost/launch.ts binaryVersion's (one implementation, 5 s, hidden).
  it.skipIf(process.platform === 'win32')('parses the last line a binary prints, and rejects one that fails', async () => {
    const good = join(tmp, 'good')
    writeFileSync(good, '#!/bin/sh\necho "starting"\necho \'{"version":"0.11.0"}\'\n', { mode: 0o755 })
    await expect(probeVersionLine(good)).resolves.toEqual({ version: '0.11.0' })
    const bad = join(tmp, 'bad')
    writeFileSync(bad, '#!/bin/sh\nexit 3\n', { mode: 0o755 })
    await expect(probeVersionLine(bad)).rejects.toThrow()
  })

  // A binary whose child holds its output open: a synchronous run outlived its timeout with it, and the updater's event
  // loop with it. The default canary refuses it within 5 s, and the loop runs meanwhile.
  it.skipIf(process.platform === 'win32')('a default probe that never answers is refused within the timeout, the event loop running', async () => {
    const unzip = async (_zip: Buffer, dest: string) => {
      for (const name of PTY_PAYLOAD_FILES) if (name !== 'harness-pty.exe') writeFileSync(join(dest, name), name)
      // Its child keeps stdout open after the shell is killed at the timeout.
      writeFileSync(join(dest, 'harness-pty.exe'), '#!/bin/sh\n(sleep 8)\n', { mode: 0o755 })
    }
    let beats = 0
    const beat = setInterval(() => { beats++ }, 100)
    const started = Date.now()
    try {
      const err = await preparePtyPayload(entry, join(tmp, 'rt'), { download: async () => Buffer.from('zip'), unzip }).catch((e) => e)
      expect(err).toBeInstanceOf(PtyPayloadRefused)
      expect((err as PtyPayloadRefused).reason).toMatch(/no answer within 5000 ms/)
      expect(Date.now() - started).toBeLessThan(7_000)
      expect(beats).toBeGreaterThan(20)
    } finally { clearInterval(beat) }
    expect(leftovers()).toEqual([])
  }, 15_000)
})

describe('sweepStagingFolders', () => {
  it('removes stale staging folders and nothing else', () => {
    const root = join(tmp, 'rt', 'pty')
    mkdirSync(join(root, '.staging-1-2'), { recursive: true })
    mkdirSync(join(root, '.staging-3-4'), { recursive: true })
    mkdirSync(join(root, '0.10.0'), { recursive: true })
    expect(sweepStagingFolders(join(tmp, 'rt'))).toBe(2)
    expect(readdirSync(root)).toEqual(['0.10.0'])
    expect(sweepStagingFolders(join(tmp, 'nothing'))).toBe(0)
  })
})

describe('fetchPtyEntry', () => {
  const good = { version: '0.11.0', url: 'https://cdn.example/p.zip', sha256: 'b'.repeat(64), size: 10 }
  const serve = (body: string, status = 200) => vi.stubGlobal('fetch', async () => new Response(body, { status }))
  const manifest = (e: object) => JSON.stringify({ pty: { 'win32-x64': e, 'win32-arm64': { ...good, version: '0.12.0' } } })
  afterEach(() => vi.unstubAllGlobals())

  it('reads the entry of the platform from the published shape', async () => {
    serve(manifest(good))
    expect(await fetchPtyEntry('https://m.example/pty/metadata.json', 'win32-x64')).toEqual(good)
    expect((await fetchPtyEntry('https://m.example/pty/metadata.json', 'win32-arm64'))?.version).toBe('0.12.0')
  })
  it('an absent platform is null', async () => {
    serve(JSON.stringify({ pty: { 'win32-arm64': good } }))
    expect(await fetchPtyEntry('https://m.example/m.json', 'win32-x64')).toBeNull()
  })
  it('a top-level entry (not the published shape) is null', async () => {
    serve(JSON.stringify({ 'win32-x64': good }))
    expect(await fetchPtyEntry('https://m.example/m.json', 'win32-x64')).toBeNull()
  })
  it.each([
    ['an http url', { url: 'http://cdn.example/p.zip' }],
    ['a 63-char sha', { sha256: 'b'.repeat(63) }],
    ['a non-hex sha', { sha256: 'z'.repeat(64) }],
    ['size 0', { size: 0 }],
    ['size 1.5', { size: 1.5 }],
    ['size "10"', { size: '10' }],
  ])('%s is null', async (_n, bad) => {
    serve(manifest({ ...good, ...bad }))
    expect(await fetchPtyEntry('https://m.example/m.json', 'win32-x64')).toBeNull()
  })
  it('a non-2xx response is null', async () => {
    serve(manifest(good), 404)
    expect(await fetchPtyEntry('https://m.example/m.json', 'win32-x64')).toBeNull()
  })
  it('malformed JSON is null', async () => {
    serve('{nope')
    expect(await fetchPtyEntry('https://m.example/m.json', 'win32-x64')).toBeNull()
  })
})
