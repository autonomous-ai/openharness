import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseOpencodeApiModels } from '../engines/opencode/runtimeProfile.js'
import type { RegisteredSession } from './registry.js'
import { encodeRuntimeProfile, RuntimeProfileManager } from './runtimeProfile.js'
import { RuntimeProfileController } from './runtimeProfileController.js'
import { createModelControls } from '../core/engines/modelControls.js'
import { createRuntimeProfiles, type RuntimeProfiles } from '../core/engines/runtimeProfiles.js'
import { createRuntimeTransport } from '../core/engines/runtimeTransport.js'
import { otherRuntimeRequests } from '../engines/others/runtimeRequests.js'
import { MODEL_CONTROL_CAPABILITIES } from '../engines/worker/modelControlProtocol.js'
import { RUNTIME_READ } from '../engines/worker/runtimeProtocol.js'
import { blankRuntimeState } from '../engines/kit/runtime.js'

const command = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: command }),
}))
vi.mock('./engineBin.js', async original => ({
  ...await original<typeof import('./engineBin.js')>(), opencodeBinAsync: async () => '/fixture/opencode',
}))
const active: RuntimeProfiles[] = []
beforeEach(() => command.mockResolvedValue({ stdout: JSON.stringify({ data: CATALOG.map(m => ({
  id: m.model, providerID: m.provider, name: m.name, variants: m.efforts!.map(id => ({ id })),
})) }) }))
afterEach(() => { active.splice(0).forEach(value => value.stop()); vi.restoreAllMocks(); command.mockClear() })
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }


/** OpenCode 2.2.6's models on MSI (2026-11-17), as its own list names them. */
const CATALOG = parseOpencodeApiModels(JSON.stringify({ data: [
  { id: 'big-pickle', providerID: 'opencode', name: 'Big Pickle', variants: [] },
  { id: 'deepseek-v4.1-flash-free', providerID: 'opencode', name: 'DeepSeek V4.1 Flash Free', variants: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] },
] }))

/**
 * OpenCode 2.2 on a 50-column pane, as measured on MSI: a command is listed under the composer as it is typed and an
 * Enter before that list is dropped; `/models` and `/effort` open pickers with a filter; picking a model with variants
 * opens `Select variant` by itself; the footer names the model, its provider, and a variant other than Default.
 */
class FakeOpencode {
  model = 'Big Pickle'
  variant: string | null = null
  composer = ''
  listed = false
  picker: 'model' | 'variant' | null = null
  filter = ''
  readonly keys: string[] = []
  commandLists = true
  variantRows: string[] | undefined

  private rows(): string[] {
    const all = this.picker === 'model' ? CATALOG.map((m) => m.name!) : this.variantRows ?? ['Default', ...CATALOG.find((m) => m.name === this.model)!.efforts!]
    const words = this.filter.toLowerCase().split(/\s+/).filter(Boolean)
    return all.filter((row) => words.every((w) => row.toLowerCase().includes(w)))
  }

  screen(): string {
    const lines = ['     Bạn cần tôi hỗ trợ gì hôm nay?']
    if (this.picker) {
      lines.push(`     ${this.picker === 'model' ? 'Select model' : 'Select variant'}                         esc`, `     ${this.filter || 'Search'}`)
      const rows = this.rows()
      if (!rows.length) lines.push('     No results found')
      for (const row of rows) lines.push(this.picker === 'model' ? `     ${row.padEnd(36)}Free` : `     ${row}`)
      if (this.picker === 'model') lines.push('     View all integrations ctrl+a', '     Favorite ctrl+f')
    }
    if (this.listed) lines.push(`  ┃ ${this.composer.padEnd(37)} Swit ┃`)
    lines.push('  ┃', `  ┃  ${this.composer}`, '  ┃', `  ┃  Build · ${this.model} OpenCode${this.variant ? ` · ${this.variant}` : ''}`,
      '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀', '  ~/projects/oc   7.1K (4%)')
    return lines.join('\n')
  }

  literal(text: string): void {
    if (this.picker) { this.filter += text; return }
    this.composer += text
    // OpenCode lists the command a moment later, on its next frame: an Enter in the same frame finds no list.
    this.listed = false
    setTimeout(() => { this.listed = this.commandLists && ['/models', '/effort'].includes(this.composer) }, 20)
  }

  key(key: string): void {
    this.keys.push(key)
    if (key === 'Escape') { this.picker = null; this.filter = ''; return }
    if (key === 'BSpace') { this.composer = this.composer.slice(0, -1); return }
    if (key !== 'Enter') return
    if (!this.picker) {
      if (this.listed) this.picker = this.composer === '/models' ? 'model' : 'variant'
      this.composer = ''
      this.listed = false
      return
    }
    const row = this.rows()[0]
    if (!row) return
    this.filter = ''
    if (this.picker === 'model') {
      this.model = row
      this.variant = null
      this.picker = CATALOG.find((m) => m.name === row)!.efforts!.length ? 'variant' : null
    } else {
      this.variant = row === 'Default' ? null : row
      this.picker = null
    }
  }
}

/** An OpenCode agent nobody has written to: no session yet, as OpenCode makes it at the first message. */
function fresh(): RegisteredSession {
  return {
    schemaVersion: 2, active: true, sessionId: '', engine: 'opencode', launcherId: 'oc', agentId: 'oc', boundAt: 0, transcriptPath: null,
    projectDir: 'oc', cwd: '/projects/oc', tmuxPane: '%1', source: null, title: null, model: null, runtimes: [{ backend: 'tmux', paneId: '%1' }],
    primaryRuntimeKey: 'tmux\u0000%1', cliVersion: '2.2.6', processIdentity: null, registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
  } as RegisteredSession
}

describe('switching OpenCode through its own pickers', () => {
  function setup() {
    const value = fresh()
    const oc = new FakeOpencode()
    const manager = new RuntimeProfileManager()
    const options = CATALOG.flatMap((m) => ['auto', ...m.efforts!].map((effort) => ({
      id: encodeRuntimeProfile({ sessionId: 'oc', engine: 'opencode', model: m.id, effort }), displayName: m.name!,
    })))
    vi.spyOn(manager, 'supportsControl').mockResolvedValue(true)
    vi.spyOn(manager, 'modelsForSession').mockResolvedValue(options)
    const catalog = vi.spyOn(manager, 'opencodeCatalog').mockResolvedValue(CATALOG)
    vi.spyOn(manager, 'codexCatalog').mockImplementation(async session => (await manager.opencodeCatalog(session.cwd))
      .map(entry => ({ slug: entry.id, displayName: entry.name ?? entry.id, listed: true, defaultEffort: 'auto', efforts: entry.efforts ?? [] })))
    const controller = new RuntimeProfileController({
      manager, getSession: () => value, validateRuntime: async () => true, capture: async () => oc.screen(),
      sendText: async () => { throw new Error('a command and its Enter are never sent together') },
      sendLiteral: async (_pane, text) => { oc.literal(text); return true },
      sendKey: async (_pane, key) => { oc.key(key); return true },
      acquireInput: () => () => undefined,
    })
    const pick = (model: string, effort: string) =>
      controller.setProfile('oc', encodeRuntimeProfile({ sessionId: 'oc', engine: 'opencode', model, effort }))
    return { oc, pick, catalog }
  }

  it('takes a model and a variant at once, on an agent with no session, its footer the evidence', async () => {
    const { oc, pick, catalog } = setup()
    await pick('opencode/deepseek-v4.1-flash-free', 'high')
    expect([oc.model, oc.variant, oc.picker]).toEqual(['DeepSeek V4.1 Flash Free', 'high', null])
    // The agent's own folder: a project's config can add providers.
    expect(catalog).toHaveBeenCalledWith('/projects/oc')

    // Back to a model with no variants, and to Default: no picker is left open to take what is typed next.
    await pick('opencode/big-pickle', 'auto')
    expect([oc.model, oc.variant, oc.picker]).toEqual(['Big Pickle', null, null])
  })

  it('answers the variant picker OpenCode opens by itself with Default, never leaving it open', async () => {
    const { oc, pick } = setup()
    await pick('opencode/deepseek-v4.1-flash-free', 'auto')
    expect([oc.model, oc.variant, oc.picker]).toEqual(['DeepSeek V4.1 Flash Free', null, null])
  })

  it('refuses a variant the model does not have, before any key', async () => {
    const { oc, pick } = setup()
    await expect(pick('opencode/big-pickle', 'high')).rejects.toMatchObject({ code: 'EFFORT_UNSUPPORTED' })
    expect(oc.keys).toEqual([])
    expect(oc.picker).toBeNull()
  })
})

/** Uses the public controller, real core grants, shared worker routing and runtime reader together. */
function workerSetup(bound = false) {
  const value = { ...fresh(), sessionId: bound ? 'conversation' : '' }
  const oc = new FakeOpencode()
  const resolve = (id: string) => id && [value.agentId, value.sessionId].includes(id) ? value : undefined
  const served = otherRuntimeRequests({ query: (query, payload) => controls.answer('engine-others', query, payload)! })
  const call = vi.fn(async (_service: string, method: string, payload: Record<string, unknown>) =>
    await served.requests[method]?.({ ...payload, requestId: 'core-request' }, { owner: true, local: true }) as Record<string, unknown>
      ?? { error: 'UNKNOWN_METHOD' })
  const transport = createRuntimeTransport({ call })
  const manager = createRuntimeProfiles({ handles: () => true, resolve, transport })
  active.push(manager)
  const capture = vi.fn(async () => oc.screen() as string | null)
  const controls = createModelControls({ handles: () => true, resolve, call,
    inline: () => { throw Error('worker failure must not select an inline driver') },
    catalog: session => manager.codexCatalog(session),
    capture: (session, lines, observe) => observe && session.sessionId ? manager.capturePane(session, capture, lines, true) : capture(),
    text: async () => { throw Error('a command and its Enter are never sent together') },
    literal: async (_id, text, allowed) => { if (!allowed()) return false; oc.literal(text); return true },
    key: async (_id, key, allowed) => { if (!allowed()) return false; oc.key(key); return true },
    waitForModel: (id, ms) => manager.waitForModel(id, ms), waitForProfile: (id, ms) => manager.waitForProfile(id, ms),
    confirmEffort: (id, effort) => manager.confirmEffort(id, effort),
  })
  controls.connected('engine-others'); transport.connected('engine-others')
  const begin = vi.spyOn(manager, 'beginControl')
  const controller = new RuntimeProfileController({ manager, modelControlFor: controls.forSession,
    getSession: resolve, validateRuntime: async () => true, capture,
    sendText: async () => false, sendLiteral: async () => false, sendKey: async () => false,
    acquireInput: () => () => undefined,
  })
  const target = (model: string, effort: string) => encodeRuntimeProfile({ sessionId: value.agentId, engine: 'opencode', model, effort })
  const pick = (model: string, effort: string) => controller.setProfile(value.agentId, target(model, effort))
  return { oc, value, manager, controls, transport, capture, call, begin, pick, target }
}

describe('OpenCode switching across the worker boundary', () => {
  it.each([false, true])('retains the upstream model/variant and Default fixtures (bound: %s)', async bound => {
    const s = workerSetup(bound)
    await s.pick('opencode/deepseek-v4.1-flash-free', 'high')
    expect([s.oc.model, s.oc.variant, s.oc.picker]).toEqual(['DeepSeek V4.1 Flash Free', 'high', null])
    expect(command).toHaveBeenCalledWith('/fixture/opencode', ['api', 'GET', '/api/model?location%5Bdirectory%5D=%2Fprojects%2Foc'], expect.anything())
    expect(s.manager.selectedModel(s.value)).toBe(bound ? s.target('opencode/deepseek-v4.1-flash-free', 'high') : null)
    await s.pick('opencode/deepseek-v4.1-flash-free', 'auto')
    expect([s.oc.variant, s.oc.picker]).toEqual([null, null])
    await s.pick('opencode/big-pickle', 'auto')
    expect([s.oc.model, s.oc.variant, s.oc.picker]).toEqual(['Big Pickle', null, null])
    expect(s.manager.getState('')).toEqual(blankRuntimeState())
    if (!bound) expect(s.begin).not.toHaveBeenCalled()
  })

  it('answers the automatically opened variant picker with Default', async () => {
    const s = workerSetup()
    await s.pick('opencode/deepseek-v4.1-flash-free', 'auto')
    expect([s.oc.model, s.oc.variant, s.oc.picker]).toEqual(['DeepSeek V4.1 Flash Free', null, null])
  })

  it('removes an unlisted command without submitting it', async () => {
    const s = workerSetup()
    s.oc.commandLists = false
    await expect(s.pick('opencode/big-pickle', 'auto')).rejects.toMatchObject({ code: 'CONFIRM_TIMEOUT' })
    expect(s.oc.composer).toBe('')
    expect(s.oc.keys.filter(key => key === 'BSpace')).toHaveLength('/models'.length)
    expect(s.oc.keys).not.toContain('Enter')
  })

  it('refuses high when the filtered first variant is xhigh', async () => {
    const s = workerSetup()
    s.oc.variantRows = ['Default', 'xhigh', 'high']
    await expect(s.pick('opencode/deepseek-v4.1-flash-free', 'high')).rejects.toMatchObject({ code: 'EFFORT_UNSUPPORTED' })
    expect([s.oc.model, s.oc.variant, s.oc.picker]).toEqual(['DeepSeek V4.1 Flash Free', null, null])
  })

  it('rejects unsupported variants and older workers before any terminal effect', async () => {
    const s = workerSetup()
    await expect(s.pick('opencode/big-pickle', 'high')).rejects.toMatchObject({ code: 'EFFORT_UNSUPPORTED' })
    expect([s.oc.keys, s.oc.composer, s.oc.picker]).toEqual([[], '', null])
    s.controls.disconnected('engine-others'); s.controls.connected('engine-others')
    const original = s.call.getMockImplementation()!
    s.call.mockImplementation((service, method, payload) => method === MODEL_CONTROL_CAPABILITIES
      ? Promise.resolve({ error: 'UNKNOWN_METHOD' }) : original(service, method, payload))
    await expect(s.pick('opencode/big-pickle', 'auto')).rejects.toMatchObject({ code: 'BUSY' })
    expect([s.oc.keys, s.oc.composer, s.oc.picker]).toEqual([[], '', null])
  })

  it.each([{ point: 'capture', bound: false }, { point: 'capture', bound: true }, { point: 'interpretation', bound: true }] as const)('revokes during $point (bound: $bound) without stale state or late effects', async ({ point, bound }) => {
    const s = workerSetup(bound), entered = deferred<void>(), gate = deferred<void>()
    const capture = s.capture.getMockImplementation()!, call = s.call.getMockImplementation()!
    let held = false
    s.capture.mockImplementation(async () => {
      const text = await capture()
      if (point === 'capture' && s.oc.model === 'DeepSeek V4.1 Flash Free' && !held) { held = true; entered.resolve(); await gate.promise }
      return text
    })
    s.call.mockImplementation(async (service, method, payload) => {
      const reply = await call(service, method, payload)
      if (point === 'interpretation' && method === RUNTIME_READ && (payload.operation as { kind?: string })?.kind === 'pane' && s.oc.model === 'DeepSeek V4.1 Flash Free' && !held) {
        held = true; entered.resolve(); await gate.promise
      }
      return reply
    })
    const pending = s.pick('opencode/deepseek-v4.1-flash-free', 'high')
    const rejected = expect(pending).rejects.toMatchObject({ code: 'BUSY' })
    await entered.promise
    const before = s.manager.selectedModel(s.value)
    if (point === 'capture') s.value.sessionId = 'replacement'
    else { s.controls.disconnected('engine-others'); s.transport.disconnected('engine-others') }
    const effects = [...s.oc.keys]
    gate.resolve()
    await rejected
    expect(s.oc.keys).toEqual(effects)
    expect(s.manager.selectedModel(s.value)).toBe(point === 'capture' ? null : before)
  })
})
