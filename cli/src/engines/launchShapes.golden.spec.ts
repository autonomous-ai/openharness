/**
 * Every launch shape that carries a grid model or a saved API, answer for answer: recorded from the code as it stood
 * before the models service built those launches for the core (docs/design/2026-10-08-launch-port.md, (L1)). For
 * each engine, it records what a create, a relaunch (restart, resume, restore), a fork and a retarget start the pane
 * with: the argv, the environment, the variables cleared, the row's launch record. It also records the config files
 * written for an engine that reads its provider from a file, the saved-API instructions an agent's folder gets, the
 * log lines and every refusal. It covers what the socket asks of a saved API, the variables a pane leaving a grid
 * has cleared, and the engines a picker may offer a grid model to.
 *
 * Each case runs with `process.platform` pinned to darwin and to linux, and linux's are stored where they differ.
 * Local time is pinned. The home folder, the data folder and the saved API's address are the spec's own, and no
 * size depends on their paths.
 *
 * `RECORD_LAUNCH_SHAPES_GOLDEN=1` writes the fixture. Record it again only for a change meant to alter a launch,
 * and say so in that change.
 */
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ENGINES, type AgentEngine } from './types.js'
import { baseNode } from '../harnessd/baseNode.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { GridLaunchOverride } from '../lib/gridLaunch.js'

process.env.TZ = 'America/New_York'

// The pane itself, and the probes of this machine's binaries: the launch is what is recorded, never a spawn.
const pane = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, tmux: true }))
vi.mock('../lib/createAgentPane.js', () => ({
  createAndRegisterPane: vi.fn(async (input: Record<string, unknown>) => {
    pane.calls.push(input)
    return { ok: false, error: 'RECORDED', detail: 'the pane is not opened by this spec' }
  }),
}))
vi.mock('../lib/tmuxVersion.js', async (real) => ({ ...await real<object>(), tmuxSupportsSessionEnv: vi.fn(async () => pane.tmux) }))
vi.mock('../engines/opencode/version.js', async (real) => ({ ...await real<object>(), opencodeMajorVersion: vi.fn(() => 2) }))
vi.mock('../lib/engineBin.js', async (real) => ({ ...await real<object>(), enginePathOverride: vi.fn(() => null) }))

const GOLDEN = fileURLToPath(new URL('./__fixtures__/launch-shapes.golden.json', import.meta.url))
const RECORD = process.env.RECORD_LAUNCH_SHAPES_GOLDEN === '1'

let root = ''
let server: Server
let apiBase = ''
let port = ''
const saved: Record<string, string | undefined> = {}
/** The variables a launch reads of the daemon's own environment, each pinned (or cleared) for the record. */
const VARS = ['ADAPTER_DATA_DIR', 'HOME', 'ZDOTDIR', 'SHELL', 'CODEX_HOME', 'CODEX_PATH', 'HARNESS_OS', 'HARNESS_GRID_BIN', 'CLAUDE_PATH', 'CURSOR_PATH',
  'OPENCODE_PATH', 'PI_PATH', 'HERMES_PATH', 'COMMANDCODE_PATH', 'DEVIN_PATH', 'MUSE_PATH', 'AMP_PATH', 'KILO_PATH', 'GROK_PATH', 'AGY_PATH', 'COPILOT_PATH'] as const
/** The launch scripts the cases name, by digest: most shapes share theirs with others. */
const scripts: Record<string, string> = {}
type Shapes = ReturnType<typeof import('../testing/launchShapes.js')['launchShapes']>
let shapes: (machine: { hermesSystemManaged: boolean; opencodeMajor?: number | null }) => Shapes

const GRID: GridLaunchOverride = {
  networkId: 'net-home', networkName: 'Home', baseUrl: 'https://grid.example/g/home/relay/v1', apiKey: 'grid-key-1', model: 'qwen3-coder',
  mcpUrl: 'https://control.example/v1/grid/web-mcp/', contextWindow: 131072,
}
const BARE: GridLaunchOverride = { networkId: 'net-home', networkName: 'Home', baseUrl: 'https://grid.example/g/home/relay/v1', apiKey: 'grid-key-2' }
const api = (connection: string, model = 'vendor/model-a'): GridLaunchOverride => ({
  networkId: `api:${connection}`, networkName: 'Router', baseUrl: apiBase, apiKey: 'stale-key', model, contextWindow: 200000,
})
const M1 = { hermesSystemManaged: false, opencodeMajor: 2 }
const M2 = { hermesSystemManaged: true, opencodeMajor: 1 }

/** The machine's own parts of a text, as placeholders: the spec's folders, the API's port, this node. */
const placeheld = (text: string, label?: string): string => {
  const node = baseNode(process.execPath)
  // Quoted, as every script quotes them: a Node in /usr/bin must not turn `/usr/bin/env` into a placeholder.
  let out = text.split(`'${node}'`).join("'<daemon-node>'").split(`'${dirname(node)}'`).join("'<daemon-node-dir>'")
    .split(root).join('<root>').split(`127.0.0.1:${port}`).join('127.0.0.1:<port>')
    .replace(/\/launch\/[0-9a-f-]{36}\.sh/g, '/launch/<script>.sh')
  if (label) out = out.split(label).join('<label>')
  return out
}
const norm = (value: unknown, label?: string): unknown => value === undefined ? '<undefined>' : JSON.parse(placeheld(JSON.stringify(value), label))
/** The script a launch's argv sources, kept once by its digest. */
function scriptOf(argv: unknown, label?: string): string | null {
  const sourced = Array.isArray(argv) ? argv.map(String).map((arg) => /^\. '(.+\/launch\/[0-9a-f-]{36}\.sh)'$/.exec(arg)?.[1]).find(Boolean) : undefined
  if (!sourced || !existsSync(sourced)) return null
  const text = placeheld(readFileSync(sourced, 'utf8'), label)
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 16)
  scripts[digest] = text
  return digest
}
async function attempt<T>(run: () => T | Promise<T>): Promise<unknown> {
  try { return norm(await run()) } catch (error) { return { threw: norm(error instanceof Error ? error.message : String(error)) } }
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
const configRoot = () => join(root, 'data', 'grid-engine-config')
let folders = 0
const work = (): string => { const dir = join(root, 'work', `w${++folders}`); mkdirSync(dir, { recursive: true }); return dir }

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'launch-shapes-golden-')))
  for (const name of VARS) saved[name] = process.env[name]
  for (const name of VARS) delete process.env[name]
  process.env.ADAPTER_DATA_DIR = join(root, 'data')
  process.env.HOME = join(root, 'home')
  process.env.SHELL = '/bin/zsh'
  process.env.CODEX_HOME = join(root, 'home', '.codex')
  // A zsh user with a startup file of their own: the plain launch.
  process.env.ZDOTDIR = join(root, 'zdotdir')
  for (const dir of ['data', 'zdotdir', 'home/.grok/sessions', 'home/.pi/agent/skills', 'home/.codex']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'zdotdir', '.zshrc'), '')
  // A saved API's model list, as an OpenAI-compatible API answers it, only for the key saved now.
  server = createServer((request, response) => {
    if (request.url !== '/v1/models') { response.statusCode = 404; response.end(); return }
    if (request.headers.authorization !== 'Bearer fresh-key') { response.statusCode = 401; response.end(); return }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ data: [
      { id: 'vendor/model-a', name: 'Vendor: Model A', context_length: 200000, supported_parameters: ['tools'] },
      { id: 'vendor/model-b' },
      { id: 'tiny', context_length: 1000 },
      { id: 'no-tools', supported_parameters: ['temperature'] },
    ] }))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  port = String((server.address() as AddressInfo).port)
  apiBase = `http://127.0.0.1:${port}/v1`
  vi.resetModules()
  const { ApiConnections } = await import('../lib/apiConnections.js')
  const store = new ApiConnections(join(root, 'data'))
  store.save({ provider: 'custom', name: 'Router', baseUrl: apiBase, apiKey: 'fresh-key' })
  store.save({ provider: 'custom', name: 'Keyed', baseUrl: apiBase, apiKey: 'other-key', authHeader: 'x-api-key', authPrefix: '' })
  const { launchShapes } = await import('../testing/launchShapes.js')
  shapes = (machine) => launchShapes({
    dataDir: join(root, 'data'), machine: () => ({ ...machine }), tmuxSupportsSessionEnv: async () => pane.tmux,
    readCodexConfig: () => null, setGridLaunch: () => {},
  })
})

afterAll(async () => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  await new Promise<void>((done) => server.close(() => done()))
  rmSync(root, { recursive: true, force: true })
  vi.resetModules()
})

/** What was logged while `run` ran, of the lines a launch writes. */
async function logged<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = []
  const keep = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  const log = vi.spyOn(console, 'log').mockImplementation(keep)
  const warn = vi.spyOn(console, 'warn').mockImplementation(keep)
  try { return { value: await run(), lines } } finally { log.mockRestore(); warn.mockRestore() }
}

// ------------------------------------------------------------------------------------------------ create

const pending = { agentId: 'created', sessionId: '', engine: 'claude' } as RegisteredSession
const rest = () => ({
  tmuxBackend: {} as never, registry: { setLaunch: () => pending } as never,
  adoptableSession: async () => ({ ok: false, error: 'UNUSED' }) as never, heldBy: async () => 'none' as const, takeOverWhenIdle: async () => {},
  watchNewPane: (async () => {}) as never, announceSession: () => {}, attachDsh: () => {}, hookPort: 4242, hooksDisabled: true,
  installOpencodePlugin: async () => true, terminalHintMachineName: () => 'this-mac', blocksFolder: () => false, gridSetup: () => null,
  privateGridName: async () => null,
})

async function createCase(engine: AgentEngine, grid: GridLaunchOverride | null, machine = M1): Promise<unknown> {
  pane.calls.length = 0
  rmSync(configRoot(), { recursive: true, force: true })
  const cwd = work()
  const { value, lines } = await logged(() => shapes(machine).create(rest() as never)({
    engine, cwd, bypassPermission: false, permissionMode: null, grid, codexHome: null, dsh: null, prompt: null, name: null, agent: null,
    resumeSessionId: null, takeOver: null,
  } as never))
  const call = pane.calls[0]
  const label = typeof call?.sessionLabel === 'string' ? call.sessionLabel : undefined
  return norm({
    result: value,
    pane: call ? { argv: call.argv, script: scriptOf(call.argv, label), env: call.env, grid: call.grid, gridLaunchRecord: call.gridLaunchRecord } : null,
    config: tree(configRoot()),
    folder: tree(cwd),
    logged: lines.filter((line) => /grid|refused|\[apis\]/i.test(line)),
  }, label)
}

async function createCases(): Promise<Record<string, unknown>> {
  const cases: Record<string, unknown> = {}
  for (const engine of ENGINES) cases[`${engine} · grid`] = await createCase(engine, GRID)
  for (const engine of ['claude', 'codex', 'opencode', 'pi', 'hermes', 'grok', 'copilot'] as const) {
    cases[`${engine} · grid without a model, web tools or window`] = await createCase(engine, BARE)
    cases[`${engine} · grid · another machine`] = await createCase(engine, GRID, M2)
    cases[`${engine} · saved API`] = await createCase(engine, api('router'))
  }
  pane.tmux = false
  cases['claude · grid · an old tmux'] = await createCase('claude', GRID)
  pane.tmux = true
  cases['claude · own login'] = await createCase('claude', null)
  cases['codex · own login'] = await createCase('codex', null)
  return cases
}

// ---------------------------------------------------------------------------------------------- relaunch

const session = (engine: AgentEngine, over: Partial<RegisteredSession> = {}): RegisteredSession => ({
  agentId: `agent-${engine}`, sessionId: 's', engine, cwd: work(), gridLaunch: null, codexHome: null, dsh: null, dshRuntime: null, agent: null,
  scmLaunch: null, ...over,
}) as unknown as RegisteredSession

async function relaunchCase(engine: AgentEngine, s: RegisteredSession, source?: Parameters<Shapes['relaunch']>[1], machine = M1): Promise<unknown> {
  rmSync(configRoot(), { recursive: true, force: true })
  const { value, lines } = await logged(() => shapes(machine).relaunch(s, source))
  return norm({
    result: value,
    retargetLine: value.ok ? shapes(machine).retargetLine(engine, value.overrides) : null,
    config: tree(configRoot()),
    folder: tree(s.cwd!),
    logged: lines.filter((line) => /grid|refused|\[apis\]/i.test(line)),
  })
}

async function relaunchCases(): Promise<Record<string, unknown>> {
  const cases: Record<string, unknown> = {}
  for (const engine of ENGINES) {
    cases[`${engine} · restart on a grid`] = await relaunchCase(engine, session(engine, { gridLaunch: GRID }))
  }
  for (const engine of ['claude', 'codex', 'opencode', 'pi', 'hermes', 'grok', 'copilot'] as const) {
    cases[`${engine} · restart on a grid without a model`] = await relaunchCase(engine, session(engine, { gridLaunch: BARE }))
    cases[`${engine} · restart on a grid · another machine`] = await relaunchCase(engine, session(engine, { gridLaunch: GRID }), undefined, M2)
    cases[`${engine} · restart on a saved API, its key as saved now`] = await relaunchCase(engine, session(engine, { gridLaunch: api('router') }))
    // Retarget hands the override it just resolved; fork drops the harness and the named agent.
    cases[`${engine} · retarget onto a grid`] = await relaunchCase(engine, session(engine), { gridLaunch: GRID })
    cases[`${engine} · retarget back to the own login`] = await relaunchCase(engine, session(engine, { gridLaunch: GRID }), { gridLaunch: null, subscriptionModel: 'own-model' })
    cases[`${engine} · fork on a grid`] = await relaunchCase(engine, session(engine, { gridLaunch: GRID, agent: 'reviewer' }), { gridLaunch: GRID, dsh: null, agent: null })
  }
  cases['claude · restart on a removed API'] = await relaunchCase('claude', session('claude', { gridLaunch: api('gone') }))
  cases['codex · restart on an API with no Bearer key'] = await relaunchCase('codex', session('codex', { gridLaunch: api('keyed') }))
  pane.tmux = false
  cases['codex · restart on a grid · an old tmux'] = await relaunchCase('codex', session('codex', { gridLaunch: GRID }))
  pane.tmux = true
  cases['opencode · restart as a named agent on a grid'] = await relaunchCase('opencode', session('opencode', { gridLaunch: GRID, agent: 'reviewer' }))
  return cases
}

// ------------------------------------------------------------------------- retarget, the socket, the pickers

async function otherCases(): Promise<Record<string, unknown>> {
  const cases: Record<string, unknown> = {}
  for (const engine of ENGINES) {
    cases[`validate · ${engine} · grid`] = await attempt(() => shapes(M1).validate(engine, { gridLaunch: GRID }))
    cases[`validate · ${engine} · own login`] = await attempt(() => shapes(M1).validate(engine, { gridLaunch: null }))
    cases[`leaving a grid · ${engine}`] = norm(shapes(M1).leavingGrid(engine))
  }
  pane.tmux = false
  cases['validate · claude · grid · an old tmux'] = await attempt(() => shapes(M1).validate('claude', { gridLaunch: GRID }))
  pane.tmux = true
  cases['validate · opencode · grid · another machine'] = await attempt(() => shapes(M2).validate('opencode', { gridLaunch: GRID }))
  cases['grid-capable engines'] = norm(shapes(M1).gridCapable())
  for (const [name, connection, model] of [
    ['a listed model', 'router', 'vendor/model-a'], ['a model without details', 'router', 'vendor/model-b'], ['a window too small', 'router', 'tiny'],
    ['a model without tools', 'router', 'no-tools'], ['an unlisted model', 'router', 'missing'], ['no model', 'router', ''],
    ['an API with no Bearer key', 'keyed', 'vendor/model-a'], ['a removed API', 'gone', 'vendor/model-a'],
  ] as const) {
    cases[`API target · ${name}`] = await attempt(() => shapes(M1).apiTarget(connection, model))
  }
  for (const engine of ['claude', 'codex', 'opencode', 'gemini', 'terminal'] as const) {
    const cwd = work()
    shapes(M1).apiTools(cwd, engine)
    cases[`API tools · ${engine}`] = norm(tree(cwd))
  }
  const kept = work()
  writeFileSync(join(kept, 'AGENTS.md'), '# Ours\n')
  shapes(M1).apiTools(kept, 'codex')
  shapes(M1).apiTools(kept, 'codex')
  cases['API tools · an existing file, twice'] = norm(tree(kept))
  shapes(M1).apiTools(null, 'codex')
  return cases
}

type Sections = Record<string, Record<string, unknown>>
const PLATFORMS = ['darwin', 'linux'] as const

async function sectionsOn(platform: (typeof PLATFORMS)[number]): Promise<Sections> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...real, value: platform })
  rmSync(join(root, 'work'), { recursive: true, force: true })
  folders = 0
  try {
    return { create: await createCases(), relaunch: await relaunchCases(), other: await otherCases() }
  } finally { Object.defineProperty(process, 'platform', real) }
}

describe('every launch on a grid model or a saved API starts as it did before the models service built it', () => {
  it('create, relaunch, fork, retarget, the API target and the pickers match the record, on darwin and linux', async () => {
    const darwin = await sectionsOn('darwin')
    const linux = await sectionsOn('linux')
    const linuxDiffers = Object.fromEntries(Object.entries(linux).map(([section, cases]) => [section,
      Object.fromEntries(Object.entries(cases).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(darwin[section]![key])))]))
    // Both platforms' scripts, by digest: a case names its own, and its digest is its text.
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
    expect(text).not.toContain('launch-shapes-golden-')
    expect(text).not.toContain(root)
    expect(text).not.toMatch(/\/Users\/|\/home\/runner/)
  })
})
