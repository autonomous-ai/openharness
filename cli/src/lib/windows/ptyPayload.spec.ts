import { execFileSync } from 'child_process'
import { chmodSync, existsSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PTY_PROTOCOL } from '../ptyHost/protocol.js'
import { DigestMismatchError } from '../selfUpdate.js'
import {
  PTY_PAYLOAD_FILES, PtyPayloadRefused, PtyPayloadUnpackFailed, CANARY_HOME_STALE_MS, SERVE_CANARY_BOUND_MS, fetchPtyEntry, preparePtyPayload, ptyManifestUrl, ptyPlatformKey,
  probeVersionLine, processesInFolder, ptyUpdateWanted, serveCanary, sweepCanaryHomes, sweepStagingFolders, type PtyEntry,
} from './ptyPayload.js'

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'pty-payload-')) })
afterEach(() => { vi.useRealTimers(); rmSync(tmp, { recursive: true, force: true }) })

function zipOf(names: readonly string[]): Buffer {
  const src = join(tmp, 'src'); rmSync(src, { recursive: true, force: true }); mkdirSync(src)
  for (const n of names) writeFileSync(join(src, n), n)
  const out = join(tmp, 'p.zip'); rmSync(out, { force: true })
  // Windows has no `zip`: its own bsdtar writes one (`-a` picks the format from the .zip suffix), and the payload's
  // default unzip there is that same tar.exe, so these cases go through the real Windows unpack.
  if (process.platform === 'win32') {
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', out, ...names], { cwd: src, windowsHide: true })
  } else {
    execFileSync('zip', ['-q', '-j', out, ...names.map((n) => join(src, n))])
  }
  return readFileSync(out)
}

const entry: PtyEntry = { version: '0.11.0', url: 'https://cdn.example/p.zip', sha256: 'a'.repeat(64), size: 10 }
const goodProbe = (host: object = {}, serial: object = {}) => async (bin: string) =>
  bin.endsWith('harness-pty.exe')
    ? { version: '0.11.0', protocol: 2, features: ['seed'], ...host }
    : { version: '0.11.0', ...serial }
const run = (deps: Parameters<typeof preparePtyPayload>[2], files: readonly string[] = PTY_PAYLOAD_FILES) =>
  preparePtyPayload(entry, tmp + '/rt', { download: async () => zipOf(files), probe: goodProbe(), serve: async () => {}, ...deps })
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
  it('an unzip that fails is no refusal: it carries the verified bytes, which a later prepare unpacks without a download', async () => {
    const zip = zipOf(PTY_PAYLOAD_FILES)
    let downloads = 0
    const err = await run({ download: async () => { downloads++; return zip }, unzip: async () => { throw new Error('spawn unzip ENOENT') } }).catch((e) => e)
    expect(err).toBeInstanceOf(PtyPayloadUnpackFailed)
    expect(err).not.toBeInstanceOf(PtyPayloadRefused)
    expect(err.reason).toBe('spawn unzip ENOENT')
    expect(err.zip).toBe(zip)
    expect(leftovers()).toEqual([])
    const again = await preparePtyPayload(entry, tmp + '/rt', { download: async () => { downloads++; return zip }, probe: goodProbe(), serve: async () => {} }, err.zip)
    expect(downloads).toBe(1)
    expect(readdirSync(again.staging).sort()).toEqual([...PTY_PAYLOAD_FILES].sort())
  })
  it('a probe that rejects is a refusal', async () => {
    await expect(run({ probe: async () => { throw new Error('exit 1') } })).rejects.toBeInstanceOf(PtyPayloadRefused)
    expect(leftovers()).toEqual([])
  })
})

describe('the serve canary', () => {
  it('runs after the version checks, on the staged host with its protocol and version, and its failure is a refusal', async () => {
    const asked: Array<{ binary: string; protocol: number; version: string }> = []
    const p = await run({ serve: async (binary, host) => { asked.push({ binary, ...host }) } })
    expect(asked).toEqual([{ binary: join(p.staging, 'harness-pty.exe'), protocol: 2, version: '0.11.0' }])
    rmSync(p.staging, { recursive: true, force: true })
    // Not reached for a payload a version check refused.
    asked.length = 0
    await expect(run({ probe: goodProbe({}, { version: '0.9.0' }), serve: async (binary, host) => { asked.push({ binary, ...host }) } })).rejects.toThrow(/harness-serial/)
    expect(asked).toEqual([])
    const err = await run({ serve: async () => { throw new Error('its create failed (spawn_failed: conpty.dll not found)') } }).catch((e) => e)
    expect(err).toBeInstanceOf(PtyPayloadRefused)
    expect(err.reason).toBe('harness-pty serve failed: its create failed (spawn_failed: conpty.dll not found)')
    expect(leftovers()).toEqual([])
  })

  it('a serve canary that never ends is refused at its bound', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let started = false
    const p = run({ serve: () => { started = true; return new Promise(() => {}) } })
    const assertion = expect(p).rejects.toThrow(/harness-pty serve failed: no answer within/)
    while (!started) await new Promise((r) => setImmediate(r))
    await vi.advanceTimersByTimeAsync(SERVE_CANARY_BOUND_MS)
    await assertion
    expect(leftovers()).toEqual([])
    // Cleanup included, under the updater's 30 s heartbeat timeout (harnessd/services.ts).
    expect(SERVE_CANARY_BOUND_MS).toBeLessThanOrEqual(20_000)
  })
})

describe.skipIf(process.platform === 'win32')('serveCanary, against stand-in binaries', () => {
  function script(name: string, body: string): string {
    const file = join(tmp, name)
    writeFileSync(file, `#!/bin/sh\n${body}\n`)
    chmodSync(file, 0o755)
    return file
  }
  const canaryHomes = (dir: string) => readdirSync(dir).filter((n) => n.startsWith('harness-pty-canary-'))

  it('a host that exits before it publishes is a failure, and its temporary home is gone', async () => {
    const homes = join(tmp, 'homes'); mkdirSync(homes)
    await expect(serveCanary(script('exits', 'exit 3'), { protocol: 2, version: '0.11.0' }, { tmpRoot: homes }))
      .rejects.toThrow(/exited with code 3 before it published its discovery file/)
    expect(canaryHomes(homes)).toEqual([])
  })

  it('a host that hangs is killed at the bound, and its temporary home is gone', async () => {
    const homes = join(tmp, 'homes'); mkdirSync(homes)
    const pidFile = join(tmp, 'pid')
    const binary = script('hangs', `echo $$ > '${pidFile}'\nexec sleep 30`)
    await expect(serveCanary(binary, { protocol: 2, version: '0.11.0' }, { tmpRoot: homes, timeoutMs: 3_000 })).rejects.toThrow(/no answer within 3000 ms/)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
    expect(canaryHomes(homes)).toEqual([])
  })

  it('runs the host outside its home, so a host or pane that lingers does not hold the folder', async () => {
    const homes = join(tmp, 'homes'); mkdirSync(homes)
    const cwdFile = join(tmp, 'cwd')
    await expect(serveCanary(script('cwd', `pwd -P > '${cwdFile}'\nexit 3`), { protocol: 2, version: '0.11.0' }, { tmpRoot: homes })).rejects.toThrow(/code 3/)
    expect(readFileSync(cwdFile, 'utf8').trim()).toBe(realpathSync(homes))
  })

  it('a home it cannot remove is left, and swept once stale, never while fresh', async () => {
    const homes = join(tmp, 'homes'); mkdirSync(homes)
    await expect(serveCanary(script('exits', 'exit 3'), { protocol: 2, version: '0.11.0' }, {
      tmpRoot: homes, remove: () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }) },
    })).rejects.toThrow(/exited with code 3/)
    const left = canaryHomes(homes)
    expect(left).toHaveLength(1)
    // A canary may be running in a fresh one.
    expect(sweepCanaryHomes(homes)).toBe(0)
    expect(canaryHomes(homes)).toEqual(left)
    // Other folders are never touched.
    mkdirSync(join(homes, 'something-else'))
    expect(sweepCanaryHomes(homes, CANARY_HOME_STALE_MS, Date.now() + CANARY_HOME_STALE_MS + 1_000)).toBe(1)
    expect(readdirSync(homes)).toEqual(['something-else'])
    expect(sweepCanaryHomes(join(tmp, 'no-such-folder'))).toBe(0)
  })
})

// The real host (`cd pty && cargo build`, then HARNESS_PTY_BIN=<that harness-pty>): start, hello, one pane that exits, shutdown.
const realHost = process.env.HARNESS_PTY_BIN
describe.runIf(realHost)('serveCanary, against the real host', () => {
  // Short off Windows: the host's Unix socket is in its home, and a macOS temporary folder is half a socket path already.
  let homes: string
  beforeEach(() => { homes = mkdtempSync(process.platform === 'win32' ? join(tmpdir(), 'hpc-') : '/tmp/hpc-') })
  afterEach(() => { rmSync(homes, { recursive: true, force: true }) })

  // Windows: the host's console process (OpenConsole.exe) must not outlive the canary, or the folder it started in
  // cannot be removed (and, staged, cannot be renamed). A leftover is named in the message.
  async function expectNoneLeft(): Promise<void> {
    if (process.platform !== 'win32') return
    const left = await processesInFolder(realHost!)
    expect(left, `processes still running from ${realHost}: ${JSON.stringify(left)}`).toEqual([])
    rmSync(homes, { recursive: true, maxRetries: 0 })
  }

  it('passes, and leaves no host and no home behind', async () => {
    const said = await probeVersionLine(realHost!) as { version: string; protocol: number }
    await serveCanary(realHost!, { protocol: said.protocol, version: said.version }, { tmpRoot: homes })
    expect(readdirSync(homes)).toEqual([])
    await expectNoneLeft()
  }, 30_000)

  it('a host that cannot start a pane fails it', async () => {
    const said = await probeVersionLine(realHost!) as { version: string; protocol: number }
    await expect(serveCanary(realHost!, { protocol: said.protocol, version: said.version }, { tmpRoot: homes, command: [join(tmp, 'no-such-shell')] }))
      .rejects.toThrow(/its create failed|its pane exited with/)
    expect(readdirSync(homes)).toEqual([])
    await expectNoneLeft()
  }, 30_000)
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
