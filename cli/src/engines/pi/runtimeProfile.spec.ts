import { describe, expect, it } from 'vitest'
import {
  parsePi1FooterModel,
  parsePiFooterProfile,
  parsePiModelsOutput,
  parsePiThinkingSelection,
  piThinkingSteps,
} from './runtimeProfile.js'

// The real `pi --list-models` table on this computer (pi 0.82), plus a second row with thinking off to
// prove the column is read rather than assumed.
const OUTPUT = [
  'provider  model               context  max-out  thinking  images',
  'vibe      minimax/minimax-m3  500K     65.5K    yes       no    ',
  'openai    gpt-5.6             400K     100K     no        yes   ',
].join('\n')

// Pi 1.0.0's footer (2026-10-15): the usage line ends with the model, with no thinking level, and the
// window's edge clips a long name. A footer extension adds lines of its own around it.
describe('the Pi 1.0 footer', () => {
  const known = new Set(['Qwen/Qwen3.8-27B', 'DeepSeek-V4-Flash-0731'])
  const footer = (usage: string) => [
    '────────────────────────────────────────────────────────────────────────────────',
    '~/Workspace/aptis-notes',
    usage,
    '🔌 MCP: 2 servers enabled',
  ].join('\n')

  it('reads the model a catalog has', () => {
    expect(parsePi1FooterModel(footer('0.0%/256k (auto)                                                Qwen/Qwen3.8-27B'), known))
      .toBe('Qwen/Qwen3.8-27B')
    expect(parsePi1FooterModel(footer('↑14M ↓289k R21M CH0.0% 51.4%/256k (auto)          DeepSeek-V4-Flash-0731'), known))
      .toBe('DeepSeek-V4-Flash-0731')
  })

  it('takes no clipped name, and no name the catalog does not have', () => {
    expect(parsePi1FooterModel(footer('↑59M ↓1.4M R126M CH97.2% 25.7%/256k (auto)          DeepSeek-V4-Fla'), known)).toBeNull()
    expect(parsePi1FooterModel(footer('0.0%/256k (auto)          Some-Other-Model'), known)).toBeNull()
    expect(parsePi1FooterModel('no usage line here', known)).toBeNull()
  })
})

describe('pi model catalog', () => {
  it('reads provider, model and the thinking column', () => {
    expect(parsePiModelsOutput(OUTPUT)).toEqual([
      { id: 'vibe/minimax/minimax-m3', provider: 'vibe', model: 'minimax/minimax-m3', thinking: true },
      { id: 'openai/gpt-5.6', provider: 'openai', model: 'gpt-5.6', thinking: false },
    ])
  })

  it('skips the header and any short or noisy line', () => {
    expect(parsePiModelsOutput('provider  model  context  max-out  thinking  images')).toEqual([])
    expect(parsePiModelsOutput(' Warning: tmux extended-keys is off.')).toEqual([])
    expect(parsePiModelsOutput('')).toEqual([])
  })
})

describe('pi footer + thinking ladder', () => {
  it('reads model and thinking level from the idle footer', () => {
    const capture = [
      '/private/tmp/rp-probe/pi',
      '0.0%/500k (auto)                                          minimax/minimax-m3 • high',
    ].join('\n')

    expect(parsePiFooterProfile(capture)).toEqual({ model: 'minimax/minimax-m3', effort: 'high' })
  })

  it('refuses a footer whose level is not on the ladder', () => {
    expect(parsePiFooterProfile('0.0%/500k (auto)      minimax/minimax-m3 • nonsense')).toBeNull()
    expect(parsePiFooterProfile('nothing here')).toBeNull()
  })

  it('counts arrow steps along the ladder, and refuses to guess off it', () => {
    expect(piThinkingSteps('medium', 'high')).toBe(1)
    expect(piThinkingSteps('medium', 'off')).toBe(-3)
    expect(piThinkingSteps('max', 'max')).toBe(0)
    expect(piThinkingSteps('auto', 'high')).toBeNull()
  })

  it('reads the level pi marks as current in the Thinking Level list', () => {
    const capture = [
      'Thinking Level',
      'Select reasoning depth for thinking-capable models',
      '  off         No reasoning',
      '  low         Light reasoning (~2k tokens)',
      '→ medium      Moderate reasoning (~8k tokens)',
      '  high        Deep reasoning (~16k tokens)',
    ].join('\n')

    expect(parsePiThinkingSelection(capture)).toBe('medium')
    expect(parsePiThinkingSelection('no selection marker here')).toBeNull()
  })
})
