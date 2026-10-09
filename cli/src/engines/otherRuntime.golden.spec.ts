/**
 * What the core reads of the twelve other engines' model and effort, and what a switch of theirs does, recorded
 * from main before their runtime-profile parsers left the core's static imports
 * (docs/design/2026-10-08-other-engines-out-of-core.md, (o4)). Through the core's own entries, wired as core/main.ts
 * wires them for an engine no worker serves (`new RuntimeProfileState(() => undefined)`):
 *
 * - every pane through `ingestPane`, for every engine, from a fresh session: what it reports changed and the state;
 * - every transcript through `hydrate`, and line by line through `ingest` and `transcriptFields`;
 * - every config file a config-reading engine (Hermes, Muse, Amp, Command Code) reads, through `ingestConfig`;
 * - the catalogs OpenCode, Kilo and Devin warm on attach, from each output their specs hold, and every pane of
 *   theirs read against the catalog;
 * - a switch (`RuntimeProfileController.setProfile`): whether it may be driven, what it offers, and what it does,
 *   keys included.
 *
 * The inputs are the repository's: the pane fixtures, the transcripts the transcripts golden froze, and the
 * strings the runtime-profile specs write out (testing/specLiterals.ts), copied into the golden. Nothing of the
 * host is in it: the clock, platform, HOME, every engine home and the engines' binaries (scripts of the test's own,
 * first on PATH) are pinned, and no size depends on the temporary folder.
 *
 * `RECORD_OTHER_ENGINES_GOLDEN=1` writes the fixture. Record it again only for a change meant to alter what the
 * core reads of these engines' profiles, and say so in that change.
 */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { specStrings } from '../testing/specLiterals.js'
import * as takeoverScreens from '../lib/__fixtures__/takeoverScreens.js'
import * as rewindPickers from '../lib/__fixtures__/rewindPickers.js'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./__fixtures__/other-runtime.golden.json', import.meta.url))
const TRANSCRIPTS = fileURLToPath(new URL('./__fixtures__/other-transcripts.golden.json', import.meta.url))
const RECORD = process.env.RECORD_OTHER_ENGINES_GOLDEN === '1'
const ENGINES = ['opencode', 'cursor', 'kilo', 'devin', 'hermes', 'amp', 'agy', 'grok', 'copilot', 'commandcode', 'muse', 'pi'] as const
type Engine = (typeof ENGINES)[number]
const SPEC_FILES = [
  ...['agy', 'commandcode', 'devin', 'grok', 'hermes', 'kilo', 'opencode', 'pi'].map((e) => `engines/${e}/runtimeProfile.spec.ts`),
  'lib/runtimeProfile.spec.ts', 'lib/runtimeProfileController.spec.ts', 'lib/runtimeProfileState.spec.ts',
]
const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const fixturesDir = join(SRC, 'lib', '__fixtures__')

interface Golden {
  /** The strings the specs write out, as taken when recorded, by file. */
  strings: Record<string, string[]>
  /** Per case: a hash of everything it produced. */
  cases: Record<string, string>
}

const sha = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')

let root = ''
const sessionOf = (engine: string, id = 'golden'): RegisteredSession => ({
  agentId: `agent-${engine}-${id}`, sessionId: `session-${engine}-${id}`, engine, active: true, registeredAt: NOW - 60_000, boundAt: NOW - 60_000,
  touchedAt: NOW - 30_000, transcriptPath: null, projectDir: 'golden', cwd: '/work/golden', runtimes: [], processIdentity: null, model: null,
  cliVersion: null,
} as unknown as RegisteredSession)

/** The pane fixtures, and the screens the fixture modules build. */
function fixturePanes(): string[] {
  return [
    ...readdirSync(fixturesDir).filter((name) => /^(permission|question)-[\w-]+\.txt$/.test(name)).sort().map((name) => readFileSync(join(fixturesDir, name), 'utf8')),
    ...[takeoverScreens, rewindPickers].flatMap((values) => Object.entries(values).sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value).filter((value): value is string => typeof value === 'string')),
  ]
}

type Manager = InstanceType<Awaited<ReturnType<typeof loadCore>>['RuntimeProfileState']>
async function loadCore() {
  const { RuntimeProfileState } = await import('../lib/runtimeProfileState.js')
  const { RuntimeProfileController } = await import('../lib/runtimeControl.js')
  const { encodeRuntimeProfile } = await import('../engines/kit/runtime.js')
  return { RuntimeProfileState, RuntimeProfileController, encodeRuntimeProfile }
}
let core: Awaited<ReturnType<typeof loadCore>>
const manager = (): Manager => new core.RuntimeProfileState(() => undefined)
const stateOf = (m: Manager, s: RegisteredSession) => ({ state: m.getState(s.sessionId), selected: m.selectedModel(s) })

let golden: Golden
const recorded: Golden = { strings: {}, cases: {} }
function check(key: string, produced: unknown): void {
  const hash = sha(JSON.stringify(produced).split(root).join('<root>')).slice(0, 20)
  recorded.cases[key] = hash
  if (!RECORD) expect({ key, hash }).toEqual({ key, hash: golden.cases[key] })
}

/** Every pane, for `engine`, each read by a fresh session: what it reports changed, and the state after it. */
function readPanes(engine: Engine, panes: string[], m: Manager = manager()): unknown[] {
  return panes.map((pane, i) => {
    const s = sessionOf(engine, `pane-${i}`)
    return [m.ingestPane(s, pane, true), stateOf(m, s)]
  })
}

/** The engines' own programs, as the catalogs run them: each prints what the case puts in its output file. */
function binaries(): void {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const name of ['opencode', 'kilo', 'devin', 'pi', 'commandcode', 'agent', 'hermes']) {
    const out = join(root, 'out', name)
    writeFileSync(join(bin, name), `#!/bin/sh\nif [ -f ${JSON.stringify(out)} ]; then cat ${JSON.stringify(out)}; else exit 1; fi\n`)
    chmodSync(join(bin, name), 0o755)
  }
  mkdirSync(join(root, 'out'), { recursive: true })
}
const output = (name: string, text: string | null): void => {
  const file = join(root, 'out', name)
  if (text === null) rmSync(file, { force: true }); else writeFileSync(file, text)
}

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const saved: Record<string, string | undefined> = {}
let panes: string[] = []
let strings: Record<string, string[]> = {}
let transcripts: Array<{ id: string; lines: string[] }> = []

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'other-runtime-golden-')))
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  binaries()
  const home = join(root, 'home')
  const env: Record<string, string | undefined> = {
    HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), ADAPTER_DATA_DIR: join(root, 'data'),
    HERMES_HOME: join(home, '.hermes'), COMMANDCODE_HOME: join(home, '.commandcode'), MUSE_CONFIG_DIR: undefined, AMP_STATE_DIR: undefined,
    OPENCODE_PATH: join(root, 'bin', 'opencode'), KILO_PATH: join(root, 'bin', 'kilo'), CURSOR_HOME: join(home, '.cursor'), DEVIN_HOME: undefined,
    PATH: `${join(root, 'bin')}:/usr/bin:/bin`, TZ: 'UTC',
  }
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name]
    if (value === undefined) delete process.env[name]; else process.env[name] = value
  }
  for (const dir of ['data', join('home', '.hermes'), join('home', '.commandcode'), join('home', '.config', 'muse'), join('home', '.local', 'share', 'amp')]) mkdirSync(join(root, dir), { recursive: true })
  vi.resetModules()
  core = await loadCore()
  // As a session entering the registry does (engines/inProcess.ts `preloadEngine`): its engine's code is loaded
  // before any pane or line of it is read.
  const { loadEngine } = await import('./inProcess.js')
  for (const engine of ENGINES) await loadEngine(engine)
  golden = RECORD ? { strings: {}, cases: {} } : JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden
  strings = RECORD ? Object.fromEntries(SPEC_FILES.map((file) => [file, specStrings(join(SRC, file))])) : golden.strings
  recorded.strings = strings
  panes = [...new Set([...fixturePanes(), ...Object.values(strings).flat()])]
  // The transcripts the transcripts golden froze: its spec transcripts are in it, its fixtures are files.
  const frozen = JSON.parse(readFileSync(TRANSCRIPTS, 'utf8')) as { transcripts: Array<{ id: string; lines?: string[] }> }
  transcripts = frozen.transcripts.map(({ id, lines }) => ({
    id, lines: lines ?? readFileSync(join(SRC, id), 'utf8').split('\n').filter((line) => line.trim()),
  }))
})

afterAll(() => {
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', platform)
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value
  if (root) rmSync(root, { recursive: true, force: true })
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(recorded, null, 1) + '\n')
})

/** Let a read the manager started and did not wait for (Command Code's config, after a model change) finish. */
// Only Date is faked, so this waits in real time, and what the read stamps is still the pinned clock.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30))

describe('the other engines\' runtime profiles, through the core', () => {
  it('has inputs', () => {
    expect(panes.length).toBeGreaterThan(500)
    expect(transcripts.length).toBeGreaterThan(20)
  })

  for (const engine of ENGINES) {
    it(`${engine}: every pane, every transcript, and a switch`, async () => {
      check(`${engine} panes`, readPanes(engine, panes))
      for (const transcript of transcripts) {
        const m = manager()
        const s = sessionOf(engine, 'hydrated')
        m.hydrate(s, transcript.lines)
        const hydrated = stateOf(m, s)
        const live = sessionOf(engine, 'live')
        const lines = transcript.lines.map((line) => [m.ingest(live, line, true), m.transcriptFields(live, line)])
        await settle()
        check(`${engine} transcript: ${transcript.id}`, { hydrated, lines, live: stateOf(m, live) })
      }
      // A switch: whether it may be driven, what is offered, and what a request does, every key included.
      const m = manager()
      const s = sessionOf(engine, 'switch')
      const keys: unknown[] = []
      const controller = new core.RuntimeProfileController({
        modelControlFor: () => undefined,
        readScreen: async () => null,
        manager: m as never,
        getSession: () => s,
        validateRuntime: async () => true,
        capture: async () => '',
        sendText: async (target, text) => { keys.push(['text', target, text]); return true },
        sendLiteral: async (target, text) => { keys.push(['literal', target, text]); return true },
        sendKey: async (target, key) => { keys.push(['key', target, key]); return true },
        acquireInput: () => () => {},
      })
      const target = core.encodeRuntimeProfile({ sessionId: s.agentId, engine, model: 'golden-model', effort: 'high' })
      const outcome = await controller.setProfile(s.agentId, target).then(() => 'switched', (error: { code?: string }) => error.code ?? String(error))
      check(`${engine} switch`, { supports: await m.supportsControl(s), offered: await m.modelsForSession(s), outcome, keys })
    }, 120_000)
  }

  it('reads each config file the config engines keep, as each spec writes one', async () => {
    const files: Record<string, (text: string) => string> = {
      hermes: () => join(root, 'home', '.hermes', 'config.yaml'),
      muse: () => join(root, 'home', '.config', 'muse', 'settings.json'),
      amp: () => join(root, 'home', '.local', 'share', 'amp', 'session.json'),
      commandcode: () => join(root, 'home', '.commandcode', 'config.json'),
    }
    const contents = [...new Set(Object.values(strings).flat())]
    for (const [engine, file] of Object.entries(files)) {
      const results: unknown[] = []
      for (const text of [null, ...contents]) {
        const path = file(text ?? '')
        if (text === null) rmSync(path, { force: true }); else writeFileSync(path, text)
        const m = manager()
        const s = sessionOf(engine, 'config')
        results.push([await m.ingestConfig(s, true), stateOf(m, s)])
      }
      rmSync(file(''), { force: true })
      check(`${engine} config`, results)
    }
  }, 120_000)

  it('resolves OpenCode\'s, Kilo\'s and Devin\'s panes against the catalog each output of theirs warms', async () => {
    const own: Record<string, string> = { opencode: 'engines/opencode/runtimeProfile.spec.ts', kilo: 'engines/kilo/runtimeProfile.spec.ts', devin: 'engines/devin/runtimeProfile.spec.ts' }
    for (const [engine, file] of Object.entries(own)) {
      const theirs = [...fixturePanes(), ...strings[file]!]
      for (const [i, catalog] of [null, ...strings[file]!].entries()) {
        output(engine, catalog)
        const m = manager()
        const warmed = await m.ingestConfig(sessionOf(engine, 'warm'), true)
        check(`${engine} catalog #${i}: ${catalog === null ? 'none' : sha(catalog).slice(0, 12)}`, { warmed, panes: readPanes(engine as Engine, theirs, m) })
      }
      output(engine, null)
    }
  }, 120_000)

  it('has a recorded outcome for every case, and no other', () => {
    if (RECORD) return
    expect(Object.keys(recorded.cases).sort()).toEqual(Object.keys(golden.cases).sort())
  })
})
