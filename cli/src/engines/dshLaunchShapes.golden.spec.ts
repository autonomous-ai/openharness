/**
 * Every launch shape that carries a harness package (DSH), answer for answer: recorded from the code as it stood
 * before the Store prepared those launches for the core (docs/design/2026-10-08-launch-port.md, (L3)). For each
 * engine, it records what a create, a relaunch (restart, resume, restore) and a fork start the pane with: the argv,
 * the environment, the variables cleared, the row's harness fields. It also records the workspace each leaves behind
 * (the template, the init the harness asked to run, the session's runtime, its skills and its context, the engine's
 * bootstrap), the folder trust a create records, the log lines and every refusal.
 *
 * Each case runs with `process.platform` pinned to darwin and to linux, and linux's are stored where they differ.
 * Local time is pinned. The home folder, the data folder and the packages are the spec's own, and no size depends
 * on their paths. A harness's init is recorded as asked for, never run: it would run in this machine's shell. A
 * create's label, new each time, is one per engine.
 *
 * `RECORD_DSH_LAUNCH_SHAPES_GOLDEN=1` writes the fixture. Record it again only for a change meant to alter a launch,
 * and say so in that change.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PROCESS_ENGINES, type AgentEngine } from './types.js'
import { baseNode } from '../harnessd/baseNode.js'
import { resolveBinaryOnPath } from '../lib/binaryOnPath.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { GridLaunchOverride } from '../lib/gridLaunchWire.js'

process.env.TZ = 'UTC'

// The pane itself, the probes of this machine's binaries, and a harness's init: the launch is what is recorded.
const pane = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, tmux: true }))
const init = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, code: 0 as number | null, timedOut: false }))
vi.mock('../lib/createAgentPane.js', () => ({
  createAndRegisterPane: vi.fn(async (input: Record<string, unknown>) => {
    pane.calls.push(input)
    return { ok: false, error: 'RECORDED', detail: 'the pane is not opened by this spec' }
  }),
}))
vi.mock('../lib/tmuxVersion.js', async (real) => ({ ...await real<object>(), tmuxSupportsSessionEnv: vi.fn(async () => pane.tmux) }))
vi.mock('../engines/launchControl.js', async (real) => ({ ...await real<object>(), opencodeMajorVersion: vi.fn(() => 2) }))
vi.mock('../lib/engineBin.js', async (real) => ({ ...await real<object>(), enginePathOverride: vi.fn(() => null) }))
// A create's and a fork's label is new each time, and their session's runtime is keyed on it: one per engine here.
vi.mock('../lib/harnessSessionLabel.js', async (real) => ({ ...await real<object>(), buildHarnessSessionLabel: vi.fn((engine: string) => `harness-${engine}-golden`) }))
vi.mock('../dsh/shell.js', async (real) => ({
  ...await real<object>(),
  runDshCommand: vi.fn(async (command: string, options: { cwd: string; env?: Record<string, string>; onLine?: (line: string) => void; timeoutMs?: number }) => {
    init.calls.push({ command, cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs })
    options.onLine?.('laying out the workspace')
    // What the package's init does when it works: it marks the workspace as laid out.
    if (init.code === 0 && !init.timedOut) writeFileSync(join(options.cwd, '.draw-ready'), 'ready\n')
    return { code: init.code, signal: null, lines: ['laying out the workspace'], timedOut: init.timedOut }
  }),
}))

const GOLDEN = fileURLToPath(new URL('./__fixtures__/dsh-launch-shapes.golden.json', import.meta.url))
const RECORD = process.env.RECORD_DSH_LAUNCH_SHAPES_GOLDEN === '1'

let root = ''
const saved: Record<string, string | undefined> = {}
/** The variables a launch reads of the daemon's own environment, each pinned (or cleared) for the record. */
const VARS = ['ADAPTER_DATA_DIR', 'DSH_DIR', 'HOME', 'ZDOTDIR', 'SHELL', 'CODEX_HOME', 'CODEX_PATH', 'HARNESS_OS', 'HARNESS_GRID_BIN', 'CLAUDE_PATH',
  'CURSOR_PATH', 'OPENCODE_PATH', 'PI_PATH', 'HERMES_PATH', 'COMMANDCODE_PATH', 'DEVIN_PATH', 'MUSE_PATH', 'AMP_PATH', 'KILO_PATH', 'GROK_PATH',
  'AGY_PATH', 'COPILOT_PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'] as const
/** The launch scripts the cases name, by digest: most shapes share theirs with others. */
const scripts: Record<string, string> = {}
type Shapes = ReturnType<typeof import('../testing/launchShapes.js')['launchShapes']>
let shapes: (gridName?: string | null) => Shapes
let invalidate: () => void = () => {}

const GRID: GridLaunchOverride = {
  networkId: 'net-home', networkName: 'Home', baseUrl: 'https://grid.example/g/home/relay/v1', apiKey: 'grid-key-1', model: 'qwen3-coder',
}
const M1 = { hermesSystemManaged: false, opencodeMajor: 2 }

/** The machine's own parts of a text, as placeholders: the spec's folders, this node. */
const placeheld = (text: string): string => {
  const node = baseNode(process.execPath)
  const tmux = resolveBinaryOnPath('tmux') ?? 'tmux'
  return text.split(`'${node}'`).join("'<daemon-node>'").split(`'${dirname(node)}'`).join("'<daemon-node-dir>'")
    .split(`'${tmux}'`).join("'<tmux>'")
    .split(root).join('<root>')
    .replace(/\/launch\/[0-9a-f-]{36}\.sh/g, '/launch/<script>.sh')
}
const norm = (value: unknown): unknown => value === undefined ? '<undefined>' : JSON.parse(placeheld(JSON.stringify(value)))
/** The script a launch's argv sources, kept once by its digest. */
function scriptOf(argv: unknown): string | null {
  const sourced = Array.isArray(argv) ? argv.map(String).map((arg) => /^\. '(.+\/launch\/[0-9a-f-]{36}\.sh)'$/.exec(arg)?.[1]).find(Boolean) : undefined
  if (!sourced || !existsSync(sourced)) return null
  const text = placeheld(readFileSync(sourced, 'utf8'))
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 16)
  scripts[digest] = text
  return digest
}

/** A folder's files: names, bytes and modes, and where each link points. */
function tree(dir: string): Record<string, unknown> | null {
  if (!existsSync(dir)) return null
  const out: Record<string, unknown> = {}
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const info = lstatSync(path)
    out[name] = info.isSymbolicLink() ? { link: readlinkSync(path) }
      : info.isDirectory() ? { dir: tree(path) }
        : { mode: (statSync(path).mode & 0o777).toString(8), text: readFileSync(path, 'utf8') }
  }
  return out
}
const write = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
let folders = 0
const work = (files: Record<string, string> = {}): string => {
  const dir = join(root, 'work', `w${++folders}`)
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) write(join(dir, name), text)
  return dir
}

// ------------------------------------------------------------------------------------------------ packages

const DRAW = 'acme/draw'
const BARE = 'acme/bare'
const VIEWER = 'acme/viewer'
const BROKEN = 'acme/broken'
const RENAMED = 'acme/renamed'
const MODEL_MANAGER = 'autonomous/autonomous-grid'
const installed: Array<Record<string, unknown>> = []

function install(manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const id = String(manifest.id)
  const dir = join(root, 'dsh', ...id.split('/'))
  rmSync(dir, { recursive: true, force: true })
  for (const [name, text] of Object.entries(files)) write(join(dir, name), text)
  write(join(dir, 'harness.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const others = installed.filter((row) => row.id !== id)
  installed.length = 0
  installed.push(...others, { id, dir, source: dir, ref: null, commit: null, linked: false, installedAt: 1 })
  write(join(root, 'dsh', 'installed.json'), `${JSON.stringify(installed, null, 2)}\n`)
  invalidate()
  return dir
}
const DRAW_FILES = {
  'AGENTS.md': '# Make a drawing\nYou are Claude Code in this workspace.\nRead `.claude/skills/draw/SKILL.md` first.\n',
  'skills/draw/SKILL.md': '# Draw\nRun the toolchain and write .harness/verdict.json.\n',
  'skills/paint/SKILL.md': '# Paint\nColour it in.\n',
  'template/README.md': '# A drawing\n',
  'template/input/brief.md': 'Draw a house.\n',
  'harness/init.sh': '#!/bin/sh\necho laying out\n',
}
function installAll(): void {
  install({
    spec: 1, id: DRAW, name: 'Drawing', engine: 'claude',
    workspace: { template: 'template', marker: '.draw-ready', init: 'harness/init.sh' },
    agent: {
      instructions: 'AGENTS.md', skills: ['skills'], args: ['--add-dir', '${workspace}/input'],
      env: { TOOLCHAIN: '${dsh}/tools', OLD_SKILLS: '${workspace}/.claude/skills', OTHER_SKILLS: '${workspace}/.agents/skills', HARNESS_DSH: 'spoofed' },
    },
  }, DRAW_FILES)
  install({ spec: 1, id: BARE, name: 'Bare', engine: 'codex' })
  install({ spec: 1, id: VIEWER, name: 'Viewer', kind: 'viewer', viewer: { command: 'serve', url: 'http://127.0.0.1:{port}/' } })
  install({ spec: 1, id: BROKEN, name: 'Broken', engine: 'claude', agent: { skills: ['nothing-here'] } }, { 'nothing-here/README.md': 'no skill\n' })
  install({ spec: 1, id: RENAMED, name: 'Renamed', engine: 'claude', formerly: ['acme/old-name'], agent: { instructions: 'AGENTS.md' } },
    { 'AGENTS.md': '# Renamed\n' })
  install({ spec: 1, id: MODEL_MANAGER, name: 'Grid', engine: 'codex', agent: { instructions: 'AGENTS.md' } }, { 'AGENTS.md': '# Grid\n' })
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-launch-shapes-golden-')))
  for (const name of VARS) saved[name] = process.env[name]
  for (const name of VARS) delete process.env[name]
  process.env.ADAPTER_DATA_DIR = join(root, 'data')
  process.env.DSH_DIR = join(root, 'dsh')
  process.env.HOME = join(root, 'home')
  process.env.SHELL = '/bin/zsh'
  process.env.CODEX_HOME = join(root, 'home', '.codex')
  process.env.XDG_CONFIG_HOME = join(root, 'home', '.config')
  process.env.XDG_DATA_HOME = join(root, 'home', '.local', 'share')
  process.env.ZDOTDIR = join(root, 'zdotdir')
  for (const dir of ['data', 'zdotdir', 'home/.codex', 'dsh']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'zdotdir', '.zshrc'), '')
  vi.resetModules()
  const { launchShapes } = await import('../testing/launchShapes.js')
  invalidate = (await import('../dsh/installed.js')).invalidateInstalledDsh
  shapes = (gridName = null) => launchShapes({
    dataDir: join(root, 'data'), machine: () => ({ ...M1 }), tmuxSupportsSessionEnv: async () => pane.tmux,
    readCodexConfig: () => null, setGridLaunch: () => {}, gridName: () => gridName,
  })
})

afterAll(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  rmSync(root, { recursive: true, force: true })
  vi.resetModules()
})

/** What was logged while `run` ran. */
async function logged<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = []
  const keep = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  const log = vi.spyOn(console, 'log').mockImplementation(keep)
  const warn = vi.spyOn(console, 'warn').mockImplementation(keep)
  try { return { value: await run(), lines } } finally { log.mockRestore(); warn.mockRestore() }
}
const home = (): unknown => tree(join(root, 'home'))
/** A home whose Claude Code and Codex have been run before: each keeps its folder trust in a file it made. */
const resetHome = (): void => {
  rmSync(join(root, 'home'), { recursive: true, force: true })
  write(join(root, 'home', '.claude.json'), '{\n  "projects": {}\n}\n')
  write(join(root, 'home', '.codex', 'config.toml'), 'model = "gpt-5"\n')
}
/** The pane a launch asked for, as far as a harness has a say in it. */
const paneOf = (call: Record<string, unknown> | undefined): unknown => call ? {
  argv: call.argv, script: scriptOf(call.argv), sessionLabel: call.sessionLabel, env: call.env, dsh: call.dsh, dshRuntime: call.dshRuntime, label: call.label,
  permissionMode: call.permissionMode, bypassPermission: call.bypassPermission, grid: call.grid,
} : null

// ------------------------------------------------------------------------------------------------ create

const pending = { agentId: 'created', sessionId: '', engine: 'claude' } as RegisteredSession
const gridSetups: string[] = []
const createRest = (privateGrid: string | null) => ({
  tmuxBackend: {} as never, registry: { setLaunch: () => pending } as never,
  adoptableSession: async () => ({ ok: false, error: 'UNUSED' }) as never, heldBy: async () => 'none' as const, takeOverWhenIdle: async () => {},
  watchNewPane: (async () => {}) as never, announceSession: () => {}, attachDsh: () => {}, hookPort: 4242, hooksDisabled: true,
  installOpencodePlugin: async () => true, terminalHintMachineName: () => 'this-mac', blocksFolder: () => false,
  gridSetup: () => async (request: { ownGrid: boolean }) => { gridSetups.push(`ensure ownGrid=${request.ownGrid}`); return {} as never },
  privateGridName: async () => privateGrid,
})

async function createCase(engine: AgentEngine, dsh: string, options: { files?: Record<string, string>; grid?: GridLaunchOverride; privateGrid?: string } = {}): Promise<unknown> {
  pane.calls.length = 0
  init.calls.length = 0
  gridSetups.length = 0
  resetHome()
  const cwd = work(options.files)
  const { value, lines } = await logged(() => shapes().create(createRest(options.privateGrid ?? null) as never)({
    engine, cwd, bypassPermission: false, permissionMode: null, grid: options.grid ?? null, codexHome: null, dsh, prompt: null, name: null,
    agent: null, resumeSessionId: null, takeOver: null,
  } as never))
  return norm({
    result: value, pane: paneOf(pane.calls[0]), init: [...init.calls], gridSetup: [...gridSetups], folder: tree(cwd), home: home(),
    logged: lines.filter((line) => /dsh|harness|refused|grid/i.test(line)),
  })
}

async function createCases(): Promise<Record<string, unknown>> {
  const cases: Record<string, unknown> = {}
  for (const engine of PROCESS_ENGINES) cases[`${engine} · a harness in an empty folder`] = await createCase(engine, DRAW)
  cases['claude · a folder with work in it'] = await createCase('claude', DRAW, { files: { 'README.md': '# Mine\n', 'CLAUDE.md': '# My rules\n' } })
  cases['codex · a folder already laid out'] = await createCase('codex', DRAW, { files: { '.draw-ready': 'ready\n', 'AGENTS.md': '# Ours\n' } })
  cases['codex · a package with nothing but an engine'] = await createCase('codex', BARE)
  cases['claude · the account\'s private grid'] = await createCase('claude', DRAW, { privateGrid: 'grid-of-mine' })
  cases['claude · on a grid too'] = await createCase('claude', DRAW, { grid: GRID })
  cases['codex · the Model Manager'] = await createCase('codex', MODEL_MANAGER)
  init.code = 2
  cases['claude · an init that fails'] = await createCase('claude', DRAW)
  init.code = null
  init.timedOut = true
  cases['claude · an init that runs out of time'] = await createCase('claude', DRAW)
  init.code = 0
  init.timedOut = false
  cases['claude · a skill folder with no skill'] = await createCase('claude', BROKEN)
  cases['claude · a viewer package'] = await createCase('claude', VIEWER)
  cases['claude · a package not installed'] = await createCase('claude', 'acme/missing')
  cases['terminal · a harness'] = await createCase('terminal', DRAW)
  pane.tmux = false
  cases['claude · an old tmux'] = await createCase('claude', DRAW)
  pane.tmux = true
  return cases
}

// ---------------------------------------------------------------------------------------------- relaunch

const session = (engine: AgentEngine, over: Partial<RegisteredSession> = {}): RegisteredSession => ({
  agentId: `agent-${engine}`, sessionId: 's', engine, cwd: work(), gridLaunch: null, codexHome: null, dsh: DRAW, dshRuntime: null, agent: null,
  scmLaunch: null, ...over,
}) as unknown as RegisteredSession

async function relaunchCase(s: RegisteredSession, options: { gridName?: string; source?: Parameters<Shapes['relaunch']>[1]; before?: () => Promise<void> | void } = {}): Promise<unknown> {
  await options.before?.()
  const { value, lines } = await logged(() => shapes(options.gridName ?? null).relaunch(s, options.source))
  return norm({ result: value, folder: s.cwd ? tree(s.cwd) : null, logged: lines.filter((line) => /dsh|harness|refused|grid/i.test(line)) })
}

async function relaunchCases(): Promise<Record<string, unknown>> {
  const cases: Record<string, unknown> = {}
  for (const engine of PROCESS_ENGINES) cases[`${engine} · restart a harness agent`] = await relaunchCase(session(engine))
  {
    // A session's runtime is its own: a package updated since does not change what it was created with.
    const s = session('claude', { dshRuntime: 'created-1' })
    await shapes().relaunch(s)
    cases['claude · restart after the package changed'] = await relaunchCase(s, {
      before: () => { write(join(root, 'dsh', 'acme', 'draw', 'AGENTS.md'), '# Make a painting\n') },
    })
    write(join(root, 'dsh', 'acme', 'draw', 'AGENTS.md'), DRAW_FILES['AGENTS.md'])
  }
  cases['claude · the account\'s private grid'] = await relaunchCase(session('claude'), { gridName: 'grid-of-mine' })
  cases['claude · on a grid too'] = await relaunchCase(session('claude', { gridLaunch: GRID }))
  cases['claude · a package that was renamed'] = await relaunchCase(session('claude', { dsh: 'acme/old-name' }))
  cases['codex · a package with nothing but an engine'] = await relaunchCase(session('codex', { dsh: BARE }))
  cases['claude · a package not installed'] = await relaunchCase(session('claude', { dsh: 'acme/missing' }))
  cases['claude · no workspace on record'] = await relaunchCase(session('claude', { cwd: null } as Partial<RegisteredSession>))
  {
    const s = session('claude')
    await shapes().relaunch(s)
    cases['claude · a bootstrap edited by hand'] = await relaunchCase(s, {
      before: () => { write(join(s.cwd!, 'CLAUDE.md'), readFileSync(join(s.cwd!, 'CLAUDE.md'), 'utf8').replace('<!-- harness:runtime v1 -->', '<!-- harness:runtime edited -->')) },
    })
  }
  {
    // The runtime a claude session made, asked for by a codex one.
    const cwd = work()
    await shapes().relaunch(session('claude', { cwd, dshRuntime: 'shared' }))
    cases['codex · a runtime that belongs to another engine'] = await relaunchCase(session('codex', { cwd, dshRuntime: 'shared' }))
  }
  cases['claude · a skill folder with no skill'] = await relaunchCase(session('claude', { dsh: BROKEN }))
  // Retarget hands the override it just resolved, and the harness still comes from the row.
  cases['claude · retarget onto a grid'] = await relaunchCase(session('claude'), { source: { gridLaunch: GRID } })
  return cases
}

// -------------------------------------------------------------------------------------------------- fork

const mirror = { isBusy: () => false, recentAsks: () => [], recent: () => [], lastFullText: () => undefined }
const forkRest = (source: RegisteredSession) => ({
  tmuxBackend: {} as never, registry: { byAgent: (id: string) => (id === source.agentId ? source : undefined) } as never, mirror: mirror as never,
  pendingForkInherit: new Map<string, string>(), watchNewPane: (async () => {}) as never, announceSession: () => {}, attachDsh: () => {},
})

async function forkCase(source: RegisteredSession, options: { gridName?: string; before?: () => Promise<void> | void } = {}): Promise<unknown> {
  pane.calls.length = 0
  await options.before?.()
  const { value, lines } = await logged(() => shapes(options.gridName ?? null).fork(forkRest(source))({ agentId: source.agentId, name: null, prompt: null }))
  return norm({
    result: value, pane: paneOf(pane.calls[0]), folder: source.cwd ? tree(source.cwd) : null,
    logged: lines.filter((line) => /dsh|harness|refused|grid|fork/i.test(line)),
  })
}

async function forkCases(): Promise<Record<string, unknown>> {
  const cases: Record<string, unknown> = {}
  for (const engine of ['claude', 'codex', 'opencode', 'cursor'] as const) {
    const source = session(engine, { dshRuntime: 'source-1' })
    cases[`${engine} · a fork of a harness agent`] = await forkCase(source, { before: async () => { await shapes().relaunch(source) } })
  }
  {
    // Created before rows recorded their runtime: the one under its agent id is the one to copy.
    const source = session('claude')
    cases['claude · a source whose runtime is under its agent id'] = await forkCase(source, { before: async () => { await shapes().relaunch(source) } })
  }
  cases['claude · a source with no runtime yet'] = await forkCase(session('claude'))
  cases['claude · a runtime the row names that is gone'] = await forkCase(session('claude', { dshRuntime: 'gone' }))
  {
    const source = session('claude', { dshRuntime: 'source-2' })
    cases['claude · the account\'s private grid'] = await forkCase(source, { gridName: 'grid-of-mine', before: async () => { await shapes().relaunch(source) } })
  }
  cases['claude · a package no longer installed'] = await forkCase(session('claude', { dsh: 'acme/missing' }))
  return cases
}

type Sections = Record<string, Record<string, unknown>>
const PLATFORMS = ['darwin', 'linux'] as const

async function sectionsOn(platform: (typeof PLATFORMS)[number]): Promise<Sections> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...real, value: platform })
  rmSync(join(root, 'work'), { recursive: true, force: true })
  folders = 0
  installAll()
  try {
    return { create: await createCases(), relaunch: await relaunchCases(), fork: await forkCases() }
  } finally { Object.defineProperty(process, 'platform', real) }
}

describe('every launch of a harness package starts as it did before the Store prepared it', () => {
  it('create, relaunch and fork match the record, on darwin and linux', async () => {
    const darwin = await sectionsOn('darwin')
    const linux = await sectionsOn('linux')
    const linuxDiffers = Object.fromEntries(Object.entries(linux).map(([section, cases]) => [section,
      Object.fromEntries(Object.entries(cases).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(darwin[section]![key])))]))
    const used = Object.fromEntries(Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b)))
    if (RECORD) {
      const block = (cases: Record<string, unknown>): string => Object.entries(cases).map(([key, value]) => ` ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(',\n')
      const sections = (all: Sections): string => Object.entries(all).map(([section, cases]) => `${JSON.stringify(section)}: {\n${block(cases)}\n}`).join(',\n')
      writeFileSync(GOLDEN, `{\n${sections(darwin)},\n"linux": {\n${sections(linuxDiffers)}\n},\n"scripts": {\n${block(used)}\n}\n}\n`)
      return
    }
    const { linux: linuxGolden, scripts: scriptsGolden, ...darwinGolden } = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Sections & { linux: Sections; scripts: Record<string, string> }
    expect(Object.keys(used)).toEqual(Object.keys(scriptsGolden))
    for (const [digest, text] of Object.entries(scriptsGolden)) expect(used[digest], `script ${digest}`).toEqual(text)
    for (const [platform, actual, golden] of [
      ['darwin', darwin, darwinGolden],
      ['linux', linux, Object.fromEntries(Object.entries(darwinGolden).map(([section, cases]) => [section, { ...cases, ...linuxGolden[section] }]))],
    ] as const) {
      expect(Object.keys(actual), platform).toEqual(Object.keys(golden))
      for (const [section, cases] of Object.entries(golden)) {
        expect(Object.keys(actual[section]!).sort(), `${platform} · ${section}`).toEqual(Object.keys(cases).sort())
        for (const [key, value] of Object.entries(cases)) expect(actual[section]![key], `${platform} · ${section} · ${key}`).toEqual(value)
      }
    }
  }, 240_000)

  it('records no machine-specific path', () => {
    const text = readFileSync(GOLDEN, 'utf8')
    expect(text).not.toContain('dsh-launch-shapes-golden-')
    expect(text).not.toContain(root)
    expect(text).not.toMatch(/\/Users\/|\/home\/runner/)
  })
})
