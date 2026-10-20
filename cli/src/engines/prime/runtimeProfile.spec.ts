import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../config/env.js'
import { loadEngine } from '../inProcess.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { encodeRuntimeProfile, RuntimeProfileManager } from '../../lib/runtimeProfile.js'
import {
  PRIME_THINKING_LEVELS,
  parsePrimeFooterProfile,
  parsePrimeModelsOutput,
  parsePrimeThinkingSelection,
  primeThinkingSteps,
} from './runtimeProfile.js'
import { inspectRuntimePane } from '../../lib/legacyPane.js'
import { primeRefusedThinkingLevel, restorePrimeDefaults, RuntimeProfileController } from '../../lib/runtimeControl.js'
import { primeOneShotArgs } from '../../lib/oneshot.js'

// Real captures from prime-agent 0.9.5 in tmux (2026-10-18), escapes and all.
const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../lib/__fixtures__/prime-${name}.txt`, import.meta.url)), 'utf8')

describe('prime model catalog', () => {
  it('reads every row of the real `prime-agent model list`, as <provider>/<model>', () => {
    const entries = parsePrimeModelsOutput(fixture('model-list'))
    expect(entries.length).toBe(29)
    expect(entries[0]).toEqual({ id: 'anthropic/claude-fable-5', provider: 'anthropic', model: 'claude-fable-5', thinking: true })
    expect(entries.find((entry) => entry.model === 'gpt-5.3-codex-spark'))
      .toEqual({ id: 'openai-codex/gpt-5.3-codex-spark', provider: 'openai-codex', model: 'gpt-5.3-codex-spark', thinking: true })
  })

  it('reads the thinking column rather than assuming it, and skips the header and noise', () => {
    expect(parsePrimeModelsOutput([
      'provider      model    context  max-out  thinking  images',
      'vibe          plain-1  128K     8K       no        no    ',
    ].join('\n'))).toEqual([{ id: 'vibe/plain-1', provider: 'vibe', model: 'plain-1', thinking: false }])
    expect(parsePrimeModelsOutput(' Warning: tmux extended-keys is off.')).toEqual([])
    expect(parsePrimeModelsOutput('')).toEqual([])
  })
})

describe('prime footer', () => {
  it('reads model and level off the real idle and working panes', () => {
    expect(parsePrimeFooterProfile(fixture('idle'))).toEqual({ model: 'claude-sonnet-5', effort: 'high' })
    expect(parsePrimeFooterProfile(fixture('working'))).toEqual({ model: 'claude-sonnet-5', effort: 'high' })
  })

  it('reads each shape the footer was seen in', () => {
    const footer = (cell: string) => `← manage                                                  ${cell}`
    expect(parsePrimeFooterProfile(footer('claude-opus-5-5:high · 0 (0%)'))).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    expect(parsePrimeFooterProfile(footer('claude-opus-5-5:off · 10k (1%)'))).toEqual({ model: 'claude-opus-5-5', effort: 'off' })
    expect(parsePrimeFooterProfile(footer('gpt-5.4-mini:xhigh · 10k (1%)'))).toEqual({ model: 'gpt-5.4-mini', effort: 'xhigh' })
    expect(parsePrimeFooterProfile(footer('claude-opus-5-5:max · 9.7k (1%)'))).toEqual({ model: 'claude-opus-5-5', effort: 'max' })
  })

  it('refuses a level off the ladder, and a line that is not the footer', () => {
    expect(parsePrimeFooterProfile('← manage   claude-opus-5-5:nonsense · 10k (1%)')).toBeNull()
    expect(parsePrimeFooterProfile('minimax/minimax-m3 • high')).toBeNull()
    expect(parsePrimeFooterProfile('nothing here')).toBeNull()
  })
})

describe('prime thinking ladder', () => {
  it('is the order `/effort` lists', () => {
    expect([...PRIME_THINKING_LEVELS]).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('counts steps, and refuses to guess off the ladder', () => {
    expect(primeThinkingSteps('medium', 'high')).toBe(1)
    expect(primeThinkingSteps('high', 'off')).toBe(-4)
    expect(primeThinkingSteps('auto', 'high')).toBeNull()
  })

  it('reads the current level of the list `/effort` opens, and not a completion row', () => {
    expect(parsePrimeThinkingSelection(fixture('effort-picker'))).toBe('high')
    expect(parsePrimeThinkingSelection(fixture('completion'))).toBeNull()
    expect(parsePrimeThinkingSelection(fixture('idle'))).toBeNull()
  })

  it('reads the level Prime refused as its latest answer, and only then', () => {
    expect(primeRefusedThinkingLevel(fixture('effort-error'))).toBeNull()
    expect(primeRefusedThinkingLevel([
      ' Model: gpt-5.4-mini', '',
      " ⚠ Error: Unknown thinking level 'max'. Available: off, minimal, low, medium, high, xhigh", '',
      ' >', '← manage      gpt-5.4-mini:xhigh · 10k (1%)',
    ].join('\n'))).toBe('max')
  })
})

describe('prime panes', () => {
  it('is idle at the composer under its footer', () => {
    expect(inspectRuntimePane('prime', fixture('idle'))).toEqual({ idle: true, plan: false, dialog: false, draft: false })
    expect(inspectRuntimePane('prime', fixture('effort-error')).idle).toBe(true)
  })

  it('is busy while the spinner line is drawn, though the footer stays', () => {
    expect(inspectRuntimePane('prime', fixture('working')).idle).toBe(false)
    expect(inspectRuntimePane('prime', fixture('working-tool')).idle).toBe(false)
  })

  it('reads a selector as a dialog, and typed text as a draft', () => {
    expect(inspectRuntimePane('prime', fixture('model-picker'))).toMatchObject({ idle: false, dialog: true })
    expect(inspectRuntimePane('prime', fixture('effort-picker'))).toMatchObject({ idle: false, dialog: true })
    expect(inspectRuntimePane('prime', fixture('completion'))).toMatchObject({ idle: false, draft: true })
  })
})

describe('prime global defaults', () => {
  const before = JSON.stringify({
    defaultProvider: 'anthropic', defaultModel: 'claude-opus-5-5', recentModels: ['anthropic/claude-opus-5-5'],
    defaultThinkingLevel: 'high', theme: 'prime',
  }, null, 2)

  it('puts back what `/model` and `/effort` wrote, and keeps every other key as it is now', () => {
    const after = JSON.stringify({
      defaultProvider: 'openai-codex', defaultModel: 'gpt-5.4-mini', recentModels: ['openai-codex/gpt-5.4-mini', 'anthropic/claude-opus-5-5'],
      defaultThinkingLevel: 'xhigh', theme: 'dark',
    }, null, 2)
    expect(JSON.parse(restorePrimeDefaults(after, before)!)).toEqual({
      defaultProvider: 'anthropic', defaultModel: 'claude-opus-5-5', recentModels: ['anthropic/claude-opus-5-5'],
      defaultThinkingLevel: 'high', theme: 'dark',
    })
  })

  it('removes a default that was not set, and writes nothing when nothing moved', () => {
    expect(JSON.parse(restorePrimeDefaults(JSON.stringify({ defaultThinkingLevel: 'max' }), '{}')!)).toEqual({})
    expect(restorePrimeDefaults(before, before)).toBeNull()
    expect(restorePrimeDefaults('not json', before)).toBeNull()
  })
})

describe('prime one-shot', () => {
  it('prints one answer with no session, tools, extensions or skills', () => {
    expect(primeOneShotArgs()).toEqual(['-p', '--no-session', '--no-tools', '--no-extensions', '--no-skills'])
    expect(primeOneShotArgs('anthropic/claude-haiku-4-5', 'low'))
      .toEqual(['-p', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--model', 'anthropic/claude-haiku-4-5', '--thinking', 'low'])
    expect(primeOneShotArgs(undefined, 'ultra')).toEqual(['-p', '--no-session', '--no-tools', '--no-extensions', '--no-skills'])
  })
})

describe('a prime switch, driven against a pane that answers as prime-agent 0.9.5 did', () => {
  const homes: string[] = []
  const agentDir = env.PRIME_AGENT_DIR
  afterEach(async () => {
    env.PRIME_AGENT_DIR = agentDir
    vi.restoreAllMocks()
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
  })

  const session = (): RegisteredSession => ({
    schemaVersion: 2, active: true, sessionId: 'p1', engine: 'prime', launcherId: 'h1', agentId: 'h1',
    boundAt: 0, transcriptPath: '/tmp/p1.jsonl', projectDir: 'tmp', cwd: '/tmp', tmuxPane: '%1', source: null, title: null, model: null,
    runtimes: [{ backend: 'tmux', paneId: '%1' }], primaryRuntimeKey: 'tmux\u0000%1', cliVersion: '0.9.5', processIdentity: null,
    registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
  } as unknown as RegisteredSession)

  /** The pane: the footer, the composer, the autocomplete that opens over a slash command, and the answers. */
  function primePane(ladders: Record<string, readonly string[]>, settingsPath: string) {
    const pane = { model: 'claude-opus-5-5', provider: 'anthropic', effort: 'high', draft: '', completion: false, status: [] as string[] }
    const keys: string[] = []
    const render = (): string => [
      ...pane.status.flatMap((line) => [` ${line}`, '']),
      ...(pane.completion ? ['    › anthropic/claude-sonnet-5       openrouter'] : []),
      ' Details mode (Ctrl+O to expand)', '', ` >  ${pane.draft}`, '',
      `← manage                                   ${pane.model}:${pane.effort} · 10k (1%)`,
    ].join('\n')
    const submit = async (): Promise<void> => {
      const [command, arg] = pane.draft.split(' ')
      pane.draft = ''
      if (command === '/model') {
        const slash = arg.indexOf('/')
        const ladder = ladders[arg]
        if (!ladder) throw new Error(`a selector would open for ${arg}`)
        pane.provider = arg.slice(0, slash)
        pane.model = arg.slice(slash + 1)
        if (!ladder.includes(pane.effort)) pane.effort = ladder[ladder.length - 1]
        pane.status.push(`Model: ${pane.model}`)
      } else if (command === '/effort') {
        const ladder = ladders[`${pane.provider}/${pane.model}`]!
        if (!ladder.includes(arg)) pane.status.push(`⚠ Error: Unknown thinking level '${arg}'. Available: ${ladder.join(', ')}`)
        else { pane.effort = arg; pane.status.push(`Thinking level: ${arg}`) }
      }
      // What Prime does to the person's defaults on every switch.
      const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>
      Object.assign(settings, { defaultProvider: pane.provider, defaultModel: pane.model, defaultThinkingLevel: pane.effort })
      await writeFile(settingsPath, JSON.stringify(settings, null, 2))
    }
    return {
      pane, keys,
      capture: async () => render(),
      sendLiteral: async (_target: string, text: string) => { keys.push(`literal:${text}`); pane.draft += text; pane.completion = text.startsWith('/'); return true },
      sendText: async () => { throw new Error('prime is never sent a submitted line: the autocomplete would take its Enter') },
      sendKey: async (_target: string, key: string) => {
        keys.push(key)
        if (key === 'Escape') pane.completion = false
        else if (key === 'C-u') pane.draft = ''
        else if (key === 'Enter') {
          if (pane.completion) throw new Error('Enter on an open autocomplete takes its row')
          await submit()
        }
        return true
      },
    }
  }

  /** [ladders] is what the pane accepts; [offered], what the catalog offers (every level, as Prime's says nothing). */
  async function setUp(ladders: Record<string, readonly string[]>, offeredLadders: Record<string, readonly string[]> = ladders) {
    const home = await mkdtemp(join(tmpdir(), 'prime-agent-dir-'))
    homes.push(home)
    const settingsPath = join(home, 'settings.json')
    const original = JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-opus-5-5', defaultThinkingLevel: 'high', theme: 'prime' }, null, 2)
    await writeFile(settingsPath, original)
    env.PRIME_AGENT_DIR = home
    const value = session()
    const manager = new RuntimeProfileManager()
    expect(await loadEngine('prime')).toBeTruthy()
    manager.hydrate(value, [
      JSON.stringify({ type: 'model_change', provider: 'anthropic', modelId: 'claude-opus-5-5' }),
      JSON.stringify({ type: 'thinking_level_change', thinkingLevel: 'high' }),
    ])
    vi.spyOn(manager, 'supportsControl').mockReturnValue(true)
    const offered = Object.entries(offeredLadders).flatMap(([model, ladder]) => ladder.map((effort) =>
      ({ id: encodeRuntimeProfile({ sessionId: 'h1', engine: 'prime', model, effort }), displayName: model })))
    vi.spyOn(manager, 'modelsForSession').mockResolvedValue(offered)
    const terminal = primePane(ladders, settingsPath)
    const controller = new RuntimeProfileController({
      modelControlFor: () => undefined,
      readScreen: async (_s, capture) => ({ pane: inspectRuntimePane('prime', capture ?? '') }) as never,
      manager: manager as never,
      getSession: () => value,
      validateRuntime: async () => true,
      capture: terminal.capture,
      sendText: terminal.sendText,
      sendLiteral: terminal.sendLiteral,
      sendKey: terminal.sendKey,
      acquireInput: () => () => undefined,
    })
    return { value, manager, terminal, controller, settingsPath, original }
  }

  const LADDERS = {
    'anthropic/claude-opus-5-5': PRIME_THINKING_LEVELS,
    'openai-codex/gpt-5.4-mini': PRIME_THINKING_LEVELS.slice(0, -1),
  }

  it('switches model and level by command, closing the autocomplete first, and puts the defaults back', async () => {
    const { value, manager, terminal, controller, settingsPath, original } = await setUp(LADDERS)
    const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'prime', model: 'openai-codex/gpt-5.4-mini', effort: 'low' })

    await controller.setProfile('h1', target)

    expect(manager.selectedModel(value)).toBe(target)
    expect(terminal.keys).toEqual([
      'literal:/model openai-codex/gpt-5.4-mini', 'Escape', 'Enter',
      'literal:/effort low', 'Escape', 'Enter',
    ])
    expect(await readFile(settingsPath, 'utf8')).toBe(original)
  }, 15_000)

  it('answers EFFORT_UNSUPPORTED from the pane when the model\'s ladder stops short, and still puts the defaults back', async () => {
    const short = { 'anthropic/claude-opus-5-5': PRIME_THINKING_LEVELS.slice(0, -1) }
    const { terminal, controller, settingsPath, original } = await setUp(short, { 'anthropic/claude-opus-5-5': PRIME_THINKING_LEVELS })
    const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'prime', model: 'anthropic/claude-opus-5-5', effort: 'max' })

    await expect(controller.setProfile('h1', target)).rejects.toMatchObject({ code: 'EFFORT_UNSUPPORTED' })

    expect(terminal.keys.slice(0, 3)).toEqual(['literal:/effort max', 'Escape', 'Enter'])
    expect(await readFile(settingsPath, 'utf8')).toBe(original)
  }, 15_000)
})
