/**
 * What the core's start writes into the eleven other engines' settings and plugin files, byte for byte, in every
 * state those files are found in: recorded from main before their installers (lib/hooks.ts) left the core's
 * static imports (docs/design/2026-10-08-other-engines-out-of-core.md, (o2)). Each case installs twice through the
 * core's own entry, `installEngineHooks(port, { only })`, and keeps what each run logged and threw, and every
 * file left behind: its bytes, its mode, a symlink kept or replaced, a temporary file left over. These files
 * belong to a person's engines, which is why a change in any of it matters.
 *
 * Nothing of the host is in it. Every folder an installer reads or writes is under a throwaway root, named
 * through the environment and the notify script's path, both replaced by tokens; the umask is pinned, the
 * platform pinned to Linux (CI's), OpenCode's version answered by a script of the test's own, and Hermes has at
 * most one profile, since the order a folder lists in is the file system's.
 *
 * `RECORD_OTHER_ENGINES_GOLDEN=1` writes the fixture. Record it again only for a change meant to alter what lands
 * in one of these engines' files, and say so in that change.
 */
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const GOLDEN = fileURLToPath(new URL('./__fixtures__/other-hooks.golden.json', import.meta.url))
const RECORD = process.env.RECORD_OTHER_ENGINES_GOLDEN === '1'
const PORT = 19473
const OTHER_PORT = 19474
/** Permission cases mean nothing to root, which may write anywhere. */
const ROOT_USER = process.getuid?.() === 0

const VENDORS = ['cursor', 'opencode', 'kilo', 'pi', 'amp', 'hermes', 'devin', 'commandcode', 'grok', 'agy', 'copilot'] as const
type Vendor = (typeof VENDORS)[number]
/** How each vendor's file is written: settings that are JSON, YAML, or a plugin's source. */
const KIND: Record<Vendor, 'json' | 'yaml' | 'source'> = {
  cursor: 'json', opencode: 'source', kilo: 'source', pi: 'source', amp: 'source', hermes: 'yaml',
  devin: 'json', commandcode: 'json', grok: 'json', agy: 'json', copilot: 'json',
}

let root = ''
/** The file each vendor's installer owns, as the environment below places it. */
const targets = (): Record<Vendor, string> => {
  const home = join(root, 'home'), config = join(home, '.config')
  return {
    cursor: join(config, 'cursor', 'hooks.json'),
    opencode: join(config, 'opencode', 'plugins', 'launcher-register', 'tui.js'),
    kilo: join(config, 'kilo', 'plugin', 'launcher-register.js'),
    pi: join(home, '.pi', 'agent', 'extensions', 'launcher-register.ts'),
    amp: join(config, 'amp', 'plugins', 'launcher-register.ts'),
    hermes: join(home, '.hermes', 'config.yaml'),
    devin: join(config, 'devin', 'config.json'),
    commandcode: join(home, '.commandcode', 'settings.json'),
    grok: join(home, '.grok', 'hooks', 'harness.json'),
    agy: join(home, '.gemini', 'config', 'hooks.json'),
    copilot: join(home, '.copilot', 'hooks', 'harness.json'),
  }
}
/** OpenCode 1's plugin, which an OpenCode 2 install removes when it is ours. */
const opencodeLegacy = (): string => join(root, 'home', '.config', 'opencode', 'plugin', 'launcher-register.js')

/** A person's own content in the file, in the vendor's shape. */
const FOREIGN: Record<Vendor, string> = {
  cursor: pretty({ version: 1, note: 'café ✓', hooks: { sessionStart: [{ command: 'foreign-start' }], afterFileEdit: [{ command: 'foreign-edit' }] } }),
  devin: pretty({ devin: { org_id: 'org-1' }, theme_mode: 'dark', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'foreign-start' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'foreign-tool' }] }] } }),
  commandcode: pretty({ model: 'x', hooks: { SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: 'foreign-start', timeout: 9 }] }], PostToolUse: [{ hooks: [{ type: 'command', command: 'foreign-post' }] }] } }),
  grok: pretty({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'foreign-start' }] }], Stop: [{ hooks: [{ type: 'command', command: 'foreign-stop' }] }] } }),
  agy: pretty({ theirs: { enabled: true, Stop: [{ type: 'command', command: 'foreign-stop' }] } }),
  copilot: pretty({ version: 1, hooks: { sessionStart: [{ type: 'command', command: 'foreign-start' }] } }),
  hermes: 'model: anthropic/claude\ntoolsets:\n  - web\n  - terminal\n',
  opencode: '// someone else\'s plugin\nexport default {}\n',
  kilo: '// someone else\'s plugin\nexport default {}\n',
  pi: '// someone else\'s extension\nexport default function () {}\n',
  amp: '// someone else\'s plugin\nexport default function () {}\n',
}
function pretty(value: unknown): string { return JSON.stringify(value, null, 2) + '\n' }

interface Texts { current: string; otherPort: string; old: string }
interface Target { vendor: Vendor; file: string; home: string; elsewhere: string; texts: Texts }
interface Case { name: string; setup?: (target: Target) => void; noHome?: boolean; permissions?: boolean; vendors?: readonly Vendor[]; opencode?: 1 | 2 | null }

const write = (file: string, text: string, mode?: number): void => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  if (mode !== undefined) chmodSync(file, mode)
}
const minify = (text: string): string => { try { return JSON.stringify(JSON.parse(text)) } catch { return text.trim() } }

const CASES: Case[] = [
  { name: 'no file' },
  { name: 'no home folder', noHome: true },
  { name: 'empty file', setup: ({ file }) => write(file, '') },
  { name: 'whitespace only', setup: ({ file }) => write(file, '  \n') },
  { name: 'malformed JSON', setup: ({ file }) => write(file, '{not-json') },
  { name: 'byte order mark', setup: ({ file }) => write(file, '﻿{}') },
  { name: 'JSON null', setup: ({ file }) => write(file, 'null') },
  { name: 'JSON array', setup: ({ file }) => write(file, '[]') },
  { name: 'JSON string', setup: ({ file }) => write(file, '"text"') },
  { name: 'JSON number', setup: ({ file }) => write(file, '42') },
  { name: 'hooks is a string', setup: ({ file }) => write(file, '{"hooks":"nope","keep":1}') },
  { name: 'hooks is an array', setup: ({ file }) => write(file, '{"hooks":[]}') },
  { name: 'hooks is null', setup: ({ file }) => write(file, '{"hooks":null}') },
  { name: 'foreign content', setup: ({ file, vendor }) => write(file, FOREIGN[vendor]) },
  { name: 'ours from an older install', setup: ({ file, texts }) => write(file, texts.old) },
  { name: 'ours current', setup: ({ file, texts }) => write(file, texts.current) },
  { name: 'ours current, minified', setup: ({ file, texts }) => write(file, minify(texts.current)) },
  { name: 'ours current for another port', setup: ({ file, texts }) => write(file, texts.otherPort) },
  {
    name: 'a symlink to foreign content', setup: ({ file, vendor, elsewhere }) => {
      write(join(elsewhere, 'real'), FOREIGN[vendor])
      mkdirSync(dirname(file), { recursive: true })
      symlinkSync(join(elsewhere, 'real'), file)
    },
  },
  {
    name: 'a symlink to current content', setup: ({ file, texts, elsewhere }) => {
      write(join(elsewhere, 'real'), texts.current)
      mkdirSync(dirname(file), { recursive: true })
      symlinkSync(join(elsewhere, 'real'), file)
    },
  },
  {
    name: 'a dangling symlink', setup: ({ file, elsewhere }) => {
      mkdirSync(elsewhere, { recursive: true })
      mkdirSync(dirname(file), { recursive: true })
      symlinkSync(join(elsewhere, 'missing'), file)
    },
  },
  {
    name: 'a symlink into a missing folder', setup: ({ file, elsewhere }) => {
      mkdirSync(dirname(file), { recursive: true })
      symlinkSync(join(elsewhere, 'gone', 'missing'), file)
    },
  },
  { name: 'a read-only file', permissions: true, setup: ({ file, vendor }) => write(file, FOREIGN[vendor], 0o444) },
  { name: 'a read-only file, current', permissions: true, setup: ({ file, texts }) => write(file, texts.current, 0o444) },
  { name: 'an unreadable file', permissions: true, setup: ({ file, vendor }) => write(file, FOREIGN[vendor], 0o200) },
  { name: 'a read-only folder', permissions: true, setup: ({ home }) => chmodSync(home, 0o555) },
  {
    name: 'a read-only folder holding a writable file', permissions: true, setup: ({ file, vendor, home }) => {
      write(file, FOREIGN[vendor])
      chmodSync(home, 0o555)
    },
  },
  { name: 'a private file', setup: ({ file, vendor }) => write(file, FOREIGN[vendor], 0o600) },
  { name: 'the file is a folder', setup: ({ file }) => mkdirSync(file, { recursive: true }) },
  {
    name: 'a temporary file left by this process', setup: ({ file, vendor }) => {
      write(file, FOREIGN[vendor])
      write(`${file}.${process.pid}.tmp`, 'junk', 0o600)
    },
  },
  // Hermes: a `hooks:` mapping of the person's own is left alone; a profile is hooked with its own home.
  {
    name: 'a foreign hooks mapping', vendors: ['hermes'],
    setup: ({ file }) => write(file, 'model: x\nhooks:\n  on_session_start:\n    - command: "foreign-hook"\n'),
  },
  {
    name: 'our block twice, the first old', vendors: ['hermes'],
    setup: ({ file, texts }) => write(file, `${texts.old}${texts.current.replace(/^[\s\S]*?(\n# machine-adapter: session discovery)/, '$1')}`),
  },
  {
    name: 'a profile with a config', vendors: ['hermes'],
    setup: ({ file, home }) => {
      write(file, 'model: x\n')
      write(join(home, 'profiles', 'work', 'config.yaml'), 'model: y\n')
      mkdirSync(join(home, 'profiles', 'empty'), { recursive: true })
    },
  },
  // OpenCode: which plugin depends on the installed generation, read from the binary.
  { name: 'OpenCode 1', vendors: ['opencode'], opencode: 1 },
  { name: 'OpenCode 1, ours current', vendors: ['opencode'], opencode: 1, setup: ({ file, texts }) => write(file, texts.current) },
  { name: 'no OpenCode installed', vendors: ['opencode'], opencode: null },
  {
    name: 'OpenCode 2 with our OpenCode 1 plugin left', vendors: ['opencode'],
    setup: () => write(opencodeLegacy(), legacyOpencodePlugin),
  },
  {
    name: 'OpenCode 2 with a foreign plugin where OpenCode 1\'s goes', vendors: ['opencode'],
    setup: () => write(opencodeLegacy(), FOREIGN.opencode),
  },
  {
    name: 'OpenCode 2 with a folder where OpenCode 1\'s plugin goes', vendors: ['opencode'],
    setup: () => mkdirSync(opencodeLegacy(), { recursive: true }),
  },
]

interface Run { logs: string[]; threw: string | null }
interface Entry { type: 'dir' | 'file' | 'link'; mode?: string; text?: string; target?: string }
interface Outcome { runs: Run[]; files: Record<string, Entry> }
interface Golden { texts: Record<string, string>; outcomes: Record<string, Outcome> }

const saved: Record<string, string | undefined> = {}
let installEngineHooks: (port: number, options: { only: ReadonlySet<string>; environment: NodeJS.ProcessEnv }) => unknown
let tokens: Array<[string, string]> = []
let legacyOpencodePlugin = ''
const texts = {} as Record<Vendor, Texts>
const golden: Golden = RECORD ? { texts: {}, outcomes: {} } : JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden
const recorded: Golden = { texts: {}, outcomes: {} }

const normalize = (text: string): string => tokens.reduce((out, [value, token]) => out.split(value).join(token), text)
const describeError = (error: unknown): string => {
  if (!(error instanceof Error)) return `thrown ${typeof error}`
  const { code, syscall, path, dest } = error as NodeJS.ErrnoException & { dest?: string }
  return [error.name, code, syscall, path && normalize(path), dest && normalize(dest)].filter(Boolean).join(' ')
}
/** A file's text, kept once in the golden however many cases leave it. */
const textRef = (text: string): string => {
  const key = createHash('sha256').update(text).digest('hex').slice(0, 16)
  recorded.texts[key] = text
  return key
}

/** Everything under the case's folders: what a person would find in their engines' homes afterwards. */
function snapshot(): Record<string, Entry> {
  const files: Record<string, Entry> = {}
  const walk = (dir: string): void => {
    let names: string[]
    try { names = readdirSync(dir).sort() } catch { return }
    for (const name of names) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      const key = normalize(relative(root, path))
      if (stat.isSymbolicLink()) files[key] = { type: 'link', target: normalize(readlinkSync(path)) }
      else if (stat.isDirectory()) {
        files[key] = { type: 'dir', mode: (stat.mode & 0o777).toString(8) }
        walk(path)
      } else {
        const mode = stat.mode & 0o777
        // A file the person cannot read is still compared: read it for the record, then put its mode back.
        if (!(mode & 0o400)) chmodSync(path, mode | 0o400)
        const text = normalize(readFileSync(path, 'utf8'))
        if (!(mode & 0o400)) chmodSync(path, mode)
        files[key] = { type: 'file', mode: mode.toString(8), text: textRef(text) }
      }
    }
  }
  for (const top of ['home', 'elsewhere', join('data', 'amp-sessions')]) walk(join(root, top))
  return files
}

/** Give back write access everywhere, so that the next case starts from nothing. */
function reset(): void {
  const open = (path: string): void => {
    let stat
    try { stat = lstatSync(path) } catch { return }
    if (stat.isSymbolicLink()) return
    chmodSync(path, stat.isDirectory() ? 0o755 : 0o644)
    if (stat.isDirectory()) for (const name of readdirSync(path)) open(join(path, name))
  }
  for (const top of ['home', 'elsewhere', join('data', 'amp-sessions')]) {
    open(join(root, top))
    rmSync(join(root, top), { recursive: true, force: true })
  }
  mkdirSync(join(root, 'home'), { recursive: true })
}

/** The OpenCode the installer asks for its version: the test's own script, answering as `major` would. */
function opencode(major: 1 | 2 | null): void {
  const bin = join(root, 'bin', 'opencode')
  rmSync(bin, { force: true })
  if (major === null) return
  write(bin, `#!/bin/sh\necho "${major === 1 ? '1.18.31' : 'opencode v2.0.18'}"\n`, 0o755)
}

async function install(vendor: Vendor, port: number): Promise<Run> {
  const logs: string[] = []
  const capture = (level: string) => (...args: unknown[]) => {
    logs.push(`${level} ${args.map((arg) => typeof arg === 'string' ? normalize(arg) : describeError(arg)).join(' ')}`)
  }
  const spies = [vi.spyOn(console, 'log').mockImplementation(capture('log')), vi.spyOn(console, 'error').mockImplementation(capture('error')),
    vi.spyOn(console, 'warn').mockImplementation(capture('warn'))]
  let threw: string | null = null
  try { await installEngineHooks(port, { only: new Set([vendor]), environment: {} }) }
  catch (error) { threw = describeError(error) } finally { for (const spy of spies) spy.mockRestore() }
  return { logs, threw }
}

async function run(vendor: Vendor, scenario: Case): Promise<Outcome> {
  reset()
  opencode(scenario.opencode === undefined ? 2 : scenario.opencode)
  const file = targets()[vendor]
  const home = dirname(file)
  if (!scenario.noHome) mkdirSync(home, { recursive: true })
  scenario.setup?.({ vendor, file, home, elsewhere: join(root, 'elsewhere'), texts: texts[vendor] })
  const runs: Run[] = []
  for (let i = 0; i < 2; i++) runs.push(await install(vendor, PORT))
  return { runs, files: snapshot() }
}

/** What an install writes into a clean home for `port`: the current file, read raw. */
async function installed(vendor: Vendor, port: number, major: 1 | 2 = 2): Promise<string> {
  reset()
  opencode(major)
  const file = vendor === 'opencode' && major === 1 ? opencodeLegacy() : targets()[vendor]
  if (vendor === 'hermes') write(file, 'model: x\n')
  await install(vendor, port)
  return readFileSync(file, 'utf8')
}

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeAll(async () => {
  // A path the installers print may be the resolved one: macOS's temporary folder is a symlink.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'other-hooks-golden-')))
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  const home = join(root, 'home')
  const env: Record<string, string | undefined> = {
    HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
    ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_RUNTIME_DIR: join(root, 'runtime'), CODEX_HOME: join(home, '.codex'),
    OPENCODE_PATH: join(root, 'bin', 'opencode'),
  }
  // Every home an engine may be told of by the environment this runs in, the person's or CI's: the defaults instead.
  for (const name of ['CLAUDE_PROJECTS_DIR', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'AGY_HOME', 'AGY_CONFIG_DIR', 'COPILOT_HOME', 'CURSOR_HOME',
    'CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR', 'OPENCODE_PLUGIN_DIR', 'KILO_PLUGIN_DIR', 'PI_HOME', 'HERMES_HOME', 'COMMANDCODE_HOME', 'DEVIN_HOME',
    'DEVIN_CONFIG_PATH', 'AMP_PLUGIN_DIR', 'AMP_SESSIONS_DIR', 'MUSE_CONFIG_DIR', 'HOOK_INSTALL_ENGINES', 'DISABLE_HOOK_INSTALL']) env[name] = undefined
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name]
    if (value === undefined) delete process.env[name]; else process.env[name] = value
  }
  mkdirSync(join(root, 'data'), { recursive: true })
  mkdirSync(join(root, 'runtime'), { recursive: true })
  vi.resetModules()
  ;({ installEngineHooks } = await import('../core/engines/hooks.js') as unknown as { installEngineHooks: typeof installEngineHooks })
  const notify = await import('./kit/notifyHooks.js')
  const { VERSION } = await import('../version.js')
  // Longest first: the root is in every other path.
  tokens = [[notify.HOOK_SCRIPT, '<script>'], [process.execPath, '<node>'], [root, '<root>'], [`.${process.pid}.`, '.<pid>.'], [`"${VERSION}"`, '"<version>"']]
  const previous = process.umask(0o022)
  try {
    for (const vendor of VENDORS) {
      const current = await installed(vendor, PORT)
      const otherPort = await installed(vendor, OTHER_PORT)
      // An older install: another notify script, another data folder, as a release that moved would have left.
      const old = otherPort.split(notify.HOOK_SCRIPT).join('/opt/old/notify.mjs').split(join(root, 'data')).join('/opt/old/data')
      texts[vendor] = { current, otherPort, old }
    }
    legacyOpencodePlugin = await installed('opencode', PORT, 1)
  } finally { process.umask(previous) }
})

afterAll(() => {
  Object.defineProperty(process, 'platform', platform)
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value
  if (root) { reset(); rmSync(root, { recursive: true, force: true }) }
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(recorded, null, 1) + '\n')
})

const casesFor = (vendor: Vendor): Case[] => CASES.filter((one) => !one.vendors || one.vendors.includes(vendor))

describe.each(VENDORS)('%s\'s hooks, installed by the core, byte for byte', (vendor) => {
  for (const scenario of casesFor(vendor)) {
    const key = `${vendor}: ${scenario.name}`
    it.skipIf(scenario.permissions && ROOT_USER)(key, async () => {
      const previous = process.umask(0o022)
      try {
        const outcome = await run(vendor, scenario)
        recorded.outcomes[key] = outcome
        if (!RECORD) {
          const expected = golden.outcomes[key]
          const files = (outcome: Outcome, table: Record<string, string>) => Object.fromEntries(Object.entries(outcome.files)
            .map(([path, entry]) => [path, entry.text ? { ...entry, text: table[entry.text] } : entry]))
          expect({ runs: outcome.runs, files: files(outcome, recorded.texts) }).toEqual({ runs: expected?.runs, files: expected && files(expected, golden.texts) })
        }
      } finally { process.umask(previous) }
    })
  }
})

it('has a recorded outcome for every case, and no other', () => {
  if (RECORD) return
  const expected = VENDORS.flatMap((vendor) => casesFor(vendor).filter((one) => !(one.permissions && ROOT_USER)).map((one) => `${vendor}: ${one.name}`))
  expect(Object.keys(golden.outcomes).filter((key) => ROOT_USER ? expected.includes(key) : true).sort()).toEqual(expected.sort())
})
