/**
 * What every launch of an engine hands tmux, byte for byte: the pane's argv, the script a POSIX login shell
 * sources from its one-time file, the engine's own command, and the environment, extra argv and cleared
 * variables a relaunch is built with. Recorded from the launch code as it stood before Claude Code's and
 * Codex's launch specifics became declared data on their launch contracts, applied by the kit
 * (docs/design/2026-10-08-engine-launch.md): the Codex pane script's owned-process probe and startup retry,
 * its own-login provider, and the two engines' harness context and environment flags.
 *
 * The shapes are the callers': create (a first prompt, a harness, a grid, an install when missing), the
 * adoption of a terminal's conversation (resume, waiting out its turn), fork, restart and its fresh fallback,
 * restore, resume, retarget onto a grid, every permission mode, a Codex profile (CODEX_HOME), a moved engine
 * home, an engine at an overridden path (npm's Codex wrapper), a remote Codex server's flag passed through,
 * every login shell family, with and without the daemon's tmux. Every other engine is recorded in the common
 * shapes too, since they share the wrapper.
 *
 * Paths that differ between machines are written as placeholders (`<home>`, `<data>`, `<daemon-node>`, the
 * one-time file's name). What the launch says differs by platform (a folder the shell cannot read names macOS's
 * privacy settings, else the folder's permissions), so every case is recorded on darwin and on linux, with
 * `process.platform` pinned, whichever machine runs the spec: linux's cases are stored where they differ. A script is kept once, by its hash, since most shapes differ only in argv, and as
 * runs of a table of its distinct lines: the 170 scripts share 243 lines. A command that is the end of its
 * argv is kept as its length. Each case is compared as full text, so a failure shows the script itself.
 *
 * `RECORD_LAUNCH_GOLDEN=1` writes the fixture. Record it again only for a change meant to alter what a launch
 * hands tmux, and say so in that change.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { env } from '../config/env.js'
import { harnessAdapter, HARNESS_ADAPTERS } from '../dsh/adapters.js'
import { DSH_SESSION_ENV, harnessEnvToClear } from '../dsh/launch.js'
import { baseNode } from '../harnessd/baseNode.js'
import { engineInstallRecipe } from '../lib/engineInstall.js'
import {
  buildEngineCommandArgv, buildEngineLaunchArgv, PERMISSION_MODES, supportsFirstPrompt, type LaunchCommandOptions,
} from '../lib/engineLaunch.js'
import { GRID_CONFLICTING_ENV_VARS, type GridLaunchOverride } from '../lib/gridLaunch.js'
import { buildLaunchOverrides, type LaunchOverridesDeps, type LaunchSource } from '../lib/launchOverrides.js'
import { ENGINES, type AgentEngine } from './types.js'

const GOLDEN = fileURLToPath(new URL('./__fixtures__/launch-argv.golden.json', import.meta.url))
const RECORD = process.env.RECORD_LAUNCH_GOLDEN === '1'

const SHELLS = {
  zsh: '/bin/zsh', bash: '/bin/bash', sh: '/bin/sh', ksh: '/bin/ksh', fish: '/opt/homebrew/bin/fish', tcsh: '/bin/tcsh',
  // No login shell the daemon can use: a plain engine runs as its bare command.
  none: '', relative: 'zsh',
} as const
type Shell = keyof typeof SHELLS
const TMUX = { tmux: '/opt/homebrew/bin/tmux', none: null, relative: 'tmux' } as const
type Tmux = keyof typeof TMUX
const RUNTIME_NODE = '/opt/harness/runtime/node-v22/bin/node'
const GRID_BIN = { bare: 'grid', managed: '/opt/harness/runtime/grid/bin/grid' } as const

const PROMPT = `Fix the "parser" — it's broken; $HOME stays literal, as does \`date\` and a 'quote' ✓`
const GRID_ARGS = ['-c', 'model_providers.grid.base_url="https://grid.example/relay/v1"', '-m', 'gpt-5']
const REMOTE_ARGS = ['--remote', 'ws://127.0.0.1:4500']
const CWD = "/work/my project's folder"
const CLEAR_GRID = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', ...harnessEnvToClear({})]

/** A caller's options, as each one assembles them (core/agents/create.ts, fork.ts, restart.ts, swap.ts,
 *  lib/resumeAgentService.ts, the restore in core/main.ts). `null` for a shape this engine cannot take. */
function shapes(engine: AgentEngine): Record<string, LaunchCommandOptions | null> {
  const install = engineInstallRecipe(engine)
  const prompt = supportsFirstPrompt(engine)
  return {
    'new': {},
    'new, approving': { bypassPermission: true },
    'new, not approving': { bypassPermission: false },
    'new, a mode the engine lacks': { permissionMode: 'no-such-mode', bypassPermission: true },
    ...Object.fromEntries(Object.keys(PERMISSION_MODES[engine] ?? {}).map((mode) => [`new, mode ${mode}`, { permissionMode: mode }])),
    'first prompt': prompt ? { firstPrompt: PROMPT } : null,
    'resume': { resumeSessionId: 'sess-0001' },
    'resume, approving': { resumeSessionId: 'sess-0001', bypassPermission: true },
    'fork': { forkSessionId: 'src-0001' },
    'fork outranks resume': { forkSessionId: 'src-0001', resumeSessionId: 'sess-0001', bypassPermission: true },
    'fork with a prompt': prompt ? { forkSessionId: 'src-0001', firstPrompt: PROMPT } : null,
    'grid argv': { extraArgs: GRID_ARGS, clearEnv: CLEAR_GRID },
    'remote server argv passed through': { extraArgs: REMOTE_ARGS },
    'install first': { installFirst: 'npm install -g example-engine' },
    'create': {
      bypassPermission: true, permissionMode: Object.keys(PERMISSION_MODES[engine] ?? {})[0], extraArgs: GRID_ARGS,
      installIfMissing: install, clearEnv: CLEAR_GRID, cwd: CWD, harnessNode: true,
      ...(prompt ? { firstPrompt: PROMPT } : {}), terminalHint: { machineName: 'studio-mac' },
    },
    'create, plain': { bypassPermission: true, installIfMissing: install, clearEnv: harnessEnvToClear(undefined), cwd: CWD, terminalHint: { machineName: 'studio-mac' } },
    'adopt, waiting out the turn': {
      bypassPermission: true, resumeSessionId: 'sess-0001', installIfMissing: install, clearEnv: harnessEnvToClear(undefined), cwd: CWD,
      waitForPid: { pid: 4242, name: 'Codex "cli"; rm -rf' },
    },
    'adopt, now, carrying on': prompt ? { bypassPermission: true, resumeSessionId: 'sess-0001', firstPrompt: 'continue', cwd: CWD } : null,
    'fork shape': {
      clearEnv: harnessEnvToClear(undefined), bypassPermission: true, extraArgs: ['-c', 'model_provider="openai"'], installIfMissing: install,
      cwd: CWD, forkSessionId: 'src-0001', ...(prompt ? { firstPrompt: PROMPT } : {}),
    },
    'restart': {
      bypassPermission: true, resumeSessionId: 'sess-0001', cwd: CWD, extraArgs: GRID_ARGS, clearEnv: CLEAR_GRID, harnessNode: true,
    },
    'restart, fresh fallback': { bypassPermission: false, cwd: CWD, extraArgs: GRID_ARGS, clearEnv: CLEAR_GRID },
    'restore': {
      resumeSessionId: 'sess-0001', bypassPermission: true, installIfMissing: install, cwd: CWD,
      extraArgs: ['-c', 'model_provider="openai"'], clearEnv: harnessEnvToClear(undefined), harnessNode: true,
    },
    'resume service': {
      resumeSessionId: 'sess-0001', bypassPermission: false, permissionMode: 'ask', cwd: CWD, clearEnv: harnessEnvToClear(undefined),
      installIfMissing: install,
    },
    'retarget onto a grid': { bypassPermission: true, resumeSessionId: 'sess-0001', cwd: CWD, extraArgs: GRID_ARGS, clearEnv: CLEAR_GRID },
  }
}

interface ArgvRecord { argv?: string[]; command?: string[]; script?: string; throws?: string }
/** One platform's record. */
interface Cases {
  argv: Record<string, ArgvRecord>
  overrides: Record<string, unknown>
  adapters: Record<string, unknown>
}
/** darwin's cases, and linux's where they differ, over one table of scripts. */
interface Golden extends Cases {
  scripts: Record<string, string>
  linux: Cases
}
type StoredArgv = Record<string, Omit<ArgvRecord, 'command'> & { command?: string[] | number }>
/** As stored: scripts as runs of `lines`, and a command that ends its argv as its length. */
interface Stored {
  lines: string[]
  scripts: Record<string, string>
  argv: StoredArgv
  overrides: Record<string, unknown>
  adapters: Record<string, unknown>
  linux: { argv: StoredArgv; overrides: Record<string, unknown>; adapters: Record<string, unknown> }
}

const PLATFORMS = ['darwin', 'linux'] as const
type Platform = (typeof PLATFORMS)[number]

/** Runs `run` with `process.platform` reading `platform`, which the launch reads as it builds the script. */
async function onPlatform<T>(platform: Platform, run: () => T | Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...real, value: platform })
  try { return await run() } finally { Object.defineProperty(process, 'platform', real) }
}

/** The cases of `other` whose record differs from `base`'s. */
function differences<T>(base: Record<string, T>, other: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(other).filter(([name, value]) => JSON.stringify(value) !== JSON.stringify(base[name])))
}

/** A platform's full record: darwin's, with linux's differences over it. */
function casesOn(golden: Golden, platform: Platform): Cases {
  if (platform === 'darwin') return { argv: golden.argv, overrides: golden.overrides, adapters: golden.adapters }
  return {
    argv: { ...golden.argv, ...golden.linux.argv },
    overrides: { ...golden.overrides, ...golden.linux.overrides },
    adapters: { ...golden.adapters, ...golden.linux.adapters },
  }
}

function store(golden: Golden): Stored {
  const lines: string[] = []
  const index = new Map<string, number>()
  const scripts: Record<string, string> = {}
  for (const [hash, text] of Object.entries(golden.scripts).sort(([a], [b]) => a.localeCompare(b))) {
    const ids = text.split('\n').map((line) => {
      if (!index.has(line)) { index.set(line, lines.length); lines.push(line) }
      return index.get(line)!
    })
    const runs: string[] = []
    for (let i = 0; i < ids.length;) {
      let j = i
      while (j + 1 < ids.length && ids[j + 1] === ids[j]! + 1) j++
      runs.push(i === j ? `${ids[i]}` : `${ids[i]}-${ids[j]}`)
      i = j + 1
    }
    scripts[hash] = runs.join(',')
  }
  const compact = (argv: Record<string, ArgvRecord>): StoredArgv => Object.fromEntries(Object.entries(argv).map(([name, value]) => {
    const tail = value.argv && value.command && value.command.length <= value.argv.length
      && JSON.stringify(value.argv.slice(value.argv.length - value.command.length)) === JSON.stringify(value.command)
    return [name, tail ? { ...value, command: value.command!.length } : value]
  }))
  return {
    lines, scripts, argv: compact(golden.argv), overrides: golden.overrides, adapters: golden.adapters,
    linux: { argv: compact(golden.linux.argv), overrides: golden.linux.overrides, adapters: golden.linux.adapters },
  }
}

function load(stored: Stored): Golden {
  const scripts = Object.fromEntries(Object.entries(stored.scripts).map(([hash, runs]) => [hash, runs.split(',').flatMap((run) => {
    const [from, to = from] = run.split('-').map(Number)
    return Array.from({ length: to! - from! + 1 }, (_, k) => stored.lines[from! + k]!)
  }).join('\n')]))
  const expand = (argv: StoredArgv): Record<string, ArgvRecord> => Object.fromEntries(Object.entries(argv).map(([name, value]) => [name, typeof value.command === 'number'
    ? { ...value, command: value.argv!.slice(value.argv!.length - value.command) }
    : value as ArgvRecord]))
  return {
    argv: expand(stored.argv), scripts, overrides: stored.overrides, adapters: stored.adapters,
    linux: { argv: expand(stored.linux.argv), overrides: stored.linux.overrides, adapters: stored.linux.adapters },
  }
}

/** One case a line, so a re-record's diff names the cases it changed. */
function serialize(stored: Stored): string {
  const block = (entries: Array<[string, unknown]>): string => entries.map(([key, value]) => ` ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(',\n')
  return `{\n"lines": [\n${stored.lines.map((line) => ` ${JSON.stringify(line)}`).join(',\n')}\n],\n`
    + `"scripts": {\n${block(Object.entries(stored.scripts))}\n},\n`
    + `"argv": {\n${block(Object.entries(stored.argv))}\n},\n`
    + `"overrides": {\n${block(Object.entries(stored.overrides))}\n},\n`
    + `"adapters": {\n${block(Object.entries(stored.adapters))}\n},\n`
    + `"linux": {\n"argv": {\n${block(Object.entries(stored.linux.argv))}\n},\n`
    + `"overrides": {\n${block(Object.entries(stored.linux.overrides))}\n},\n`
    + `"adapters": {\n${block(Object.entries(stored.linux.adapters))}\n}\n}\n}\n`
}

let root = ''
let dataDir = ''
const saved: Record<string, string | undefined> = {}
const savedEnv: Record<string, string | undefined> = {}
const ENGINE_PATHS = ['CLAUDE_PATH', 'CURSOR_PATH', 'OPENCODE_PATH', 'PI_PATH', 'HERMES_PATH', 'COMMANDCODE_PATH', 'DEVIN_PATH', 'MUSE_PATH',
  'AMP_PATH', 'KILO_PATH', 'GROK_PATH', 'AGY_PATH', 'COPILOT_PATH'] as const
const PROCESS_VARS = ['CODEX_PATH', 'CODEX_HOME', 'ZDOTDIR', 'HARNESS_OS', 'HARNESS_GRID_BIN', 'SHELL'] as const
const config = env as unknown as Record<string, string | undefined>

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'launch-golden-'))
  dataDir = join(root, 'data')
  mkdirSync(dataDir)
  saved.ADAPTER_DATA_DIR = env.ADAPTER_DATA_DIR
  saved.CODEX_HOME = env.CODEX_HOME
  env.ADAPTER_DATA_DIR = dataDir
  env.CODEX_HOME = join(homedir(), '.codex')
  for (const name of ENGINE_PATHS) { savedEnv[`config:${name}`] = config[name]; config[name] = undefined }
  for (const name of PROCESS_VARS) { savedEnv[name] = process.env[name]; delete process.env[name] }
  // A zsh user with a startup file of their own: the plain launch. The new-user guard has its own shape below.
  const zdotdir = join(root, 'zdotdir')
  mkdirSync(zdotdir)
  writeFileSync(join(zdotdir, '.zshrc'), '')
  process.env.ZDOTDIR = zdotdir
})

afterAll(() => {
  env.ADAPTER_DATA_DIR = saved.ADAPTER_DATA_DIR!
  env.CODEX_HOME = saved.CODEX_HOME!
  for (const name of ENGINE_PATHS) config[name] = savedEnv[`config:${name}`]
  for (const name of PROCESS_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
  rmSync(root, { recursive: true, force: true })
})

/** The POSIX shell a launch with no login shell of its own runs its script in (engineLaunch.ts `posixRunner`). */
const posixRunner = (): string => existsSync('/bin/dash') ? '/bin/dash' : '/bin/sh'

function placeholders(text: string): string {
  const node = baseNode(process.execPath)
  // Quoted, as every script quotes them: a Node in /usr/bin must not turn `/usr/bin/env` into a placeholder.
  return text
    .split(`'${node}'`).join("'<daemon-node>'")
    .split(`'${dirname(node)}'`).join("'<daemon-node-dir>'")
    .split(dataDir).join('<data>')
    .split(root).join('<root>')
    .split(homedir()).join('<home>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sh/g, '<one-time>.sh')
    .split(`exec ${posixRunner()} '`).join("exec <posix-runner> '")
}

/** The script a launch's argv names, from its one-time file, and the argv with the file's name as a placeholder. */
function record(argv: string[], scripts: Record<string, string>, noLoginShell: boolean): ArgvRecord {
  const out = argv.map((arg, index) => index === 0 && noLoginShell && arg === posixRunner() ? '<posix-runner>' : placeholders(arg))
  let script: string | undefined
  for (const arg of argv) {
    const sourced = /^\. '(.+)'$/s.exec(arg)?.[1] ?? /^exec \S+ '(.+)'$/s.exec(arg)?.[1]
    if (sourced) script = readFileSync(sourced.replace(/'"'"'/g, "'"), 'utf8')
  }
  if (script === undefined) {
    // On the command line: a direct `-c` script (no data folder, or a shell given its script inline).
    const flag = argv.findIndex((arg) => arg === '-lic' || arg === '-ic' || arg === '-c')
    if (flag >= 0 && argv[flag + 1] !== undefined && !/^\. '/.test(argv[flag + 1]!)) script = argv[flag + 1]
  }
  if (script === undefined) return { argv: out }
  const text = placeholders(script)
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16)
  scripts[hash] = text
  return { argv: out.map((arg) => arg === placeholders(script!) ? `<script ${hash}>` : arg), script: hash }
}

function launch(engine: AgentEngine, opts: LaunchCommandOptions, shell: Shell, tmux: Tmux, grid: keyof typeof GRID_BIN, scripts: Record<string, string>): ArgvRecord {
  try {
    const argv = buildEngineLaunchArgv(engine, opts, SHELLS[shell], RUNTIME_NODE, GRID_BIN[grid], TMUX[tmux])
    const command = buildEngineCommandArgv(engine, opts).map(placeholders)
    return { ...record(argv, scripts, shell === 'none' || shell === 'relative'), command }
  } catch (error) {
    return { throws: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
  }
}

/** Runs `run` with these variables set (`config:` names the daemon's settings), and puts them back once it
 *  has settled: a relaunch reads the moved home after its first await. */
function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
  const before: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(vars)) {
    if (name.startsWith('config:')) {
      const key = name.slice('config:'.length)
      before[name] = config[key]
      config[key] = value
    } else {
      before[name] = process.env[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  const restore = (): void => {
    for (const [name, value] of Object.entries(before)) {
      if (name.startsWith('config:')) config[name.slice('config:'.length)] = value
      else if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  let result: T
  try { result = run() } catch (error) { restore(); throw error }
  if (result instanceof Promise) return result.finally(restore) as T
  restore()
  return result
}

function argvCases(scripts: Record<string, string>): Record<string, ArgvRecord> {
  const cases: Record<string, ArgvRecord> = {}
  // Claude Code and Codex in every caller's shape, every other engine in the common ones, from zsh with the
  // daemon's tmux.
  const common = new Set(['new', 'new, approving', 'first prompt', 'resume', 'fork', 'create', 'adopt, waiting out the turn', 'restart'])
  for (const engine of ENGINES) {
    for (const [name, opts] of Object.entries(shapes(engine))) {
      if (!opts || (engine !== 'claude' && engine !== 'codex' && !common.has(name) && !name.startsWith('new, mode '))) continue
      cases[`${engine} · ${name} · zsh · tmux`] = launch(engine, opts, 'zsh', 'tmux', 'bare', scripts)
    }
  }
  // Claude Code and Codex in every shell family, with and without a usable tmux, plain and as created.
  for (const engine of ['claude', 'codex'] as const) {
    const all = shapes(engine)
    for (const shell of Object.keys(SHELLS) as Shell[]) {
      for (const tmux of Object.keys(TMUX) as Tmux[]) {
        for (const shape of ['new', 'create', 'restart']) {
          cases[`${engine} · ${shape} · ${shell} · ${tmux}`] ??= launch(engine, all[shape]!, shell, tmux, 'bare', scripts)
        }
      }
    }
    for (const shape of ['new', 'create']) cases[`${engine} · ${shape} · zsh · tmux · managed grid`] = launch(engine, all[shape]!, 'zsh', 'tmux', 'managed', scripts)
    for (const shape of Object.keys(all)) {
      if (all[shape]) cases[`${engine} · ${shape} · bash · no tmux`] = launch(engine, all[shape]!, 'bash', 'none', 'bare', scripts)
    }
    // An engine at a path of the person's choosing; for Codex, npm's Node wrapper.
    const override = engine === 'claude'
      ? { 'config:CLAUDE_PATH': '/opt/claude code/bin/claude' }
      : { CODEX_PATH: '/usr/local/lib/node_modules/@openai/codex/bin/codex.js' }
    for (const shape of ['new', 'resume', 'fork', 'restart']) {
      cases[`${engine} · ${shape} · zsh · tmux · engine at its own path`] = withEnv(override, () => launch(engine, all[shape]!, 'zsh', 'tmux', 'bare', scripts))
    }
    // zsh's new-user menu kept out: no startup file in ZDOTDIR, so Harness's own .zshenv goes first.
    const emptyZdotdir = join(root, 'zdotdir-empty')
    mkdirSync(emptyZdotdir, { recursive: true })
    for (const shape of ['new', 'create']) {
      cases[`${engine} · ${shape} · zsh · tmux · zsh new user`] = withEnv({ ZDOTDIR: emptyZdotdir }, () => launch(engine, all[shape]!, 'zsh', 'tmux', 'bare', scripts))
    }
    // No data folder to write a one-time file in: the script goes on the command line.
    for (const shape of ['new', 'create']) {
      const savedDir = env.ADAPTER_DATA_DIR
      env.ADAPTER_DATA_DIR = '/dev/null/no-data-folder'
      try { cases[`${engine} · ${shape} · bash · tmux · no data folder`] = launch(engine, all[shape]!, 'bash', 'tmux', 'bare', scripts) }
      finally { env.ADAPTER_DATA_DIR = savedDir }
    }
  }
  // A terminal tile: no engine, the person's shell with its banner.
  for (const shell of ['zsh', 'bash', 'fish', 'none'] as Shell[]) {
    cases[`terminal · new tile · ${shell}`] = launch('terminal', { cwd: CWD, terminalHint: { machineName: 'studio-mac' }, clearEnv: harnessEnvToClear(undefined) }, shell, 'tmux', 'bare', scripts)
  }
  return cases
}

const GRID: GridLaunchOverride = {
  networkId: 'grid-abc', networkName: 'Team grid', baseUrl: 'https://grid.example/grid-abc/relay/v1', apiKey: 'gridkey-abc123', model: 'gpt-5',
}
const GRID_FULL: GridLaunchOverride = { ...GRID, mcpUrl: 'https://control.example/v1/grid/web-mcp/', contextWindow: 131072 }
const API: GridLaunchOverride = { networkId: 'api:openrouter', networkName: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-1', model: 'qwen/qwen3-coder' }

/** Codex `config.toml`s a relaunch reads its own provider from. */
const CODEX_CONFIGS: Record<string, string | null> = {
  'no config': null,
  'its own provider': 'model_provider = "azure"\n',
  'single quotes and a comment': "model = 'gpt-5'\nmodel_provider = 'local' # mine\n",
  'only under a profile': '[profiles.work]\nmodel_provider = "work"\n',
  'commented out': '# model_provider = "azure"\n',
  'empty value': 'model_provider = ""\n',
  'a quote in single quotes': `model_provider = 'a"b'\n`,
}

async function overridesCases(): Promise<Record<string, unknown>> {
  const cases: Record<string, unknown> = {}
  const run = async (engine: AgentEngine, source: LaunchSource, config: string | null = null, deps: Partial<LaunchOverridesDeps> = {}) => {
    const calls: string[] = []
    const result = await buildLaunchOverrides({
      machine: () => ({ hermesSystemManaged: false, opencodeMajor: null }),
      writeGridConfigDir: async (key, files) => { calls.push(`writeGridConfigDir ${key} ${files.map((file) => file.name).join(',')}`); return `/state/grid-engine-config/${key}` },
      tmuxSupportsSessionEnv: async () => true,
      installCodexHooks: (home) => { calls.push(`installCodexHooks ${home}`) },
      readCodexConfig: (path) => { calls.push(`readCodexConfig ${path}`); return config },
      dshLaunch: (dsh, workspace, eng, key) => {
        calls.push(`dshLaunch ${dsh} ${workspace} ${eng} ${key}`)
        // As dsh/runtime.ts prepareHarnessLaunch ends: the package's argv, then the engine's context and env flags.
        const launchEnv = { HARNESS_DSH: dsh, HARNESS_WORKSPACE: workspace, HARNESS_CONTEXT_FILE: `${workspace}/.harness/runtime/${key}/CONTEXT.md`, STUDIO_MODE: 'pro "x"' }
        const adapter = harnessAdapter(eng)
        return { env: launchEnv, args: ['--studio', ...(adapter.contextArgs?.(launchEnv.HARNESS_CONTEXT_FILE) ?? []), ...(adapter.envArgs?.(launchEnv) ?? [])] }
      },
      ...deps,
    }, engine, source, 'agent-0001')
    return JSON.parse(placeholders(JSON.stringify({ result, calls })))
  }
  for (const engine of ['claude', 'codex', 'opencode', 'pi'] as const) {
    cases[`${engine} · own login`] = await run(engine, {})
    cases[`${engine} · own login, its model back`] = await run(engine, { subscriptionModel: engine === 'claude' ? 'opus' : 'gpt-5.5' })
    cases[`${engine} · grid`] = await run(engine, { gridLaunch: GRID })
    cases[`${engine} · grid with web tools and a window`] = await run(engine, { gridLaunch: GRID_FULL, subscriptionModel: 'ignored' })
    cases[`${engine} · saved API`] = await run(engine, { gridLaunch: API })
    cases[`${engine} · harness`] = await run(engine, { dsh: 'acme/studio', cwd: '/work/studio', dshRuntime: 'harness-runtime-1' })
    cases[`${engine} · harness without a workspace`] = await run(engine, { dsh: 'acme/studio', cwd: null })
    cases[`${engine} · harness on a grid, as git, as a named agent`] = await run(engine, { gridLaunch: GRID, dsh: 'acme/studio', cwd: '/work/studio', scmLaunch: { kind: 'git' }, agent: 'harness-compute' })
  }
  for (const [name, config] of Object.entries(CODEX_CONFIGS)) {
    cases[`codex · own login · ${name}`] = await run('codex', {}, config)
    cases[`codex · profile · ${name}`] = await run('codex', { codexHome: '/profiles/work' }, config)
    cases[`codex · profile, its model back · ${name}`] = await run('codex', { codexHome: '/profiles/work', subscriptionModel: 'gpt-5.5' }, config)
    cases[`codex · profile on a grid · ${name}`] = await run('codex', { codexHome: '/profiles/work', gridLaunch: GRID }, config)
  }
  // The home the person's shell moves Codex to, as the daemon reads it at launch (lib/engineHomes.ts launchCodexHome).
  for (const [name, moved] of Object.entries({ 'moved home': '/moved/codex', 'moved home, relative': 'relative/codex', 'moved home, tilde': '~/codex', 'moved home, trailing slash': '/moved/codex/' })) {
    cases[`codex · own login · ${name}`] = await withEnv({ CODEX_HOME: moved }, () => run('codex', {}, 'model_provider = "moved"\n'))
    cases[`codex · profile · ${name}`] = await withEnv({ CODEX_HOME: moved }, () => run('codex', { codexHome: '/profiles/work' }, null))
  }
  // The real file, read from the daemon's own Codex home and from a profile.
  const daemonHome = env.CODEX_HOME
  mkdirSync(daemonHome, { recursive: true })
  writeFileSync(join(daemonHome, 'config.toml'), 'model_provider = "from-file"\n')
  const profile = join(root, 'profile-home')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'config.toml'), "model_provider = 'profile-file'\n")
  cases['codex · own login · the daemon home\'s file'] = await run('codex', {}, null, { readCodexConfig: undefined })
  cases['codex · profile · the profile\'s file'] = await run('codex', { codexHome: profile }, null, { readCodexConfig: undefined })
  cases['codex · profile without a file'] = await run('codex', { codexHome: join(root, 'no-such-profile') }, null, { readCodexConfig: undefined })
  rmSync(join(daemonHome, 'config.toml'))
  return cases
}

function adapterCases(): Record<string, unknown> {
  const contextFile = '/work/my "studio"/.harness/runtime/agent-1/CONTEXT.md'
  const sessionEnv: Record<string, string> = {
    HARNESS_DSH: 'acme/studio', HARNESS_CONTEXT_FILE: contextFile, HARNESS_SKILLS_DIR: '/work/.harness/skills',
    STUDIO_MODE: 'say "hi"\n\ttab \\ back', UNICODE: 'café ✓ 🎉', EMPTY: '', 'BAD-NAME': 'x', '1LEADING': 'y', 'a.b': 'z', _under: 'u',
  }
  return Object.fromEntries(Object.keys(HARNESS_ADAPTERS).map((engine) => {
    const adapter = HARNESS_ADAPTERS[engine as keyof typeof HARNESS_ADAPTERS]
    return [engine, {
      instructionFiles: adapter.instructionFiles,
      contextArgs: 'contextArgs' in adapter && adapter.contextArgs ? adapter.contextArgs(contextFile) : null,
      envArgs: 'envArgs' in adapter && adapter.envArgs ? adapter.envArgs(sessionEnv) : null,
      envArgsEmpty: 'envArgs' in adapter && adapter.envArgs ? adapter.envArgs({}) : null,
    }]
  }))
}

describe('every launch hands tmux what it did before Claude Code and Codex declared their launches', () => {
  it('argv, scripts, relaunch overrides and harness adapter flags match the record', async () => {
    const scripts: Record<string, string> = {}
    const run = (platform: Platform): Promise<Cases> => onPlatform(platform, async () => ({
      argv: argvCases(scripts), overrides: await overridesCases(), adapters: adapterCases(),
    }))
    const darwin = await run('darwin')
    const linux = await run('linux')
    const actual: Golden = {
      ...darwin,
      scripts: Object.fromEntries(Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b))),
      linux: { argv: differences(darwin.argv, linux.argv), overrides: differences(darwin.overrides, linux.overrides), adapters: differences(darwin.adapters, linux.adapters) },
    }
    if (RECORD) {
      writeFileSync(GOLDEN, serialize(store(actual)))
      return
    }
    const golden = load(JSON.parse(readFileSync(GOLDEN, 'utf8')) as Stored)
    // The stored form loses nothing.
    expect(load(store(actual))).toEqual(actual)
    // Compared piece by piece, so a failure names the platform and the case.
    for (const platform of PLATFORMS) {
      const got = casesOn(actual, platform)
      const want = casesOn(golden, platform)
      expect(Object.keys(got.argv).sort(), platform).toEqual(Object.keys(want.argv).sort())
      for (const [name, value] of Object.entries(want.argv)) {
        const mine = got.argv[name]!
        expect({ ...mine, script: mine.script && actual.scripts[mine.script] }, `${platform} · ${name}`)
          .toEqual({ ...value, script: value.script && golden.scripts[value.script] })
      }
      for (const [name, value] of Object.entries(want.overrides)) expect(got.overrides[name], `${platform} · ${name}`).toEqual(value)
      expect(Object.keys(got.overrides).sort(), platform).toEqual(Object.keys(want.overrides).sort())
      expect(got.adapters, platform).toEqual(want.adapters)
    }
    expect(actual.scripts).toEqual(golden.scripts)
  }, 120_000)

  it('records no machine-specific path', () => {
    const text = readFileSync(GOLDEN, 'utf8')
    expect(text).not.toContain(homedir())
    expect(text).not.toContain(tmpdir())
    expect(text).not.toMatch(/\/Users\/[^<]/)
    for (const name of DSH_SESSION_ENV) expect(text).toContain(name)
    expect(text).toContain(GRID_CONFLICTING_ENV_VARS[0]!)
  })
})
