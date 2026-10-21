import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DigestMismatchError } from '../selfUpdate.js'
import {
  PTY_PAYLOAD_FILES, PtyPayloadRefused, preparePtyPayload, ptyManifestUrl, ptyPlatformKey, ptyUpdateWanted, type PtyEntry,
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
  it('no installed pty wants any', () => expect(ptyUpdateWanted(entry, { pty: null, cli }, [])).toBe(true))
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
  it('an unsupported protocol is refused', async () => {
    await expect(run({ probe: goodProbe({ protocol: 9 }) })).rejects.toThrow(/protocol 9/)
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
