import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { registry as Registry } from '../../lib/registry.js'
import { noOtherStreams } from '../../testing/otherStreams.js'
import { createAttach, type AttachDeps } from './attach.js'
import { createSessionNormalizers } from './normalizers.js'
import { transcriptReadIdentity } from './readIdentity.js'
import { createStoreOf } from './stores.js'

// Execute the real composition, without booting the daemon. A copied callback would keep this regression red
// after main.ts was fixed, or pass while the actual attach still invalidated itself on its own store lookup.
const source = ts.createSourceFile('main.ts', readFileSync(join(import.meta.dirname, '../main.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
let composition: ts.Expression | undefined
const visit = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'storeOf') composition = node.initializer
  ts.forEachChild(node, visit)
}
visit(source)
if (!composition) throw new Error('The daemon must compose its store reader')
const storeComposition = ts.transpileModule(`(${composition.getText(source)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText

let directory: string, registry: typeof Registry
const processIdentity = { pid: 1041, executable: '/fixture/hermes', startMarker: 'fixture-1041' }
const native = { engine: 'hermes' as const, tmuxPane: '%41', cwd: '/fixture/project', processIdentity }
const sessionId = '20261116_100000_aaaaaa'

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'attach-store-'))
  for (const key of ['ADAPTER_DATA_DIR', 'CLAUDE_PROJECTS_DIR', 'CODEX_HOME', 'CURSOR_HOME', 'HERMES_HOME']) vi.stubEnv(key, directory)
  vi.resetModules()
  registry = (await import('../../lib/registry.js')).registry
  await registry.load()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

async function setup(home: string | null = null) {
  ;(await registry.openProcessAgent({ ...native, agentId: 'hermes-agent' }))
  const row = (await registry.register({ ...native, sessionId, ...(home ? { hermesHome: home } : {}) }))!.entry
  let finish!: (location: { store: string | null; home?: string }) => void
  let locating!: () => void
  const locatingStore = new Promise<void>(resolve => { locating = resolve })
  const locateStore = vi.fn(() => new Promise<{ store: string | null; home?: string }>(resolve => {
    finish = resolve; locating()
  }))
  const others = noOtherStreams()
  others.open = vi.fn(async () => ({ turn: { identity: 'fixture-turn', turnOpen: false }, historyTurnOpen: false,
    lastStarted: null, lastEnded: null, initial: [], lines: 0, evidence: [], abandoned: false, frames: [] }))
  others.unavailable = vi.fn()
  const storeOf = runInNewContext(storeComposition, {
    createStoreOf, transcriptReadIdentity, registry, otherStreams: { locateStore },
    OPENCODE_DB: '/fixture/opencode.db', KILO_DB: '/fixture/kilo.db', DEVIN_DB: '/fixture/devin.db',
  }, { timeout: 1_000 }) as AttachDeps['storeOf']
  const runtimeProfiles = {
    transcriptFields: () => [], beginHydrate: vi.fn(), hydrate: vi.fn(), hydrateEvidence: vi.fn(),
    ingest: vi.fn(() => false), ingestConfig: vi.fn(async () => false),
    ingestPane: vi.fn(() => false), capturePane: vi.fn(async () => null),
  } as AttachDeps['runtimeProfiles']
  const emit = vi.fn()
  const attach = createAttach({ liveFor: () => undefined, resolve: id => registry.resolve(id),
    terminalGone: async () => false,
    normalizers: createSessionNormalizers(others, { held: () => false, closed: vi.fn(), forget: vi.fn() }), others,
    watcher: { addSession: vi.fn(async () => {}), removeSession: vi.fn(async () => {}), pollSession: vi.fn(async () => {}),
      hold: vi.fn(async () => null), tails: () => false },
    setInterpretationHold: registry.setInterpretationHold.bind(registry), announceSession: vi.fn(),
    cursorDiscovery: { add: vi.fn(async () => {}) }, runtimeProfiles,
    captureTerminal: vi.fn(async () => null), emit, tokenUsage: { changed: vi.fn() },
    questionWatcher: { start: vi.fn() }, terminalLabel: () => 'private fixture', storeOf, concurrency: 1,
  })
  return { row, attach, others, locateStore, locatingStore, finish: (location: { store: string | null; home?: string }) => finish(location), emit }
}

it.each(['default', 'discovered profile', 'explicit profile'] as const)(
  'attaches the %s store without changing the native home that authorized the read', async kind => {
    const home = kind === 'default' ? directory : join(directory, 'profiles/work')
    const p = await setup(kind === 'explicit profile' ? home : null)
    const nativeHome = p.row.hermesHome
    const saved = readFileSync(join(directory, 'registry.json'), 'utf8')
    const attaching = p.attach.attachSession(p.row)
    await p.locatingStore
    p.finish({ store: join(home, 'state.db'), home })
    expect(await attaching).toBe(true)
    expect(p.others.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId, hermesHome: nativeHome }),
      expect.objectContaining({ store: join(home, 'state.db') }))
    expect(p.row.hermesHome).toBe(nativeHome)
    expect(readFileSync(join(directory, 'registry.json'), 'utf8')).toBe(saved)
    expect(p.locateStore).toHaveBeenCalledOnce()
  },
)

it.each(['forgotten', 'conversation', 'process', 'home', 'source'] as const)(
  'does not attach an old store after its %s authority changes', async change => {
    const p = await setup()
    const attaching = p.attach.attachSession(p.row)
    await p.locatingStore
    if (change === 'forgotten') p.attach.forget(sessionId)
    if (change === 'conversation') (await registry.register({ ...native, sessionId: '20261116_100001_bbbbbb' }))
    if (change === 'process') registry.updateProcessIdentity(p.row.agentId, { ...processIdentity, startMarker: 'replacement-process' })
    if (change === 'home') registry.setHermesHome(p.row.agentId, join(directory, 'replacement-home'))
    if (change === 'source') registry.byAgent(p.row.agentId)!.transcriptPath = join(directory, 'replacement.jsonl')
    const current = registry.byAgent(p.row.agentId)
    const nativeHome = current?.hermesHome
    p.finish({ store: join(directory, 'state.db'), home: directory })
    expect(await attaching).toBe(false)
    expect(p.others.open).not.toHaveBeenCalled()
    expect(p.emit).not.toHaveBeenCalled()
    expect(current?.hermesHome).toBe(nativeHome)
    expect(p.locateStore).toHaveBeenCalledOnce()
  },
)

it('keeps an unavailable store visible without changing the native binding', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const p = await setup()
  const attaching = p.attach.attachSession(p.row)
  await p.locatingStore
  p.finish({ store: null })
  expect(await attaching).toBe(true)
  expect(p.others.unavailable).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId }))
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('store reader is unavailable'))
  expect(p.others.open).not.toHaveBeenCalled()
  expect(p.row.hermesHome).toBeNull()
})
