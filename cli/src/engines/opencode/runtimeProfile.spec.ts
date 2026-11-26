import { describe, expect, it } from 'vitest'
import {
  countOpencodePickers,
  countOpencodeVariantPickers,
  opencodeFooterModelId,
  parseOpencodeFooter,
  opencodeRowMatches,
  opencodeRowNamesModel,
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
    expect(parseOpencodeVariantRows(typed)).toEqual([{ name: 'high', current: false, cursor: false }, { name: 'xhigh', current: false, cursor: false }])
    const open = ['Select variant   esc', '     Search', '   ● Default', '     low', '  ╹▀▀▀▀'].join('\n')
    expect(parseOpencodeVariantRows(open)).toEqual([{ name: 'Default', current: true, cursor: false }, { name: 'low', current: false, cursor: false }])
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

  // OpenCode 2.4.1, Harness OS (MSI, 2026-11-26): the pickers are drawn over the conversation, whose words share their
  // lines, the row under the cursor is edged `┃` and the current one marked `▪`, and with only the free models the
  // model picker is `Free models`, one cell a row. Read as 2.2's, no switch from the phone ever landed.
  const over = (left: string, right: string): string => `${left.padEnd(76)}${right}`
  it('reads OpenCode 2.4\'s free model picker drawn over the conversation', () => {
    const open = [
      over('     + 1 thought', '    Free models                                      esc'),
      over('     Sure, here it is.', '    Connect a provider for access to more models'),
      over('     Build · Big Pickle · 2.7s · 128.7 tok/s', ''),
      over('  ┃', '    Search'),
      over('', ''),
      over('  ┃  list the files', '┃ ▪ DeepSeek V4.1 Flash Free'),
      over('  ┃', '    Big Pickle'),
      over('', '    Flint 40B Free'),
      over('', ''),
      over('', '    Text, Image · 200K · Reasoning'),
      over('', '    connect provider ctrl+a              favorite ctrl+f'),
      '  ┃  Build · DeepSeek V4.1 Flash Free OpenCode',
    ].join('\n')
    expect(countOpencodePickers(open)).toBe(1)
    expect(parseOpencodePickerRows(open)).toEqual([
      { display: 'DeepSeek V4.1 Flash Free', provider: '', current: true },
      { display: 'Big Pickle', provider: '', current: false },
      { display: 'Flint 40B Free', provider: '', current: false },
    ])
    const filtered = [
      over('', '    Free models                                      esc'),
      over('     Sure, here it is.', '    Connect a provider for access to more models'),
      over('', ''),
      over('', '    flint 40b free'),
      over('', ''),
      over('  ┃  list the files', '┃   Flint 40B Free'),
      over('', ''),
      over('', '    Text · 262K · Reasoning'),
      over('', ''),
      over('', '    connect provider ctrl+a              favorite ctrl+f'),
    ].join('\n')
    const rows = parseOpencodePickerRows(filtered)!
    expect(rows).toEqual([{ display: 'Flint 40B Free', provider: '', current: false }])
    // A filter naming the provider too finds nothing: the rows name the model alone.
    const none = [over('', '    Free models      esc'), over('', '    Connect a provider for access to more models'), over('', ''),
      over('', '    flint 40b free opencode'), over('', ''), over('', '    No results found'), over('', ''),
      over('', '    connect provider ctrl+a              favorite ctrl+f')].join('\n')
    expect(parseOpencodePickerRows(none)).toEqual([])
    const flint = { id: 'opencode/flint-40b-free', provider: 'opencode', model: 'flint-40b-free', name: 'Flint 40B Free', filter: 'flint 40b free opencode', modelFilter: 'flint 40b free', efforts: [] }
    expect(opencodeRowNamesModel(flint, rows[0])).toBe(true)
  })

  // The phone's own size, 50×20, as Chat UI's model sheet sets it: the note wraps, the last line is wrapped or not drawn
  // at all, and the composer's edge is in the picker's column. Every switch from the phone timed out (MSI, 2026-11-26).
  it('reads OpenCode 2.4\'s free model picker on a phone\'s 50×20', () => {
    const open = [
      '   Greeting                      +',
      '  ┃',
      '  ┃  hello there',
      '  ┃',
      '',
      '',
      '     Free models                          esc',
      '     Connect a provider for access to more',
      '     models',
      '',
      '     Search',
      '',
      ' ┃ ▪ Flint 40B Free',
      '     DeepSeek V4.1 Flash Free',
      '     Big Pickle',
      '',
      '     Text · 262K · Reasoning',
      '',
    ].map((line) => line.padEnd(50)).join('\n') // tmux pads each line to the pane's width
    expect(countOpencodePickers(open)).toBe(1)
    expect(parseOpencodePickerRows(open)).toEqual([
      { display: 'Flint 40B Free', provider: '', current: true },
      { display: 'DeepSeek V4.1 Flash Free', provider: '', current: false },
      { display: 'Big Pickle', provider: '', current: false },
    ])
    const filtered = [
      '   Greeting                      +',
      '  ┃  hello there',
      '',
      '     Free models                          esc',
      '     Connect a provider for access to more',
      '     models',
      '',
      '     beam free',
      '',
      ' ┃   Beam Free',
      '',
      '     Text · 1M · Reasoning',
      '',
      '     connect provider         favorite ctrl+f',
      '     ctrl+a',
    ].map((line) => line.padEnd(50)).join('\n')
    expect(parseOpencodePickerRows(filtered)).toEqual([{ display: 'Beam Free', provider: '', current: false }])
  })

  it('reads OpenCode 2.4\'s model picker with a provider connected, whose title is its filter box', () => {
    // MSI, 2.4.1, 2026-11-26, a project whose opencode.json adds a provider: headings, and a model's name and its
    // provider's on one row.
    const at = (left: string, right: string): string => `${left.padEnd(45)}${right}`
    const open = [
      at('', '    Search models                                    esc'),
      at('', '    Recent'),
      at('', '┃ ▪ Big Pickle OpenCode'),
      at('', '    Harness Check'),
      at('', '    Check Stub'),
      at('  ┃  Ask', '    Free'),
      at('  ┃  Buil', '    Iceman Free'),
      at('', '    connect integration ctrl+a           favorite ctrl+f'),
    ].join('\n')
    expect(countOpencodePickers(open)).toBe(1)
    expect(parseOpencodePickerRows(open)!.map((row) => row.display)).toEqual(
      ['Recent', 'Big Pickle OpenCode', 'Harness Check', 'Check Stub', 'Free', 'Iceman Free'])
    const filtered = [
      at('', '    stub                                             esc'),
      at('', '┃   Check Stub Harness Check'),
      at('', '    connect integration ctrl+a           favorite ctrl+f'),
      at('  ┃  Build · Big Pickle OpenCode', ''),
    ].join('\n')
    const rows = parseOpencodePickerRows(filtered)!
    expect(rows).toEqual([{ display: 'Check Stub Harness Check', provider: '', current: false }])
    const stub = { id: 'harness-check/stub', provider: 'harness-check', model: 'stub', name: 'Check Stub', filter: 'check stub harness check', modelFilter: 'check stub', efforts: [] }
    expect(opencodeRowMatches(stub, rows[0])).toBe(true)
  })

  it('reads OpenCode 2.4\'s variant picker drawn over the conversation', () => {
    const open = [
      over('     + 1 thought', '    Select variant                                   esc'),
      over('     Sure, here it is.', ''),
      over('', '┃ ▪ Default'),
      over('     Build · Big Pickle · 2.7s · 128.7 tok/s', '    low'),
      over('  ┃  list the files', '    high'),
      over('     + 1 thought', ''),
      over('     A long answer that runs on past the middle of this wide terminal and under the picker', ''),
    ].join('\n')
    expect(countOpencodeVariantPickers(open)).toBe(1)
    expect(parseOpencodeVariantRows(open)).toEqual([
      { name: 'Default', current: true, cursor: true }, { name: 'low', current: false, cursor: false }, { name: 'high', current: false, cursor: false },
    ])
  })
})
