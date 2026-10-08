/**
 * What preparing a launch writes into a person's files, byte for byte, in every state those files are found
 * in. Recorded from the code as it stood before Claude Code's and Codex's launch preparation became declared
 * data applied by the kit (docs/design/2026-10-08-engine-launch.md, (c2)):
 *
 *  - folder trust: Claude Code's `.claude.json` (`projects[<path>].hasTrustDialogAccepted`, inherited by
 *    folders below) and Codex's `config.toml` (`[projects."<path>"]`, `trust_level = "trusted"`, exact only),
 *    read and recorded twice, in the default, a moved and a profile's home;
 *  - Codex's rollout made resumable (its reasoning items made portable), with its backup and atomic
 *    replacement, and every refusal;
 *  - the instruction file a harness's bootstrap goes into, and the one the saved APIs' note goes into.
 *
 * Each case keeps what was returned or thrown, and every file left behind: its bytes (a hash past 4 KiB), its
 * mode, a symlink kept or replaced, a temporary file or backup left over. Paths are placeholders.
 *
 * `RECORD_LAUNCH_PREP_GOLDEN=1` writes the fixture. Record it again only for a change meant to alter what
 * lands in a person's files, and say so in that change.
 */
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { env } from '../config/env.js'
import type { InstalledDsh } from '../dsh/installed.js'
import { prepareHarnessLaunch } from '../dsh/runtime.js'
import type { ApiConnections } from '../lib/apiConnections.js'
import { prepareApiInstructions } from '../lib/apiInstructions.js'
import { resetEngineHomes } from '../lib/engineHomes.js'
import { folderTrust, prepareResume, type ResumeSource } from './launchPrep.js'
import { PROCESS_ENGINES, type AgentEngine } from './types.js'

const GOLDEN = fileURLToPath(new URL('./__fixtures__/launch-prep.golden.json', import.meta.url))
const RECORD = process.env.RECORD_LAUNCH_PREP_GOLDEN === '1'
/** Permission cases mean nothing to root, which may read and write anywhere. */
const ROOT_USER = process.getuid?.() === 0

type Snapshot = Record<string, unknown>
interface Golden { trust: Record<string, unknown>; resume: Record<string, unknown>; instructions: Record<string, unknown> }

let root = ''
let savedUmask: number | null = null
const savedEnv: Record<string, string | undefined> = {}
const saved: { dataDir?: string; codexHome?: string } = {}

beforeAll(() => {
  // Files the code writes without a mode take the process's umask: the usual one, on every machine.
  try { savedUmask = process.umask(0o022) } catch { savedUmask = null }
  root = realpathSync(mkdtempSync(join(tmpdir(), 'launch-prep-golden-')))
  saved.dataDir = env.ADAPTER_DATA_DIR
  saved.codexHome = env.CODEX_HOME
  env.ADAPTER_DATA_DIR = join(root, 'data')
  mkdirSync(env.ADAPTER_DATA_DIR)
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']) { savedEnv[name] = process.env[name]; delete process.env[name] }
})

afterAll(() => {
  env.ADAPTER_DATA_DIR = saved.dataDir!
  env.CODEX_HOME = saved.codexHome!
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  resetEngineHomes()
  if (savedUmask !== null) process.umask(savedUmask)
  chmodTree(root)
  rmSync(root, { recursive: true, force: true })
})

/** Undo the permission cases, so the folder can be read and removed. */
function chmodTree(path: string): void {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return
    chmodSync(path, stat.isDirectory() ? 0o755 : 0o644)
    if (stat.isDirectory()) for (const name of readdirSync(path)) chmodTree(join(path, name))
  } catch { /* gone */ }
}

const normalize = (text: string): string => text
  .split(root).join('<root>')
  .split(homedir()).join('<home>')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
  .split(`.harness-${process.pid}.`).join('.harness-<pid>.')

/** Every entry under `dir`: a file's bytes (or hash), its mode, a link's target, what could not be read. */
function snapshot(dir: string): Snapshot {
  const out: Snapshot = {}
  const walk = (path: string, rel: string): void => {
    let names: string[]
    try { names = readdirSync(path).sort() } catch (error) { out[rel || '.'] = { unreadable: (error as NodeJS.ErrnoException).code }; return }
    for (const name of names) {
      const full = join(path, name)
      const key = normalize(rel ? `${rel}/${name}` : name)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) { out[key] = { link: normalize(readlinkSync(full)) }; continue }
      if (stat.isDirectory()) { out[key] = { dir: true, mode: (stat.mode & 0o777).toString(8) }; walk(full, rel ? `${rel}/${name}` : name); continue }
      const mode = (stat.mode & 0o777).toString(8)
      let bytes: Buffer
      try { bytes = readFileSync(full) } catch (error) { out[key] = { mode, unreadable: (error as NodeJS.ErrnoException).code }; continue }
      out[key] = bytes.length > 4096
        ? { mode, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
        : { mode, text: normalize(bytes.toString('utf8')) }
    }
  }
  walk(dir, '')
  return out
}

function attempt<T>(run: () => T): { value: T } | { threw: string } {
  try { return { value: run() } } catch (error) { return { threw: normalize(error instanceof Error ? error.message : String(error)) } }
}

const write = (path: string, text: string | Buffer, mode = 0o644): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, mode)
}

/** A fresh folder for one case, named by the case alone: a case left out (root skips the permission cases)
 *  changes no other case's paths. */
const fresh = (name: string): string => {
  const dir = join(root, `case-${createHash('sha256').update(name).digest('hex').slice(0, 10)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------------------------- folder trust

const TARGET = '/work/new project'
const PROBES = [TARGET, `${TARGET}/sub`, '/work', `${TARGET}x`, `${TARGET}/`]
interface TrustCase { name: string; file?: (home: string, elsewhere: string) => void; noHome?: boolean; permissions?: boolean; target?: string }

const pretty = (value: unknown): string => JSON.stringify(value, null, 2)
const CLAUDE_CASES: TrustCase[] = [
  { name: 'no file' },
  { name: 'no home folder', noHome: true },
  { name: 'empty file', file: (home) => write(join(home, '.claude.json'), '') },
  { name: 'whitespace only', file: (home) => write(join(home, '.claude.json'), '  \n') },
  { name: 'malformed JSON', file: (home) => write(join(home, '.claude.json'), '{not-json') },
  { name: 'byte order mark', file: (home) => write(join(home, '.claude.json'), '﻿{}') },
  ...['null', '[]', '"text"', '42'].map((json) => ({ name: `JSON ${json}`, file: (home: string) => write(join(home, '.claude.json'), json) })),
  { name: 'an empty object', file: (home) => write(join(home, '.claude.json'), '{}') },
  ...['[]', '"x"', 'null', '7'].map((json) => ({ name: `projects is ${json}`, file: (home: string) => write(join(home, '.claude.json'), `{"projects":${json},"keep":1}`) })),
  { name: 'projects empty', file: (home) => write(join(home, '.claude.json'), pretty({ projects: {} })) },
  ...['"x"', '[]', 'null', 'true'].map((json) => ({ name: `the entry is ${json}`, file: (home: string) => write(join(home, '.claude.json'), `{"projects":{${JSON.stringify(TARGET)}:${json}}}`) })),
  { name: 'the entry is empty', file: (home) => write(join(home, '.claude.json'), pretty({ projects: { [TARGET]: {} } })) },
  { name: 'the entry says no', file: (home) => write(join(home, '.claude.json'), pretty({ projects: { [TARGET]: { allowedTools: ['Bash'], hasTrustDialogAccepted: false, mcpServers: { a: 1 } } } })) },
  { name: 'the entry says yes', file: (home) => write(join(home, '.claude.json'), pretty({ projects: { [TARGET]: { hasTrustDialogAccepted: true } } })) },
  { name: 'the entry says "true"', file: (home) => write(join(home, '.claude.json'), pretty({ projects: { [TARGET]: { hasTrustDialogAccepted: 'true' } } })) },
  { name: 'a parent says yes', file: (home) => write(join(home, '.claude.json'), pretty({ projects: { '/work': { hasTrustDialogAccepted: true } } })) },
  { name: 'a parent with a trailing slash says yes', file: (home) => write(join(home, '.claude.json'), pretty({ projects: { '/work//': { hasTrustDialogAccepted: true } } })) },
  { name: 'a longer sibling says yes', file: (home) => write(join(home, '.claude.json'), pretty({ projects: { '/work/new proj': { hasTrustDialogAccepted: true }, [`${TARGET}x`]: { hasTrustDialogAccepted: true } } })) },
  { name: 'a parent says no', file: (home) => write(join(home, '.claude.json'), pretty({ projects: { '/work': { hasTrustDialogAccepted: false }, '/': 'odd' } })) },
  {
    name: 'other settings', file: (home) => write(join(home, '.claude.json'),
      pretty({ numStartups: 12, theme: 'dark', note: 'café ✓ 🎉', nested: { list: [1, 2.5, null] }, projects: { '/other': { allowedTools: [], hasTrustDialogAccepted: true } } })),
  },
  { name: 'minified', file: (home) => write(join(home, '.claude.json'), JSON.stringify({ a: 1, projects: { '/other': {} } })) },
  { name: 'duplicate keys', file: (home) => write(join(home, '.claude.json'), `{"projects":{},"projects":{${JSON.stringify(TARGET)}:{"x":1}}}`) },
  { name: 'unicode target', target: '/work/café ✓ "q"', file: (home) => write(join(home, '.claude.json'), '{}') },
  {
    name: 'a symlink to dotfiles', file: (home, elsewhere) => {
      write(join(elsewhere, 'claude.json'), pretty({ projects: {} }))
      symlinkSync(join(elsewhere, 'claude.json'), join(home, '.claude.json'))
    },
  },
  { name: 'a dangling symlink', file: (home, elsewhere) => symlinkSync(join(elsewhere, 'missing.json'), join(home, '.claude.json')) },
  { name: 'a private file', file: (home) => write(join(home, '.claude.json'), '{}', 0o600) },
  { name: 'a read-only file', permissions: true, file: (home) => write(join(home, '.claude.json'), '{}', 0o444) },
  { name: 'an unreadable file', permissions: true, file: (home) => write(join(home, '.claude.json'), '{}', 0o200) },
  { name: 'a read-only folder', permissions: true, file: (home) => { write(join(home, '.claude.json'), '{}'); chmodSync(home, 0o555) } },
  { name: 'the file is a folder', file: (home) => mkdirSync(join(home, '.claude.json'), { recursive: true }) },
  { name: 'a leftover temporary file', file: (home) => { write(join(home, '.claude.json'), '{}'); write(join(home, '.claude.json.harness-1.tmp'), 'old') } },
]

const toml = (text: string) => (home: string): void => write(join(home, 'config.toml'), text)
const T = JSON.stringify(TARGET)
const CODEX_CASES: TrustCase[] = [
  { name: 'no file' },
  { name: 'no home folder', noHome: true },
  { name: 'empty file', file: toml('') },
  { name: 'settings, no newline at the end', file: toml('model = "gpt-5"') },
  { name: 'trailing blank lines and spaces', file: toml('model = "gpt-5"\n\n\n  \t\n') },
  { name: 'CRLF', file: toml('model = "gpt-5"\r\n[profiles.work]\r\nmodel = "o3"\r\n') },
  { name: 'trusted already', file: toml(`[projects.${T}]\ntrust_level = "trusted"\n`) },
  { name: 'listed, untrusted', file: toml(`[projects.${T}]\ntrust_level = "untrusted"\n`) },
  { name: 'single-quoted key', file: toml(`[projects.'${TARGET}']\ntrust_level = 'trusted'\n`) },
  { name: 'spaced header', file: toml(`  [ projects . ${T} ]  \n  trust_level   =   "trusted"\n`) },
  { name: 'escaped key', file: toml('[projects."/work/new\\u0020project"]\ntrust_level = "trusted"\n') },
  { name: 'a key JSON cannot read', file: toml('[projects."/work/\\U0001F600"]\ntrust_level = "trusted"\n') },
  { name: 'an inline table', file: toml('projects = { "/other" = { trust_level = "trusted" } }\n') },
  { name: 'dotted keys', file: toml('projects."/other".trust_level = "trusted"\n') },
  { name: 'a bare projects table', file: toml('[projects]\n"/other" = 1\n') },
  { name: 'other projects', file: toml(`model = "x"\n\n[projects."/other"]\ntrust_level = "trusted"\n\n[projects."/work"]\ntrust_level = "trusted"\n`) },
  { name: 'trust in a sub-table', file: toml(`[projects.${T}.sub]\ntrust_level = "trusted"\n`) },
  { name: 'trust only in the next table', file: toml(`[projects.${T}]\nnote = "x"\n[other]\ntrust_level = "trusted"\n`) },
  { name: 'a commented header', file: toml(`# [projects.${T}]\n# trust_level = "trusted"\n`) },
  { name: 'unicode, a quote, a backslash and DEL', target: '/work/q"uote\\back\x7fdel é', file: toml('model = "x"\n') },
  {
    name: 'a symlink to dotfiles', file: (home, elsewhere) => {
      write(join(elsewhere, 'config.toml'), 'model = "x"\n')
      symlinkSync(join(elsewhere, 'config.toml'), join(home, 'config.toml'))
    },
  },
  { name: 'a dangling symlink', file: (home, elsewhere) => symlinkSync(join(elsewhere, 'missing.toml'), join(home, 'config.toml')) },
  { name: 'a private file', file: (home) => write(join(home, 'config.toml'), 'model = "x"\n', 0o600) },
  { name: 'a read-only file', permissions: true, file: (home) => write(join(home, 'config.toml'), 'model = "x"\n', 0o444) },
  { name: 'an unreadable file', permissions: true, file: (home) => write(join(home, 'config.toml'), 'model = "x"\n', 0o200) },
  { name: 'a read-only folder', permissions: true, file: (home) => { write(join(home, 'config.toml'), 'model = "x"\n'); chmodSync(home, 0o555) } },
  { name: 'the file is a folder', file: (home) => mkdirSync(join(home, 'config.toml'), { recursive: true }) },
]

/** How the engine's home is found: the daemon's default, the one the person's shell moves, an agent's profile. */
type Where = 'moved' | 'default' | 'profile'

/** Claude Code's files in the (throwaway) home folder, where its `.claude.json` is by default. */
const homeFolderFiles = (): Snapshot => Object.fromEntries(Object.entries(snapshot(homedir()))
  .filter(([name]) => name.startsWith('.claude.json')).map(([name, value]) => [`<home>/${name}`, value]))
const clearHomeFolder = (): void => {
  for (const name of readdirSync(homedir())) if (name.startsWith('.claude.json')) rmSync(join(homedir(), name), { recursive: true, force: true })
}

function trustCase(engine: AgentEngine, scenario: TrustCase, where: Where): unknown {
  const dir = fresh(`${engine}-${where}-${scenario.name}`)
  const home = join(dir, 'home')
  const elsewhere = join(dir, 'elsewhere')
  mkdirSync(elsewhere)
  if (!scenario.noHome) mkdirSync(home)
  const before = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, config: env.CODEX_HOME }
  try {
    if (engine === 'claude') {
      // Claude Code's `.claude.json` is in CLAUDE_CONFIG_DIR, else the home folder itself.
      if (where === 'moved') process.env.CLAUDE_CONFIG_DIR = home
    } else if (where === 'moved') process.env.CODEX_HOME = home
    else if (where === 'default') env.CODEX_HOME = home
    const inHomeFolder = engine === 'claude' && where === 'default'
    const atHome = inHomeFolder ? homedir() : home
    if (inHomeFolder) clearHomeFolder()
    scenario.file?.(atHome, elsewhere)
    const trust = folderTrust(engine, where === 'profile' ? home : null)
    const target = scenario.target ?? TARGET
    const probes = [...PROBES, target].filter((path, index, all) => all.indexOf(path) === index)
    const result = {
      before: probes.map((path) => attempt(() => trust!.trusts(path))),
      first: attempt(() => trust!.record(target)),
      second: attempt(() => trust!.record(target)),
      after: probes.map((path) => attempt(() => trust!.trusts(path))),
      files: inHomeFolder ? { ...snapshot(dir), ...homeFolderFiles() } : snapshot(dir),
    }
    if (inHomeFolder) clearHomeFolder()
    return result
  } finally {
    if (before.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = before.CLAUDE_CONFIG_DIR
    if (before.CODEX_HOME === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = before.CODEX_HOME
    env.CODEX_HOME = before.config
  }
}

function trustCases(): Record<string, unknown> {
  const cases: Record<string, unknown> = {}
  for (const [engine, scenarios, wheres] of [
    ['claude', CLAUDE_CASES, ['moved', 'default']],
    ['codex', CODEX_CASES, ['profile', 'moved', 'default']],
  ] as const) {
    for (const scenario of scenarios) {
      for (const where of wheres) {
        // The default and moved homes need only the common states: the file's handling is the profile's.
        if (where !== wheres[0] && scenario.permissions) continue
        if (scenario.permissions && ROOT_USER) continue
        cases[`${engine} · ${where} · ${scenario.name}`] = trustCase(engine, scenario, where)
      }
    }
  }
  // An engine that asks no such question.
  for (const engine of PROCESS_ENGINES.filter((name) => name !== 'claude' && name !== 'codex')) cases[`${engine} · no folder trust`] = folderTrust(engine, '/profile')
  // A relative or `~` CLAUDE_CONFIG_DIR is not the one Claude Code would read from every folder: the home folder is.
  for (const moved of ['relative/claude', '~/claude']) {
    const dir = fresh(`claude-moved-${moved}`)
    process.env.CLAUDE_CONFIG_DIR = moved
    try {
      clearHomeFolder()
      write(join(homedir(), '.claude.json'), '{}')
      const trust = folderTrust('claude')!
      cases[`claude · moved to ${moved}`] = { first: attempt(() => trust.record(TARGET)), files: { ...snapshot(dir), ...homeFolderFiles() } }
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR
      clearHomeFolder()
    }
  }
  return cases
}

// ---------------------------------------------------------------------------------------- resumable history

const SESSION = '01a0a3cd-a374-71f2-a11a-1fc1cc41b36d'
const record = (type: string, payload: unknown): string => JSON.stringify({ timestamp: '2026-10-08T06:43:10.580Z', type, payload })
const meta = (id = SESSION) => record('session_meta', { id, cwd: '/workspace', model_provider: 'openai' })
const summary = [{ type: 'summary_text', text: 'Prior summary.' }]
const reasoning = (extra: Record<string, unknown> = {}) => ({ type: 'reasoning', id: 'msg_aY9suLof0GA06VzeKPXLM7rj', summary, content: [], ...extra })
const message = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Hello ✓.' }] }
const item = (payload: unknown): string => record('response_item', payload)
const rolloutName = (id = SESSION) => `rollout-2026-10-08T06-43-10-${id}.jsonl`

interface ResumeCase {
  name: string
  /** The rollout's text; null for none. */
  text?: string | Buffer | null
  /** Where the rollout is, under the case folder. */
  at?: string
  /** What the source says. */
  source?: (dir: string) => Partial<ResumeSource>
  setup?: (dir: string) => void
}

const LONG = (() => {
  // Past one 64 KiB read, with a three-byte character across the boundary and a repair after it.
  const head = `${meta()}\n${item(message)}\n`
  const filler = 'é'.repeat(70_000)
  return `${head}${record('event_msg', { type: 'agent_message', message: filler })}\n${item(reasoning({ content: [{ text: 'late' }] }))}\n`
})()

const RESUME_CASES: ResumeCase[] = [
  { name: 'another engine', source: () => ({ engine: 'claude' }), text: `${meta()}\n${item(reasoning())}\n` },
  { name: 'no session id', source: () => ({ sessionId: '' }), text: `${meta()}\n${item(reasoning())}\n` },
  { name: 'a reasoning id', text: `${meta()}\n${item(reasoning())}\n${item(message)}\n` },
  { name: 'nothing to repair', text: `${meta()}\n${item(message)}\n${item({ type: 'reasoning', summary, content: [] })}\n` },
  { name: 'reasoning content becomes the summary', text: `${meta()}\n${item(reasoning({ summary: [], content: [{ text: 'one ' }, { type: 'x', text: 'two' }, 'odd', { text: 3 }] }))}\n` },
  { name: 'content beside a summary', text: `${meta()}\n${item(reasoning({ content: [{ text: 'dup' }] }))}\n` },
  { name: 'content with no text', text: `${meta()}\n${item(reasoning({ id: undefined, summary: [], content: [{ type: 'x' }] }))}\n` },
  { name: 'encrypted reasoning kept', text: `${meta()}\n${item(reasoning({ encrypted_content: 'opaque', content: [{ text: 'v' }] }))}\n` },
  {
    name: 'compacted history and other records',
    text: `${meta()}\n${record('compacted', { message: 'sum', replacement_history: [reasoning(), message, 'odd', null] })}\n`
      + `${record('compacted', { message: 'none' })}\n${record('event_msg', { type: 'agent_reasoning', metadata: reasoning() })}\n${record('turn_context', { cwd: '/w' })}\n`,
  },
  { name: 'CRLF, blank lines and no newline at the end', text: `${meta()}\r\n\r\n${item(reasoning())}\r\n   \n${item(reasoning({ id: 'rs_2' }))}` },
  { name: 'past one read', text: LONG },
  { name: 'another session\'s rollout', text: `${meta('ffffffff-0000-0000-0000-000000000000')}\n${item(reasoning())}\n` },
  { name: 'no session metadata first', text: `${item(reasoning())}\n${meta()}\n` },
  { name: 'session metadata with no payload', text: `${record('session_meta', null)}\n` },
  { name: 'invalid JSON', text: `${meta()}\n${item(reasoning())}\n{"type": "response_item", "payload": {"text": "secret words"\n` },
  { name: 'a record that is not an object', text: `${meta()}\n[1,2]\n` },
  { name: 'an empty rollout', text: '' },
  { name: 'blank lines only', text: '\n\n' },
  { name: 'no rollout at all', text: null, source: () => ({ transcriptPath: null }) },
  { name: 'found by id', source: () => ({ transcriptPath: null }), text: `${meta()}\n${item(reasoning())}\n` },
  { name: 'a stale path, found by id', source: (dir) => ({ transcriptPath: join(dir, 'profile/sessions/old/gone.jsonl') }), text: `${meta()}\n${item(reasoning())}\n` },
  { name: 'a stale path, nothing by id', source: (dir) => ({ transcriptPath: join(dir, 'profile/sessions/old/gone.jsonl'), sessionId: 'abcdefab-0000-0000-0000-00000000dead' }), text: `${meta()}\n${item(reasoning())}\n` },
  { name: 'an id too short to look up', source: () => ({ transcriptPath: null, sessionId: 'short' }), text: `${meta('short')}\n${item(reasoning())}\n` },
  {
    name: 'outside the profile', source: (dir) => ({ transcriptPath: join(dir, 'elsewhere', rolloutName()) }),
    setup: (dir) => write(join(dir, 'elsewhere', rolloutName()), `${meta()}\n${item(reasoning())}\n`), text: null,
  },
  {
    name: 'a symlinked rollout', text: null, source: (dir) => ({ transcriptPath: join(dir, 'profile/sessions/2026/10/08', rolloutName()) }),
    setup: (dir) => {
      write(join(dir, 'profile/sessions/real.jsonl'), `${meta()}\n${item(reasoning())}\n`)
      mkdirSync(join(dir, 'profile/sessions/2026/10/08'), { recursive: true })
      symlinkSync(join(dir, 'profile/sessions/real.jsonl'), join(dir, 'profile/sessions/2026/10/08', rolloutName()))
    },
  },
  { name: 'a folder where the rollout is', text: null, source: (dir) => ({ transcriptPath: join(dir, 'profile/sessions') }), setup: (dir) => mkdirSync(join(dir, 'profile/sessions'), { recursive: true }) },
  { name: 'a world-readable rollout', text: `${meta()}\n${item(reasoning())}\n`, setup: () => undefined },
  { name: 'a leftover backup and temporary file', text: `${meta()}\n${item(reasoning())}\n`, setup: (dir) => write(join(dir, 'profile/sessions/2026/10/08', `${rolloutName()}.reasoning-tmp-old`), 'x') },
]

/** Where the agent's Codex home is: its own profile, the daemon's, or one the person moved (remembered). */
function resumeCase(scenario: ResumeCase, where: Where): unknown {
  const dir = fresh(`resume-${where}-${scenario.name}`)
  const home = join(dir, where === 'profile' ? 'profile' : where === 'default' ? 'daemon' : 'moved')
  mkdirSync(join(home, 'sessions'), { recursive: true })
  mkdirSync(join(dir, 'elsewhere'), { recursive: true })
  const before = env.CODEX_HOME
  resetEngineHomes()
  try {
    if (where === 'default') env.CODEX_HOME = home
    else env.CODEX_HOME = join(dir, 'daemon-empty')
    if (where === 'moved') writeFileSync(join(env.ADAPTER_DATA_DIR, 'engine-homes.json'), JSON.stringify({ claude: [], codex: [home] }) + '\n')
    else rmSync(join(env.ADAPTER_DATA_DIR, 'engine-homes.json'), { force: true })
    const file = join(home, 'sessions/2026/10/08', rolloutName())
    if (scenario.text !== null && scenario.text !== undefined) write(file, scenario.text, scenario.name === 'a world-readable rollout' ? 0o644 : 0o600)
    // Only the profile's cases name paths of their own (setup, source); the others run in their own home.
    scenario.setup?.(dir)
    const source: ResumeSource = { engine: 'codex', sessionId: SESSION, transcriptPath: file, codexHome: where === 'profile' ? home : null, ...scenario.source?.(dir) }
    const result = attempt(() => prepareResume(source))
    return { result: JSON.parse(normalize(JSON.stringify(result))), files: snapshot(dir) }
  } finally {
    env.CODEX_HOME = before
    rmSync(join(env.ADAPTER_DATA_DIR, 'engine-homes.json'), { force: true })
    resetEngineHomes()
  }
}

function resumeCases(): Record<string, unknown> {
  const cases: Record<string, unknown> = {}
  for (const scenario of RESUME_CASES) cases[`profile · ${scenario.name}`] = resumeCase(scenario, 'profile')
  for (const name of ['a reasoning id', 'found by id', 'nothing to repair', 'no rollout at all']) {
    const scenario = RESUME_CASES.find((candidate) => candidate.name === name)!
    for (const where of ['default', 'moved'] as const) cases[`${where} · ${name}`] = resumeCase(scenario, where)
  }
  return cases
}

// ------------------------------------------------------------------------------------- instruction files

const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', 'AGENTS.override.md', 'GEMINI.md', '.hermes.md', '.cursorrules']
const WORKSPACE_STATES: Record<string, Record<string, string>> = {
  'an empty workspace': {},
  'CLAUDE.md': { 'CLAUDE.md': '# Claude rules' },
  'AGENTS.md': { 'AGENTS.md': '# Shared rules\n' },
  'CLAUDE.md and AGENTS.md': { 'CLAUDE.md': '# Claude rules\n', 'AGENTS.md': '# Shared rules\n' },
  'CLAUDE.md importing AGENTS.md': { 'CLAUDE.md': '# Claude rules\n  @AGENTS.md  \n', 'AGENTS.md': '# Shared rules\n' },
  'AGENTS.override.md and AGENTS.md': { 'AGENTS.override.md': '# Override', 'AGENTS.md': '# Shared rules' },
  'GEMINI.md and .hermes.md': { 'GEMINI.md': '# Gemini', '.hermes.md': '# Hermes' },
}

function harnessPackage(dir: string): InstalledDsh {
  const pkg = join(dir, 'package')
  write(join(pkg, 'AGENTS.md'), '# Draw\nRead the draw skill.\n')
  write(join(pkg, 'skills/draw/SKILL.md'), '# Draw skill\n')
  return {
    id: 'acme/draw', dir: pkg, realDir: pkg, source: pkg, ref: null, commit: null, linked: true, installedAt: 1,
    manifest: { spec: 1, id: 'acme/draw', name: 'Drawing', engine: 'claude', agent: { instructions: 'AGENTS.md', skills: ['skills'] } },
  } as InstalledDsh
}

function instructionFiles(ws: string): Snapshot {
  const all = snapshot(ws)
  return Object.fromEntries(Object.entries(all).filter(([name]) => INSTRUCTION_FILES.includes(name)))
}

function instructionCases(): Record<string, unknown> {
  const cases: Record<string, unknown> = {}
  const deep = new Set<AgentEngine>(['claude', 'codex', 'opencode', 'hermes'])
  for (const engine of PROCESS_ENGINES) {
    for (const [state, files] of Object.entries(WORKSPACE_STATES)) {
      if (!deep.has(engine) && state !== 'an empty workspace' && state !== 'AGENTS.md') continue
      const dir = fresh(`harness-${engine}-${state}`)
      const ws = join(dir, 'workspace')
      mkdirSync(ws)
      for (const [name, text] of Object.entries(files)) write(join(ws, name), text)
      const pkg = harnessPackage(dir)
      const first = attempt(() => { prepareHarnessLaunch(pkg, ws, engine, 'runtime-1'); return 'prepared' })
      const after = instructionFiles(ws)
      const second = attempt(() => { prepareHarnessLaunch(pkg, ws, engine, 'runtime-1'); return 'prepared' })
      cases[`harness · ${engine} · ${state}`] = { first, second, after, again: instructionFiles(ws) }
    }
  }
  // An edited bootstrap is refused, and a symlinked instruction file is never replaced.
  for (const engine of ['claude', 'codex'] as const) {
    const file = engine === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'
    const dir = fresh(`harness-${engine}-edited`)
    const ws = join(dir, 'workspace')
    mkdirSync(ws)
    write(join(ws, file), '# Rules\n<!-- harness:runtime v1 -->\nedited\n')
    cases[`harness · ${engine} · an edited bootstrap`] = { first: attempt(() => prepareHarnessLaunch(harnessPackage(dir), ws, engine, 'runtime-1') && 'prepared'), after: instructionFiles(ws) }
    const linked = fresh(`harness-${engine}-linked`)
    const lws = join(linked, 'workspace')
    mkdirSync(lws)
    write(join(linked, 'shared.md'), '# Shared\n')
    symlinkSync(join(linked, 'shared.md'), join(lws, file))
    cases[`harness · ${engine} · a symlinked instruction file`] = { first: attempt(() => prepareHarnessLaunch(harnessPackage(linked), lws, engine, 'runtime-1') && 'prepared'), after: instructionFiles(lws), shared: snapshot(linked)['shared.md'] }
  }
  // The saved APIs' note.
  const withApis = { list: () => [{ id: 'openrouter' }] } as unknown as ApiConnections
  const noApis = { list: () => [] } as unknown as ApiConnections
  const states: Record<string, (ws: string, file: string) => void> = {
    'no file': () => undefined,
    'a file of the person\'s': (ws, file) => write(join(ws, file), '# Mine\n\n\n'),
    'a file already noted': (ws, file) => write(join(ws, file), '# Mine\n<!-- harness:apis -->\nold note\n'),
    'a symlinked file': (ws, file) => { write(join(ws, '..', 'target.md'), '# Target\n'); symlinkSync(join(ws, '..', 'target.md'), join(ws, file)) },
    'a folder by that name': (ws, file) => mkdirSync(join(ws, file)),
  }
  for (const engine of [...PROCESS_ENGINES, 'terminal', 'gemini']) {
    for (const [state, setup] of Object.entries(states)) {
      if (engine !== 'claude' && engine !== 'codex' && engine !== 'gemini' && state !== 'no file') continue
      for (const [apis, store] of [['saved APIs', withApis], ['no saved APIs', noApis]] as const) {
        if (apis === 'no saved APIs' && state !== 'no file') continue
        const dir = fresh(`apis-${engine}-${state}-${apis}`)
        const ws = join(dir, 'workspace')
        mkdirSync(ws)
        const file = engine === 'claude' ? 'CLAUDE.md' : engine === 'gemini' ? 'GEMINI.md' : 'AGENTS.md'
        setup(ws, file)
        const first = attempt(() => { prepareApiInstructions(store, ws, engine); return 'done' })
        const second = attempt(() => { prepareApiInstructions(store, ws, engine); return 'done' })
        cases[`apis · ${engine} · ${state} · ${apis}`] = { first, second, files: snapshot(dir) }
      }
    }
  }
  return cases
}

describe('launch preparation writes what it did before Claude Code and Codex declared it', () => {
  it('folder trust, resumable history and instruction files match the record', () => {
    const actual: Golden = { trust: trustCases(), resume: resumeCases(), instructions: instructionCases() }
    if (RECORD) {
      if (ROOT_USER) throw new Error('record as a user other than root: the permission cases are part of the record')
      const block = (cases: Record<string, unknown>): string => Object.entries(cases).map(([key, value]) => ` ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(',\n')
      writeFileSync(GOLDEN, `{\n"trust": {\n${block(actual.trust)}\n},\n"resume": {\n${block(actual.resume)}\n},\n"instructions": {\n${block(actual.instructions)}\n}\n}\n`)
      return
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden
    for (const section of ['trust', 'resume', 'instructions'] as const) {
      // Compared case by case, so a failure names it. Root skips the permission cases it cannot reproduce.
      const expected = Object.keys(golden[section]).filter((key) => !ROOT_USER || key in actual[section])
      expect(Object.keys(actual[section]).sort(), section).toEqual(expected.sort())
      for (const key of expected) expect(actual[section][key], `${section} · ${key}`).toEqual(golden[section][key])
    }
  }, 120_000)

  it('records no machine-specific path', () => {
    const text = readFileSync(GOLDEN, 'utf8')
    expect(text).not.toContain(tmpdir())
    expect(text).not.toMatch(/\/Users\/|\/home\/runner/)
  })
})
