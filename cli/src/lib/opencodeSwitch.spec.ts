import { describe, expect, it, vi } from 'vitest'
import { parseOpencodeApiModels } from '../engines/opencode/runtimeProfile.js'
import type { RegisteredSession } from './registry.js'
import { encodeRuntimeProfile, RuntimeProfileManager } from './runtimeProfile.js'
import { RuntimeProfileController } from './runtimeProfileController.js'

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

  private rows(): string[] {
    const all = this.picker === 'model' ? CATALOG.map((m) => m.name!) : ['Default', ...CATALOG.find((m) => m.name === this.model)!.efforts!]
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
    setTimeout(() => { this.listed = ['/models', '/effort'].includes(this.composer) }, 20)
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
