/**
 * The trust records that let Codex run Harness Device's plugin hooks without asking: written into a Codex home's
 * config.toml only for an installed folder whose fingerprint is the copy this CLI carries, and only the plugin's own
 * tables, in a file Codex, Harness's own hook review and the person write too. Each in a throwaway folder.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { filesContentHash, pluginContentHash, pluginTrustRecords, readConfigText, replaceConfigText, writePluginTrust } from './codexPluginTrust.js'

// A copy of the module, so a test can watch, or break, the file calls a write makes.
vi.mock('node:fs', async (original) => ({ ...await original<object>() }))

const onWindows = process.platform === 'win32'

/** A plugin tree, byte for byte: Codex's manifest, its hooks file with one hook per event, the hook and a README. */
const FIXTURE: Readonly<Record<string, string>> = {
  '.codex-plugin/plugin.json': '{"name":"harness-device","hooks":"./hooks/codex.json"}\n',
  'hooks/codex.json': '{"hooks":{"PermissionRequest":[{"matcher":"*","hooks":[{"type":"command","command":"fixture permission","onFailure":"continue","timeout":5}]}],"PreToolUse":[{"matcher":"request_user_input","hooks":[{"type":"command","command":"fixture question","onFailure":"continue","timeout":5}]}]}}\n',
  'hooks/codex-asked': '#!/bin/sh\nexit 0\n',
  'README.md': 'fixture\n',
}

// Printed by the spike's hashes.mjs (2026-11-26) for FIXTURE plus `__pycache__/x.pyc`; that script's values matched
// `codex app-server` `hooks/list` of codex-cli 0.172.0 exactly. The fingerprint hashes each entry's path with the
// platform's separator: `/` on macOS and Linux, `\` on Windows. The hooks' declaration hashes are the same everywhere.
const POSIX = 'sha256:5ed6c10e8c100df9d1eb4dbf5f45ad3ca00d51081931bb40538445ee64a32a05'
const WINDOWS = 'sha256:f79e1bc6746ed69553226de4909e79404417b3cc5f1e13edc3f394b97300ecf2'
const FINGERPRINT = process.platform === 'win32' ? WINDOWS : POSIX
const PERMISSION = 'sha256:617e7ac70aedcde8a745bdaa988454f2c32389d38f063bfa30d91619a5cdd359'
const QUESTION = 'sha256:6eb05987d4cd76c5a8db8417b05c315f7fd0e7ad5de4668803d7542134829c2d'
const PERMISSION_KEY = 'harness-device@openharness:hooks/codex.json:permission_request:0:0'
const QUESTION_KEY = 'harness-device@openharness:hooks/codex.json:pre_tool_use:0:0'

// Names whose order tells the walk apart: a folder `a` beside `a-b` (depth first, `a/c` comes before `a-b`, though `-`
// sorts before `/`), and a full-width tilde beside an emoji (UTF-8 bytes put the tilde first, UTF-16 the emoji). The
// same script's values for this tree.
const NAMES: Readonly<Record<string, string>> = { 'a-b': '1\n', 'a/c': '2\n', 'é.md': '3\n', '😀.md': '4\n', '～.md': '5\n' }
const NAMES_POSIX = 'sha256:4e7d3f7560a4485d5f8780f08083479eba658052890c451da93361d33982eb50'
const NAMES_WINDOWS = 'sha256:d52212edd7f47d45f1eade6f6ca9e7367b823ebea9182ab50615b7a4894c2505'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const temp = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-plugin-trust-')))
  roots.push(root)
  return root
}
const write = (root: string, files: Readonly<Record<string, string>>): string => {
  mkdirSync(root, { recursive: true })
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}
/** The fixture plugin as Codex installs it, with the bytecode the spike's tree held. */
const tree = (extra: Readonly<Record<string, string>> = {}): string => write(join(temp(), 'local'), { ...FIXTURE, '__pycache__/x.pyc': 'skipped\n', ...extra })
/** The fixture plugin with its hooks file replaced by [hooksFile], or removed (null). */
const handEdited = (hooksFile: string | null): string => {
  const folder = tree()
  if (hooksFile === null) rmSync(join(folder, 'hooks', 'codex.json'))
  else writeFileSync(join(folder, 'hooks', 'codex.json'), hooksFile)
  return folder
}
const codexHome = (config?: string | Buffer): string => {
  const home = temp()
  if (config !== undefined) writeFileSync(join(home, 'config.toml'), config)
  return home
}
const configOf = (home: string): string => readFileSync(join(home, 'config.toml'), 'utf8')
const header = (key: string): string => `[hooks.state.${JSON.stringify(key)}]`
const OURS = {
  [PERMISSION_KEY]: { trusted_hash: PERMISSION, trusted_content_hash: FINGERPRINT },
  [QUESTION_KEY]: { trusted_hash: QUESTION, trusted_content_hash: FINGERPRINT },
}

describe("the plugin's bundle fingerprint", () => {
  it("is Codex's", () => {
    expect(pluginContentHash(tree())).toBe(FINGERPRINT)
  })

  it("of the files in memory is the folder's, for each platform on any host", () => {
    expect(filesContentHash(FIXTURE, 'darwin')).toBe(POSIX)
    expect(filesContentHash(FIXTURE, 'linux')).toBe(POSIX)
    expect(filesContentHash(FIXTURE, 'win32')).toBe(WINDOWS)
  })

  it("walks depth first, each folder's names in UTF-8 byte order, on disk as in memory", () => {
    expect(pluginContentHash(write(temp(), NAMES))).toBe(process.platform === 'win32' ? NAMES_WINDOWS : NAMES_POSIX)
    expect(filesContentHash(NAMES, 'linux')).toBe(NAMES_POSIX)
    expect(filesContentHash(NAMES, 'win32')).toBe(NAMES_WINDOWS)
  })

  it('skips __pycache__, .venv, *.pyc and *.egg-info, and changes with any other byte', () => {
    const skipped = { '__pycache__/y.pyc': 'y\n', '.venv/z': 'z\n', 'hooks/stale.pyc': 's\n', 'harness_device.egg-info/PKG-INFO': 'p\n' }
    expect(pluginContentHash(tree(skipped))).toBe(FINGERPRINT)
    expect(filesContentHash({ ...FIXTURE, ...skipped }, 'linux')).toBe(POSIX)
    expect(pluginContentHash(tree({ 'README.md': 'fixturE\n' }))).not.toBe(FINGERPRINT)
    expect(filesContentHash({ ...FIXTURE, 'README.md': 'fixturE\n' }, 'linux')).not.toBe(POSIX)
  })

  it.skipIf(onWindows)('refuses a link or a FIFO in the tree, and a root that is a link', () => {
    const linked = tree()
    symlinkSync(join(linked, 'README.md'), join(linked, 'hooks', 'link'))
    expect(() => pluginContentHash(linked)).toThrow()
    const fifo = tree()
    execFileSync('mkfifo', [join(fifo, 'hooks', 'pipe')])
    expect(() => pluginContentHash(fifo)).toThrow()
    const root = join(temp(), 'root')
    symlinkSync(tree(), root)
    expect(() => pluginContentHash(root)).toThrow()
  })

  it('refuses a tree past 1,000 entries, the root among them, or past 8 MiB of files', () => {
    const many = write(temp(), Object.fromEntries(Array.from({ length: 999 }, (_, i) => [`f${i}`, ''])))
    expect(pluginContentHash(many)).toMatch(/^sha256:[0-9a-f]{64}$/)
    writeFileSync(join(many, 'f999'), '')
    expect(() => pluginContentHash(many)).toThrow()
    const big = write(temp(), { large: 'x'.repeat(8 * 1024 * 1024) })
    expect(pluginContentHash(big)).toMatch(/^sha256:[0-9a-f]{64}$/)
    writeFileSync(join(big, 'more'), 'x')
    expect(() => pluginContentHash(big)).toThrow()
  })
})

describe("the plugin's trust records", () => {
  it("are Codex's, read from the tree's own hooks file", () => {
    expect(pluginTrustRecords(tree())).toStrictEqual([
      { key: PERMISSION_KEY, trustedHash: PERMISSION, contentHash: FINGERPRINT },
      { key: QUESTION_KEY, trustedHash: QUESTION, contentHash: FINGERPRINT },
    ])
  })

  it("hash a matcher where Codex does: SessionStart and PostToolUse too, as PermissionRequest and PreToolUse, never Stop's", () => {
    const hooksFile = JSON.stringify({ hooks: {
      SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: 'fixture start', timeout: 5 }] }],
      PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'fixture after', timeout: 5 }] }],
      Stop: [{ matcher: 'ignored', hooks: [{ type: 'command', command: 'fixture stop', timeout: 5 }] }],
    } })
    const folder = handEdited(hooksFile)
    // Codex's identity of each hook hashed by Python (sorted keys, compact JSON, sha256), with the matcher only for the
    // events codex-rs `matcher_pattern_for_event` keeps one for (hooks/src/events/common.rs, 0.172.0).
    expect(pluginTrustRecords(folder).map(({ key, trustedHash }) => [key.split(':').slice(2).join(':'), trustedHash])).toStrictEqual([
      ['session_start:0:0', 'sha256:018d7918a1b18b5396763220c034f5a18bb6f43a2af8c44c791108d4b477c2a8'],
      ['stop:0:0', 'sha256:f0a5037f5c103124b923a3908564612f2f006fb26f54e3102e304fbe57d3d4d1'],
      ['post_tool_use:0:0', 'sha256:b938a9471c973339ca748a29f112df3a8fa6ccc1c7d2155b6823164c52c46bdd'],
    ])
  })
})

describe('readConfigText', () => {
  it('reads the text through a link and without a BOM, and gives null when there is no file', () => {
    const home = codexHome(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('model = "gpt-5"\n')]))
    expect(readConfigText(join(home, 'config.toml'))).toBe('model = "gpt-5"\n')
    expect(readConfigText(join(home, 'none.toml'))).toBeNull()
    const exact = codexHome('#'.repeat(1024 * 1024))
    expect(readConfigText(join(exact, 'config.toml'))).toHaveLength(1024 * 1024)
    if (onWindows) return
    const linked = codexHome()
    symlinkSync(join(home, 'config.toml'), join(linked, 'config.toml'))
    expect(readConfigText(join(linked, 'config.toml'))).toBe('model = "gpt-5"\n')
  })

  it('throws for a folder, a file past 1 MiB, bytes that are not UTF-8, and at once for a FIFO', () => {
    const home = codexHome()
    mkdirSync(join(home, 'folder.toml'))
    expect(() => readConfigText(join(home, 'folder.toml'))).toThrow()
    writeFileSync(join(home, 'big.toml'), '#'.repeat(1024 * 1024 + 1))
    expect(() => readConfigText(join(home, 'big.toml'))).toThrow()
    writeFileSync(join(home, 'latin1.toml'), Buffer.from([0x23, 0xe9, 0x0a]))
    expect(() => readConfigText(join(home, 'latin1.toml'))).toThrow()
    if (onWindows) return
    execFileSync('mkfifo', [join(home, 'fifo.toml')])
    expect(() => readConfigText(join(home, 'fifo.toml'))).toThrow()
  })
})

describe('writePluginTrust', () => {
  it('writes both records into a home whose folder is the expected one', () => {
    const home = codexHome('model = "gpt-5"\n')
    expect(writePluginTrust(home, tree(), FINGERPRINT)).toStrictEqual({ ok: true, changed: true })
    expect(parseToml(configOf(home))).toEqual({ model: 'gpt-5', hooks: { state: OURS } })
  })

  it('never trusts a folder that differs from the expected fingerprint, and leaves trust already written as it was', () => {
    const home = codexHome('model = "gpt-5"\n')
    const installed = tree()
    expect(writePluginTrust(home, installed, FINGERPRINT)).toStrictEqual({ ok: true, changed: true })
    const before = configOf(home)
    // One byte changed by hand after trust was written; a GitHub `main`, which holds its tests; a hooks file emptied,
    // removed or broken by hand, which declares nothing to trust and must not read as trusted, nor as a broken plugin.
    writeFileSync(join(installed, 'README.md'), 'fixturE\n')
    for (const folder of [installed, tree({ 'test/plugin.spec.mjs': 'test\n' }), handEdited('{"hooks":{}}\n'), handEdited(null), handEdited('{"hooks":')]) {
      const io = { read: vi.fn(readConfigText), replace: vi.fn(replaceConfigText) }
      expect(writePluginTrust(home, folder, FINGERPRINT, io)).toStrictEqual({ ok: false, kind: 'differs' })
      expect(io.read).not.toHaveBeenCalled()
      expect(io.replace).not.toHaveBeenCalled()
      expect(configOf(home)).toBe(before)
    }
  })

  it("changes only the plugin's tables", () => {
    const native = '/home/person/.codex/hooks.json:stop:0:0'
    const config = [
      '# my settings',
      'model = "gpt-5"  # the newest',
      '',
      '[projects."/home/person/repo"]',
      'trust_level = "trusted"',
      '',
      "# Harness's own hooks, reviewed",
      header(native),
      'trusted_hash = "sha256:51ccf08c5abb298e3640ad1aa2a6d97a1e4c9aa50bf54769012a5f48e9819103"',
      '',
    ].join('\n')
    const home = codexHome(config)
    expect(writePluginTrust(home, tree(), FINGERPRINT)).toStrictEqual({ ok: true, changed: true })
    const after = configOf(home)
    expect(after.startsWith(config.trimEnd())).toBe(true)
    for (const key of [PERMISSION_KEY, QUESTION_KEY]) expect(after.split(header(key))).toHaveLength(2)
    expect(parseToml(after)).toEqual({
      model: 'gpt-5',
      projects: { '/home/person/repo': { trust_level: 'trusted' } },
      hooks: { state: { [native]: { trusted_hash: 'sha256:51ccf08c5abb298e3640ad1aa2a6d97a1e4c9aa50bf54769012a5f48e9819103' }, ...OURS } },
    })
  })

  it('replaces the records in place after an update, and leaves the file untouched when they are current', () => {
    const old = [
      'model = "gpt-5"',
      '',
      header(PERMISSION_KEY),
      'trusted_hash = "sha256:old-permission"',
      'trusted_content_hash = "sha256:old-content"',
      '',
      header(QUESTION_KEY),
      'trusted_hash = "sha256:old-question"',
      'trusted_content_hash = "sha256:old-content"',
      '',
      '[projects."/home/person/repo"]',
      'trust_level = "trusted"',
      '',
    ].join('\n')
    const home = codexHome(old)
    expect(writePluginTrust(home, tree(), FINGERPRINT)).toStrictEqual({ ok: true, changed: true })
    expect(configOf(home)).toBe(old.replace('sha256:old-permission', PERMISSION).replace('sha256:old-question', QUESTION)
      .replaceAll('sha256:old-content', FINGERPRINT))
    const file = join(home, 'config.toml'), then = new Date('2026-01-01T00:00:00Z')
    utimesSync(file, then, then)
    expect(writePluginTrust(home, tree(), FINGERPRINT)).toStrictEqual({ ok: true, changed: false })
    expect(statSync(file).mtimeMs).toBe(then.getTime())
  })

  it('writes again a declaration hash another writer changed, though the fingerprint is current', () => {
    const records = (permission: string): string => [
      header(PERMISSION_KEY), `trusted_hash = ${JSON.stringify(permission)}`, `trusted_content_hash = ${JSON.stringify(FINGERPRINT)}`, '',
      header(QUESTION_KEY), `trusted_hash = ${JSON.stringify(QUESTION)}`, `trusted_content_hash = ${JSON.stringify(FINGERPRINT)}`, '',
    ].join('\n')
    const home = codexHome(records('sha256:other'))
    expect(writePluginTrust(home, tree(), FINGERPRINT)).toStrictEqual({ ok: true, changed: true })
    expect(configOf(home)).toBe(records(PERMISSION))
  })

  it("keeps the person's enabled = false in our table", () => {
    const home = codexHome(`${header(PERMISSION_KEY)}\nenabled = false\ntrusted_hash = "sha256:old"\n`)
    expect(writePluginTrust(home, tree(), FINGERPRINT)).toStrictEqual({ ok: true, changed: true })
    expect(parseToml(configOf(home))).toEqual({ hooks: { state: { ...OURS, [PERMISSION_KEY]: { enabled: false, ...OURS[PERMISSION_KEY] } } } })
  })

  it.skipIf(onWindows)('writes a linked config.toml at its target, and it stays a link', () => {
    const dotfiles = temp(), home = codexHome()
    writeFileSync(join(dotfiles, 'config.toml'), 'model = "gpt-5"\n')
    symlinkSync(join(dotfiles, 'config.toml'), join(home, 'config.toml'))
    expect(writePluginTrust(home, tree(), FINGERPRINT)).toStrictEqual({ ok: true, changed: true })
    expect(lstatSync(join(home, 'config.toml')).isSymbolicLink()).toBe(true)
    expect(parseToml(readFileSync(join(dotfiles, 'config.toml'), 'utf8'))).toEqual({ model: 'gpt-5', hooks: { state: OURS } })
  })

  it("reads a file changed mid-way again and redoes it, and the other writer's change survives", () => {
    const home = codexHome('# mine\n'), file = join(home, 'config.toml')
    let reads = 0
    // Another writer changes the file just after the first read.
    const read = (path: string): string | null => {
      const text = readConfigText(path)
      if (++reads === 1) writeFileSync(file, `model = "other"\n${text}`)
      return text
    }
    expect(writePluginTrust(home, tree(), FINGERPRINT, { read, replace: replaceConfigText })).toStrictEqual({ ok: true, changed: true })
    expect(reads).toBe(4)
    expect(configOf(home).startsWith('model = "other"\n# mine\n')).toBe(true)
    expect(parseToml(configOf(home))).toEqual({ model: 'other', hooks: { state: OURS } })
  })

  it('checks config.toml right before the rename: a change another writer makes while the new text is written survives', () => {
    const home = codexHome('# mine\n'), file = join(home, 'config.toml'), installed = tree()
    const write = fs.writeFileSync
    // Another writer changes the file while this one writes its new text beside it.
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((...args) => {
      write(file, `model = "other"\n${readFileSync(file, 'utf8')}`)
      write(...args)
    })
    expect(writePluginTrust(home, installed, FINGERPRINT)).toStrictEqual({ ok: true, changed: true })
    expect(configOf(home).startsWith('model = "other"\n# mine\n')).toBe(true)
    expect(parseToml(configOf(home))).toEqual({ model: 'other', hooks: { state: OURS } })
    expect(readdirSync(home)).toEqual(['config.toml'])
  })

  it.each(['fsyncSync', 'renameSync'] as const)('a write stopped at its %s leaves config.toml byte for byte, and no file beside it', (call) => {
    const config = '# mine\nmodel = "gpt-5"\n'
    const home = codexHome(config)
    vi.spyOn(fs, call).mockImplementationOnce(() => {
      throw Object.assign(new Error('EIO: fixture'), { code: 'EIO' })
    })
    expect(writePluginTrust(home, tree(), FINGERPRINT)).toStrictEqual({ ok: false, kind: 'write' })
    expect(readFileSync(join(home, 'config.toml'))).toStrictEqual(Buffer.from(config))
    expect(readdirSync(home)).toEqual(['config.toml'])
  })

  it('flushes the new text before the rename, and its folder after it where a folder can be flushed', () => {
    const home = codexHome('model = "gpt-5"\n')
    const calls: string[] = []
    const flush = fs.fsyncSync, rename = fs.renameSync
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      calls.push('flush')
      flush(fd)
    })
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      calls.push('rename')
      rename(from, to)
    })
    expect(writePluginTrust(home, tree(), FINGERPRINT)).toStrictEqual({ ok: true, changed: true })
    // Windows cannot flush a folder; NTFS journals the rename.
    expect(calls).toEqual(onWindows ? ['flush', 'rename'] : ['flush', 'rename', 'flush'])
  })

  it.skipIf(onWindows)("keeps config.toml's own mode", () => {
    const home = codexHome('model = "gpt-5"\n')
    chmodSync(join(home, 'config.toml'), 0o640)
    expect(writePluginTrust(home, tree(), FINGERPRINT)).toStrictEqual({ ok: true, changed: true })
    expect(statSync(join(home, 'config.toml')).mode & 0o777).toBe(0o640)
  })

  it.skipIf(!onWindows)('tries a rename onto a config.toml another program holds open again', () => {
    const home = codexHome('model = "gpt-5"\n')
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EPERM: fixture'), { code: 'EPERM' })
    })
    expect(writePluginTrust(home, tree(), FINGERPRINT)).toStrictEqual({ ok: true, changed: true })
    expect(parseToml(configOf(home))).toEqual({ model: 'gpt-5', hooks: { state: OURS } })
    expect(readdirSync(home)).toEqual(['config.toml'])
  })

  it('gives up after 3 attempts on a file changed at every one, writing nothing', () => {
    const home = codexHome('# mine\n')
    let version = 0
    const io = { read: vi.fn(() => `# version ${++version}\n`), replace: vi.fn() }
    expect(writePluginTrust(home, tree(), FINGERPRINT, io)).toStrictEqual({ ok: false, kind: 'changed' })
    expect(io.read).toHaveBeenCalledTimes(6)
    expect(io.replace).not.toHaveBeenCalled()
    expect(configOf(home)).toBe('# mine\n')
  })

  it('says each failure by its kind and leaves the file as it was', () => {
    const cases: Array<[string, string | Buffer]> = [
      ['unparsed', 'model = \n'],
      ['unsafe', '[hooks]\nstate = { }\n'],
      // A field of ours that is itself a table: the field written beside it would not parse.
      ['unsafe', `${header(PERMISSION_KEY)}\ntrusted_content_hash.old = "x"\n`],
      ['unreadable', '#'.repeat(1024 * 1024 + 1)],
      ['unreadable', Buffer.from([0x23, 0xe9, 0x0a])],
    ]
    for (const [kind, config] of cases) {
      const home = codexHome(config)
      expect(writePluginTrust(home, tree(), FINGERPRINT), kind).toStrictEqual({ ok: false, kind })
      expect(readFileSync(join(home, 'config.toml'))).toStrictEqual(Buffer.from(config))
    }
    const none = codexHome()
    expect(writePluginTrust(none, tree(), FINGERPRINT)).toStrictEqual({ ok: false, kind: 'missing' })
    expect(existsSync(join(none, 'config.toml'))).toBe(false)
    const home = codexHome('model = "gpt-5"\n')
    const failing = { read: readConfigText, replace: () => { throw new Error('denied') } }
    expect(writePluginTrust(home, tree(), FINGERPRINT, failing)).toStrictEqual({ ok: false, kind: 'write' })
    // A plugin whose hooks file is gone, is not JSON or declares no hook: the folder is the expected one, but holds
    // nothing to trust.
    for (const hooksFile of [null, '{"hooks":', '{"hooks":{}}\n']) {
      const folder = handEdited(hooksFile)
      expect(writePluginTrust(home, folder, pluginContentHash(folder)), String(hooksFile)).toStrictEqual({ ok: false, kind: 'plugin' })
    }
    expect(configOf(home)).toBe('model = "gpt-5"\n')
  })
})
