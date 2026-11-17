/**
 * Whether Harness's VS Code extension is on, and VS Code's own install and uninstall of it, against a computer of the
 * test's own: files from a table, a `code` that records each run and answers from a list, and temporary folders in the
 * test's scratch. The real dependencies are run only on that scratch and on fake `code` scripts in it: never an
 * installed VS Code, /Applications or ~/.vscode.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { crc32 } from '../lib/zipWriter.js'
import {
  buildVersion, packVsix, recordVersion, vscodeDisable, vscodeEnable, vscodeExtensionDeps, vscodeStatus,
  VSCODE_EXTENSION_ID, VSCODE_RECORD_MAX_BYTES, type VscodeExtensionDeps, type VscodeExtensionFiles,
} from './vscodeExtension.js'

const HOME = '/Users/someone'
const APP = '/Applications/Visual Studio Code.app'
const CODE = `${APP}/Contents/Resources/app/bin/code`
const RECORD = `${HOME}/.vscode/extensions/extensions.json`
/** VS Code with its CLI, on a Mac. */
const MAC = { [APP]: '', [CODE]: '' }
const DESCRIPTION = 'The Harness dial reaches Claude Code and Codex in this window\'s terminals.'
const FILES: VscodeExtensionFiles = {
  manifest: JSON.stringify({
    name: 'harness-device', displayName: 'Harness Device', description: DESCRIPTION, version: '1.2.3',
    publisher: 'autonomous-ai', engines: { vscode: '^1.75.0' }, main: './extension.js', activationEvents: ['onStartupFinished'],
  }),
  main: 'exports.activate = () => {}\n',
}
const ENTRIES = ['extension.vsixmanifest', '[Content_Types].xml', 'extension/package.json', 'extension/extension.js']
const OK = { code: 0, timedOut: false }

function record(version: unknown, id: unknown = VSCODE_EXTENSION_ID): string {
  return JSON.stringify([{ identifier: { id, uuid: '00000000-0000-0000-0000-000000000000' }, version, location: { $mid: 1, path: '/x' } }])
}

/** Enough of a ZIP reader to check what writeZip produced, as zipWriter's own spec reads one: walks the local headers. */
function readZip(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let at = 0
  while (zip.readUInt32LE(at) === 0x04034b50) {
    const method = zip.readUInt16LE(at + 8)
    const crc = zip.readUInt32LE(at + 14)
    const csize = zip.readUInt32LE(at + 18)
    const nlen = zip.readUInt16LE(at + 26)
    const name = zip.subarray(at + 30, at + 30 + nlen).toString('utf8')
    const body = zip.subarray(at + 30 + nlen, at + 30 + nlen + csize)
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body)
    expect(crc32(data)).toBe(crc)
    out.set(name, data)
    at += 30 + nlen + csize
  }
  expect(zip.readUInt32LE(at)).toBe(0x02014b50)
  return out
}

let scratch = ''
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'vscode-extension-')) })
afterEach(() => { rmSync(scratch, { recursive: true, force: true }) })

interface ComputerOptions {
  platform?: NodeJS.Platform
  pathVar?: string
  disk?: Record<string, string>
  answers?: Array<{ code: number | null; timedOut: boolean }>
  files?: VscodeExtensionFiles | null
  write?: VscodeExtensionDeps['write']
}

/** A computer as the module sees it. Its temporary folders are real, in the test's scratch, and written and removed by
 *  the real dependencies, so a test sees the file's mode and the folder gone. */
function computer(options: ComputerOptions = {}) {
  const disk = new Map(Object.entries(options.disk ?? {}))
  const runs: Array<[string, readonly string[], number]> = []
  const folders: string[] = []
  const answers = [...options.answers ?? []]
  const real = vscodeExtensionDeps()
  const machine = {
    disk, runs, folders,
    /** What the fake `code` does when it runs, before it answers. */
    whenRun: undefined as ((file: string, args: readonly string[]) => void) | undefined,
    deps: {
      platform: options.platform ?? 'darwin',
      home: HOME,
      pathVar: options.pathVar ?? '/usr/bin:/bin',
      exists: (path) => disk.has(path),
      executable: (path) => disk.has(path),
      read: (path, maxBytes) => {
        const text = disk.get(path)
        return text === undefined || Buffer.byteLength(text) > maxBytes ? null : text
      },
      run: async (file, args, timeoutMs) => {
        runs.push([file, args, timeoutMs])
        machine.whenRun?.(file, args)
        return answers.shift() ?? OK
      },
      files: () => options.files === undefined ? FILES : options.files,
      tempDir: () => {
        const folder = mkdtempSync(join(scratch, 'vsix-'))
        folders.push(folder)
        return folder
      },
      write: options.write ?? real.write,
      remove: real.remove,
    } satisfies VscodeExtensionDeps,
  }
  return machine
}

describe('vscodeStatus', () => {
  it('absent on Windows whatever is on disk, on a Mac with no app, on Linux with no code on PATH', () => {
    const everything = { ...MAC, '/usr/bin/code': '', [RECORD]: record('1.2.3') }
    expect(vscodeStatus(computer({ platform: 'win32', disk: everything }).deps)).toEqual({ vscode: 'absent' })
    expect(vscodeStatus(computer({ platform: 'darwin', disk: { [RECORD]: record('1.2.3') } }).deps)).toEqual({ vscode: 'absent' })
    expect(vscodeStatus(computer({ platform: 'linux', pathVar: '/usr/local/bin:/opt/bin', disk: everything }).deps)).toEqual({ vscode: 'absent' })
    expect(vscodeStatus(computer({ platform: 'freebsd', disk: everything }).deps)).toEqual({ vscode: 'absent' })
  })

  it('the app in the home\'s Applications counts; /Applications is looked at first', async () => {
    const homeApp = `${HOME}/Applications/Visual Studio Code.app`
    const homeCode = `${homeApp}/Contents/Resources/app/bin/code`
    const mine = computer({ disk: { [homeApp]: '', [homeCode]: '', [RECORD]: record('1.2.3') } })
    expect(vscodeStatus(mine.deps)).toEqual({ vscode: 'on', version: '1.2.3' })
    await vscodeDisable(mine.deps)
    expect(mine.runs.map(([file]) => file)).toEqual([homeCode])
    // The first app found is VS Code: one in /Applications without its CLI is not passed over for the home's.
    const both = computer({ disk: { [APP]: '', [homeApp]: '', [homeCode]: '' } })
    expect(await vscodeEnable(both.deps)).toEqual({ vscode: 'off', error: 'no-code' })
    expect(both.runs).toEqual([])
  })

  it('on with the record\'s version; the id is compared without case', () => {
    const text = JSON.stringify([
      { identifier: { id: 'ms-python.python' }, version: '2026.1.0' },
      { identifier: { id: 'Autonomous-AI.Harness-Device' }, version: '0.6.60-dev.g0123456.dirty' },
    ])
    const on = { vscode: 'on', version: '0.6.60-dev.g0123456.dirty' }
    expect(recordVersion(text)).toBe('0.6.60-dev.g0123456.dirty')
    expect(vscodeStatus(computer({ disk: { ...MAC, [RECORD]: text } }).deps)).toEqual(on)
    // Linux: a `code` on PATH, in any of its folders.
    expect(vscodeStatus(computer({ platform: 'linux', pathVar: '/usr/local/bin:/usr/bin', disk: { '/usr/bin/code': '', [RECORD]: text } }).deps)).toEqual(on)
  })

  it('a record of exactly the bound is read', () => {
    const text = record('1.2.3')
    const atBound = text + ' '.repeat(VSCODE_RECORD_MAX_BYTES - Buffer.byteLength(text))
    expect(vscodeStatus(computer({ disk: { ...MAC, [RECORD]: atBound } }).deps)).toEqual({ vscode: 'on', version: '1.2.3' })
  })

  const valid = record('1.2.3')
  it.each([
    ['no record', undefined],
    ['a record cut short', valid.slice(0, -3)],
    ['not an array', JSON.stringify({ identifier: { id: VSCODE_EXTENSION_ID }, version: '1.2.3' })],
    ['over the bound', valid + ' '.repeat(VSCODE_RECORD_MAX_BYTES + 1 - Buffer.byteLength(valid))],
    ['a version that is no version', JSON.stringify(['', 'v'.repeat(65), '1.2.3/../x', '1.2.3 beta', 123, null]
      .map((version) => ({ identifier: { id: VSCODE_EXTENSION_ID }, version })))],
    ['another extension only', JSON.stringify([null, 'text', 7, {}, { identifier: null }, { identifier: { id: 7 }, version: '1.2.3' },
      { identifier: { id: `${VSCODE_EXTENSION_ID}-other` }, version: '1.2.3' }])],
  ])('%s reads as off, and nothing throws', (_, text) => {
    const disk: Record<string, string> = { ...MAC }
    if (text !== undefined) disk[RECORD] = text
    expect(vscodeStatus(computer({ disk }).deps)).toEqual({ vscode: 'off' })
  })

  it('status runs nothing', () => {
    for (const disk of [{}, MAC, { ...MAC, [RECORD]: record('1.2.3') }]) {
      const c = computer({ disk })
      vscodeStatus(c.deps)
      expect(c.runs).toEqual([])
      expect(c.folders).toEqual([])
    }
  })
})

describe('vscodeEnable', () => {
  it('enable installs the packed file once, forced, in 60 s, and removes it', async () => {
    const c = computer({ disk: MAC })
    let seen: { mode: number; names: string[] } | undefined
    c.whenRun = (_, args) => {
      seen = { mode: statSync(args[1]).mode & 0o777, names: [...readZip(readFileSync(args[1])).keys()] }
      c.disk.set(RECORD, record('1.2.3'))
    }
    expect(await vscodeEnable(c.deps)).toEqual({ vscode: 'on', version: '1.2.3' })
    expect(c.folders).toHaveLength(1)
    expect(c.runs).toEqual([[CODE, ['--install-extension', join(c.folders[0], 'harness-device.vsix'), '--force'], 60_000]])
    expect(seen).toEqual({ mode: 0o600, names: ENTRIES })
    expect(existsSync(c.folders[0])).toBe(false)
  })

  it('on Linux it is the code found on PATH that installs', async () => {
    const c = computer({ platform: 'linux', pathVar: '/usr/local/bin:/usr/bin', disk: { '/usr/bin/code': '' } })
    c.whenRun = () => c.disk.set(RECORD, record('1.2.3'))
    expect(await vscodeEnable(c.deps)).toEqual({ vscode: 'on', version: '1.2.3' })
    expect(c.runs.map(([file]) => file)).toEqual(['/usr/bin/code'])
  })

  it('on Linux only PATH\'s absolute folders are looked in: a relative one is wherever Harness happens to run', async () => {
    const disk = { 'rel/bin/code': '', code: '', '/usr/bin/code': '' }
    const c = computer({ platform: 'linux', pathVar: 'rel/bin:.:/usr/bin', disk })
    c.whenRun = () => c.disk.set(RECORD, record('1.2.3'))
    expect(await vscodeEnable(c.deps)).toEqual({ vscode: 'on', version: '1.2.3' })
    expect(c.runs.map(([file]) => file)).toEqual(['/usr/bin/code'])
    expect(vscodeStatus(computer({ platform: 'linux', pathVar: 'rel/bin:.', disk }).deps)).toEqual({ vscode: 'absent' })
  })

  // Each starts on at an older version, so its answer shows a failure's `vscode` is off whatever was there before.
  const older = { ...MAC, [RECORD]: record('0.0.1') }
  it.each<[string, string, ComputerOptions, number]>([
    ['no VS Code', 'no-code', { disk: { [RECORD]: record('0.0.1') } }, 0],
    ['no CLI in the app', 'no-code', { disk: { [APP]: '', [RECORD]: record('0.0.1') } }, 0],
    ['a run past its time', 'timeout', { disk: older, answers: [{ code: null, timedOut: true }] }, 1],
    ['exit 1', 'failed', { disk: older, answers: [{ code: 1, timedOut: false }] }, 1],
    ['a code that could not start', 'failed', { disk: older, answers: [{ code: null, timedOut: false }] }, 1],
    ['no built extension', 'failed', { disk: older, files: null }, 0],
    ['a write that threw', 'failed', { disk: older, write: () => { throw new Error('ENOSPC') } }, 0],
    ['still off afterwards', 'failed', { disk: MAC }, 1],
  ])('enable with %s answers off and %s', async (_, error, options, runs) => {
    const c = computer(options)
    expect(await vscodeEnable(c.deps)).toEqual({ vscode: 'off', error })
    expect(c.runs).toHaveLength(runs)
    for (const folder of c.folders) expect(existsSync(folder)).toBe(false)
  })

  it('a failed install still removes the file', async () => {
    for (const answer of [{ code: 1, timedOut: false }, { code: null, timedOut: true }]) {
      const c = computer({ disk: MAC, answers: [answer] })
      let there = false
      c.whenRun = (_, args) => { there = existsSync(args[1]) }
      expect((await vscodeEnable(c.deps)).vscode).toBe('off')
      expect(there).toBe(true)
      expect(c.folders.map(existsSync)).toEqual([false])
    }
  })
})

describe('vscodeDisable', () => {
  it('disable uninstalls by id; off or absent runs nothing', async () => {
    const on = computer({ disk: { ...MAC, [RECORD]: record('1.2.3') } })
    on.whenRun = () => on.disk.set(RECORD, '[]')
    expect(await vscodeDisable(on.deps)).toEqual({ vscode: 'off' })
    expect(on.runs).toEqual([[CODE, ['--uninstall-extension', 'autonomous-ai.harness-device'], 60_000]])

    const off = computer({ disk: MAC })
    expect(await vscodeDisable(off.deps)).toEqual({ vscode: 'off' })
    const absent = computer({ disk: { [RECORD]: record('1.2.3') } })
    expect(await vscodeDisable(absent.deps)).toEqual({ vscode: 'absent' })
    expect([...off.runs, ...absent.runs]).toEqual([])
  })

  it.each<[string, string, ComputerOptions, number]>([
    ['exit 1', 'failed', { disk: { ...MAC, [RECORD]: record('1.2.3') }, answers: [{ code: 1, timedOut: false }] }, 1],
    ['a run past its time', 'timeout', { disk: { ...MAC, [RECORD]: record('1.2.3') }, answers: [{ code: null, timedOut: true }] }, 1],
    ['no CLI in the app', 'no-code', { disk: { [APP]: '', [RECORD]: record('1.2.3') } }, 0],
  ])('a disable that leaves it on, with %s, says %s', async (_, error, options, runs) => {
    const c = computer(options)
    expect(await vscodeDisable(c.deps)).toEqual({ vscode: 'on', version: '1.2.3', error })
    expect(c.runs).toHaveLength(runs)
  })
})

describe('packVsix', () => {
  it('the .vsix is the four entries, and its manifest names the id, the version and the engine', () => {
    const zip = readZip(packVsix(FILES))
    expect([...zip.keys()]).toEqual(ENTRIES)
    expect(zip.get('extension/package.json')!.equals(Buffer.from(FILES.manifest))).toBe(true)
    expect(zip.get('extension/extension.js')!.toString('utf8')).toBe(FILES.main)
    expect(zip.get('extension.vsixmanifest')!.toString('utf8')).toBe([
      '<?xml version="1.0" encoding="utf-8"?>',
      '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">',
      '  <Metadata>',
      '    <Identity Language="en-US" Id="harness-device" Version="1.2.3" Publisher="autonomous-ai"/>',
      '    <DisplayName>Harness Device</DisplayName>',
      '    <Description xml:space="preserve">The Harness dial reaches Claude Code and Codex in this window&apos;s terminals.</Description>',
      '    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.75.0"/></Properties>',
      '  </Metadata>',
      '  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>',
      '  <Dependencies/>',
      '  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>',
      '</PackageManifest>',
      '',
    ].join('\n'))
    expect(zip.get('[Content_Types].xml')!.toString('utf8')).toBe([
      '<?xml version="1.0" encoding="utf-8"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>',
      '',
    ].join('\n'))
  })

  it('a name that needs escaping is escaped in the XML', () => {
    const manifest = { ...JSON.parse(FILES.manifest), displayName: 'Harness "Device"', description: 'Taps & swipes <reach> agents' }
    const xml = readZip(packVsix({ ...FILES, manifest: JSON.stringify(manifest) })).get('extension.vsixmanifest')!.toString('utf8')
    expect(xml).toContain('<DisplayName>Harness &quot;Device&quot;</DisplayName>')
    expect(xml).toContain('<Description xml:space="preserve">Taps &amp; swipes &lt;reach&gt; agents</Description>')
  })

  it('buildVersion is the manifest\'s version; null with no built extension', () => {
    expect(buildVersion({ files: () => FILES })).toBe('1.2.3')
    expect(buildVersion({ files: () => null })).toBeNull()
  })
})

describe('the real dependencies, on the test\'s own files', () => {
  it('are this process\'s platform, home and PATH, with no built extension in a run from the sources', () => {
    const real = vscodeExtensionDeps()
    expect(real).toMatchObject({ platform: process.platform, home: homedir(), pathVar: process.env.PATH ?? '' })
    expect(real.files()).toBeNull()
    expect(buildVersion(real)).toBeNull()
  })

  it('the app\'s path, spaces and all, is the file run, never a shell\'s line', async () => {
    const bin = join(scratch, 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin')
    mkdirSync(bin, { recursive: true })
    const said = join(scratch, 'args')
    writeFileSync(join(bin, 'code'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${said}'\nexit 3\n`, { mode: 0o755 })
    const vsix = join(scratch, 'a b;$(touch x).vsix')
    expect(await vscodeExtensionDeps().run(join(bin, 'code'), ['--install-extension', vsix, '--force'], 30_000)).toEqual({ code: 3, timedOut: false })
    expect(readFileSync(said, 'utf8')).toBe(`--install-extension\n${vsix}\n--force\n`)
    expect(await vscodeExtensionDeps().run(join(scratch, 'none'), [], 30_000)).toEqual({ code: null, timedOut: false })
  })

  it('a run past its time is killed and says so', async () => {
    const code = join(scratch, 'code')
    writeFileSync(code, '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 })
    expect(await vscodeExtensionDeps().run(code, [], 300)).toEqual({ code: null, timedOut: true })
  })

  it('a run past its time ends what it started too, as VS Code\'s own script starts Electron and waits', async () => {
    const code = join(scratch, 'code')
    const pidFile = join(scratch, 'child.pid')
    writeFileSync(code, `sleep 60 &\necho $! > '${pidFile}'\nwait $!\nexit $?\n`)
    // The script through /bin/sh: macOS checks a new executable on its first run, which can take longer than the time.
    expect(await vscodeExtensionDeps().run('/bin/sh', [code], 300)).toEqual({ code: null, timedOut: true })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' })))
  })

  it('on Linux, PATH\'s `code` is a file this account may run: a folder or a file it may not run is passed over', async () => {
    const real = vscodeExtensionDeps()
    const [folder, plain, runnable] = ['a', 'b', 'c'].map((name) => join(scratch, name))
    mkdirSync(join(folder, 'code'), { recursive: true })
    mkdirSync(plain)
    writeFileSync(join(plain, 'code'), '', { mode: 0o644 })
    mkdirSync(runnable)
    writeFileSync(join(runnable, 'code'), '', { mode: 0o755 })
    const c = computer({ platform: 'linux', pathVar: [folder, plain, runnable].join(':') })
    c.whenRun = () => c.disk.set(RECORD, record('1.2.3'))
    expect(await vscodeEnable({ ...c.deps, exists: real.exists, executable: real.executable })).toEqual({ vscode: 'on', version: '1.2.3' })
    expect(c.runs.map(([file]) => file)).toEqual([join(runnable, 'code')])
  })

  it('the temporary folder and the file are this account\'s alone, and removing never throws', () => {
    const real = vscodeExtensionDeps()
    const folder = real.tempDir()
    expect(statSync(folder).mode & 0o777).toBe(0o700)
    const file = join(folder, 'harness-device.vsix')
    real.write(file, Buffer.from('zip'))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    real.remove(folder)
    expect(existsSync(folder)).toBe(false)
    expect(() => real.remove(folder)).not.toThrow()
  })

  it('the read gives a file within its bound, and null over it, missing, or not a file', () => {
    const { read } = vscodeExtensionDeps()
    const file = join(scratch, 'extensions.json')
    writeFileSync(file, '[1234]')
    expect(read(file, 6)).toBe('[1234]')
    expect(read(file, 5)).toBeNull()
    expect(read(join(scratch, 'none'), 6)).toBeNull()
    expect(read(scratch, 6)).toBeNull()
  })
})
