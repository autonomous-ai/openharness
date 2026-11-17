import { describe, expect, it } from 'vitest'
import {
  countOpencodePickers,
  countOpencodeVariantPickers,
  opencodeFooterModelId,
  parseOpencodeFooter,
  opencodeRowMatches,
  parseOpencodeApiModels,
  parseOpencodeModelsOutput,
  parseOpencodePickerRows,
  parseOpencodeVariantRows,
} from './runtimeProfile.js'

// Real `opencode models` lines from this computer (opencode 1.18.7), including the nested-model form.
const OUTPUT = [
  'opencode/ling-3.0-flash-free',
  'opencode-go/kimi-k3',
  'opencode-go/minimax-m3',
  'opencode-go/mimo-v2.5',
  'opencode-go/mimo-v2.5-pro',
  'vibe/minimax/minimax-m3',
  'not a model line',
].join('\n')

const catalog = parseOpencodeModelsOutput(OUTPUT)

describe('opencode model catalog', () => {
  it('reads provider/model and builds a picker filter from the model leaf plus provider', () => {
    expect(catalog.map((t) => t.id)).toEqual([
      'opencode/ling-3.0-flash-free',
      'opencode-go/kimi-k3',
      'opencode-go/minimax-m3',
      'opencode-go/mimo-v2.5',
      'opencode-go/mimo-v2.5-pro',
      'vibe/minimax/minimax-m3',
    ])
    // The picker renders the model's LAST segment, so that is what the filter is built from.
    expect(catalog.find((t) => t.id === 'vibe/minimax/minimax-m3')?.filter).toBe('minimax m3 vibe')
    expect(catalog.find((t) => t.id === 'opencode-go/kimi-k3')?.filter).toBe('kimi k3 opencode go')
  })

  it('parses the picker rows between its header and the hint line', () => {
    // Verbatim from the live picker, filtered to "minimax m3": two rows that differ only by provider.
    const capture = [
      '        Select model                                     esc',
      '        minimax m3',
      '        MiniMax-M3                               OpenCode Go',
      '      ● MiniMax M3 (vibe)             Vibe Gateway (Minimax)',
      '        Connect provider ctrl+a  Favorite ctrl+f',
      '   ┃  Ask anything...',
    ].join('\n')

    const rows = parseOpencodePickerRows(capture)
    // The filter box ("minimax m3") sits between the header and the rows and must not be counted as one.
    expect(rows).toEqual([
      { display: 'MiniMax-M3', provider: 'OpenCode Go', current: false },
      { display: 'MiniMax M3 (vibe)', provider: 'Vibe Gateway (Minimax)', current: true },
    ])
    expect(parseOpencodePickerRows('no picker here')).toBeNull()
  })

  it('reads the CURRENT picker, not an earlier one left in the scrollback', () => {
    // A tmux capture carries history; the pane really does hold several openings of the same picker.
    const stale = [
      '        Select model                                     esc',
      '        kimi',
      '        Kimi K3 (2x usage)                       OpenCode Go',
      '        Kimi K2.6                                OpenCode Go',
      '        Connect provider ctrl+a  Favorite ctrl+f',
      '        Select model                                     esc',
      '        kimi k3 opencode go',
      '        Kimi K3 (2x usage)                       OpenCode Go',
      '        Connect provider ctrl+a  Favorite ctrl+f',
    ].join('\n')

    expect(parseOpencodePickerRows(stale)).toEqual([
      { display: 'Kimi K3 (2x usage)', provider: 'OpenCode Go', current: false },
    ])
  })

  it('counts picker openings so a stale one cannot pass for a fresh one', () => {
    const two = ['   Select model   esc', '   kimi', '   Select model   esc', '   kimi k3'].join('\n')
    expect(countOpencodePickers(two)).toBe(2)
    expect(countOpencodePickers('nothing')).toBe(0)
  })

  it('tells two same-named models apart by provider', () => {
    const rows = parseOpencodePickerRows([
      '        Select model    esc',
      '        minimax m3',
      '        MiniMax-M3                               OpenCode Go',
      '      ● MiniMax M3 (vibe)             Vibe Gateway (Minimax)',
      '        Connect provider ctrl+a',
    ].join('\n'))!
    const go = catalog.find((t) => t.id === 'opencode-go/minimax-m3')!
    const vibe = catalog.find((t) => t.id === 'vibe/minimax/minimax-m3')!

    expect(rows.filter((r) => opencodeRowMatches(go, r))).toEqual([rows[0]])
    expect(rows.filter((r) => opencodeRowMatches(vibe, r))).toEqual([rows[1]])
  })

  it('resolves the footer back to a catalog id, longest model name first', () => {
    // Both footers are real: before and after the probe switched the model.
    expect(opencodeFooterModelId('┃  Build · MiniMax M3 (vibe) Vibe Gateway (Minimax)', catalog))
      .toBe('vibe/minimax/minimax-m3')
    expect(opencodeFooterModelId('┃  Build · Ling-3.0-flash Free OpenCode Zen', catalog))
      .toBe('opencode/ling-3.0-flash-free')
    // `MiMo V2.5 Pro` must not collapse onto `mimo-v2.5`.
    expect(opencodeFooterModelId('┃  Build · MiMo V2.5 Pro OpenCode Go', catalog))
      .toBe('opencode-go/mimo-v2.5-pro')
    expect(opencodeFooterModelId('┃  Ask anything...', catalog)).toBeNull()
  })

  it('keeps the reasoning level out of the model it searches for', () => {
    // Builds that have a reasoning axis print it after a second separator. Taking everything after
    // the FIRST one swallowed the level into the model text, so the catalog was searched for
    // "…OpenCode Zen high" and the level was thrown away.
    expect(opencodeFooterModelId('┃  Build · Ling-3.0-flash Free OpenCode Zen · high', catalog))
      .toBe('opencode/ling-3.0-flash-free')
  })

  it('keeps the project path in the next terminal column out of the model', () => {
    expect(parseOpencodeFooter('┃  Build auto · Muse Spark 1.3 Free OpenCode Zen                         /private/tmp/harness-agent-switch-e2e'))
      .toEqual({ target: 'Muse Spark 1.3 Free OpenCode Zen', effort: null })
  })

  it('reads model and level apart, from a real footer', () => {
    expect(parseOpencodeFooter('┃  Build · Ox Alpha Free (Unlimited) OpenCode Zen · high'))
      .toEqual({ target: 'Ox Alpha Free (Unlimited) OpenCode Zen', effort: 'high' })

    // A build with no reasoning axis says nothing about one, and nothing is what it gets.
    expect(parseOpencodeFooter('┃  Build · MiniMax M3 (vibe) Vibe Gateway (Minimax)'))
      .toEqual({ target: 'MiniMax M3 (vibe) Vibe Gateway (Minimax)', effort: null })

    // A trailing segment that is not a single bare word is part of a name, not a level: guessing one
    // would put a wrong value on the chip rather than no value.
    expect(parseOpencodeFooter('┃  Build · Some Model Provider · 2 files')?.effort).toBeNull()

    expect(parseOpencodeFooter('┃  Ask anything...')).toBeNull()
  })

  it('still names the model when the catalog does not list it', () => {
    // Not hypothetical: with no provider connected OpenCode runs a built-in free model that
    // `opencode models` never prints, and insisting on a catalog match left the chips blank while
    // the terminal named the model two lines below.
    const footer = '┃  Build · Ox Alpha Free (Unlimited) OpenCode Zen · high'
    expect(opencodeFooterModelId(footer, catalog)).toBeNull()
    expect(parseOpencodeFooter(footer)?.target).toBe('Ox Alpha Free (Unlimited) OpenCode Zen')
  })
})

describe('opencode 2 model list', () => {
  // `opencode api GET /api/model` on MSI (opencode 2.2.6, 2026-11-17), trimmed to the fields read and three rows.
  const API = JSON.stringify({
    location: { directory: '/home/me' },
    data: [
      { id: 'big-pickle', providerID: 'opencode', name: 'Big Pickle', variants: [], status: 'active', enabled: true },
      { id: 'deepseek-v4.1-flash-free', providerID: 'opencode', name: 'DeepSeek V4.1 Flash Free', status: 'active', enabled: true,
        variants: [{ id: 'low' }, { id: 'high' }, { id: 'max' }, { id: 'NOT A WORD' }] },
      { id: 'retired', providerID: 'opencode', name: 'Retired', variants: [], status: 'deprecated', enabled: true },
      { id: 'off', providerID: 'opencode', name: 'Off', variants: [], enabled: false },
    ],
  })
  const listed = parseOpencodeApiModels(API)

  it('names each model as the picker draws it, with its variants for efforts', () => {
    expect(listed.map((m) => [m.id, m.name, m.efforts, m.modelFilter])).toEqual([
      ['opencode/big-pickle', 'Big Pickle', [], 'big pickle'],
      ['opencode/deepseek-v4.1-flash-free', 'DeepSeek V4.1 Flash Free', ['low', 'high', 'max'], 'deepseek v4.1 flash free'],
    ])
    expect(parseOpencodeApiModels('<!doctype html>')).toEqual([])
    expect(parseOpencodeApiModels('{"data":{}}')).toEqual([])
  })

  it('resolves the footer as a phone draws it: no provider after the name, or the name cut short', () => {
    // Measured on MSI's 50 columns after a switch.
    expect(opencodeFooterModelId('┃  Build · DeepSeek V4.1 Flash Free', listed)).toBe('opencode/deepseek-v4.1-flash-free')
    expect(opencodeFooterModelId('┃  Build · DeepSeek V4.1 Flash F… · high', listed)).toBe('opencode/deepseek-v4.1-flash-free')
    expect(opencodeFooterModelId('┃  Build auto · Big Pickle OpenCode', listed)).toBe('opencode/big-pickle')
    // Another provider's model of the same name is not this one, and a cut that fits two names is neither.
    expect(opencodeFooterModelId('┃  Build · Big Pickle Vibe Gateway', listed)).toBeNull()
    const twins = parseOpencodeApiModels(JSON.stringify({ data: [
      { id: 'deepseek-a', providerID: 'opencode', name: 'DeepSeek A', variants: [] },
      { id: 'deepseek-b', providerID: 'opencode', name: 'DeepSeek B', variants: [] },
    ] }))
    expect(opencodeFooterModelId('┃  Build · DeepSe…', twins)).toBeNull()
  })
})

describe('opencode 2 pickers', () => {
  it('reads the variant picker\'s rows, the filter box left out, down to the composer', () => {
    // MSI, 2026-11-17, `/effort` on DeepSeek V4.1 Flash Free with `high` typed.
    const typed = ['     Select variant                       esc', '     high', '     high', '     xhigh', '  ┃', '  ┃  Build · DeepSeek V4.1 Flash Free'].join('\n')
    expect(parseOpencodeVariantRows(typed)).toEqual([{ name: 'high', current: false }, { name: 'xhigh', current: false }])
    const open = ['Select variant   esc', '     Search', '   ● Default', '     low', '  ╹▀▀▀▀'].join('\n')
    expect(parseOpencodeVariantRows(open)).toEqual([{ name: 'Default', current: true }, { name: 'low', current: false }])
    expect(countOpencodeVariantPickers(`${open}\n${typed}`)).toBe(2)
    expect(parseOpencodeVariantRows('┃  Build · Big Pickle')).toBeNull()
  })

  it('reads the model picker\'s rows above OpenCode 2.2\'s integrations line and its path column', () => {
    const capture = [
      '     Select model                         esc',
      '     deepseek',
      '     DeepSeek V4.1 Flash Free            Free',
      '     View all integrations ctrl+a',
      '     Favorite ctrl+f',
      '  ┃  Build auto · Big Pickle OpenCode',
      '  ~/projects/claude-2026-11-12-04-14   7.1K (4%)',
    ].join('\n')
    expect(parseOpencodePickerRows(capture)).toEqual([{ display: 'DeepSeek V4.1 Flash Free', provider: 'Free', current: false }])
  })
})
