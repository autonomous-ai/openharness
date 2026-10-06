import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CODEX_0145_ALL_MODELS, CODEX_0145_REASONING, CODEX_0160_ADVANCED, CODEX_0160_ALL_MODELS, CODEX_0160_ALL_MODELS_NARROW,
  CODEX_0160_ALL_MODELS_REFRESHED, CODEX_0160_ALL_MODELS_SPACED, CODEX_0160_COMPOSER, CODEX_0160_QUICK_MENU,
  CODEX_0160_QUICK_MENU_SHARED_NAME, CODEX_0160_REASONING, CODEX_0160_REASONING_SPACED, CODEX_0160_RESERVE,
  CODEX_0160_RESERVE_REASONING, CODEX_0160_SHARED_NAMES,
} from '../../lib/__fixtures__/codexModelPickers.js'
import {
  chooseCodexRow, codexDigitPressable, codexEffortRows, isCodexAutoModel, parseCodexCatalog, parseCodexPicker,
  sameCodexPicker, type CodexCatalogModel, type CodexPicker,
} from './modelPicker.js'

const FIXTURES = join(import.meta.dirname, '../../lib/__fixtures__')
/** Codex 0.160's own catalog, in the shape of its models_cache.json. */
const CATALOG = parseCodexCatalog(JSON.parse(readFileSync(join(FIXTURES, 'codex-home-0.160/models_cache.json'), 'utf8')))

const model = (slug: string, displayName: string, efforts: string[], defaultEffort = efforts[0] ?? 'none', listed = true): CodexCatalogModel =>
  ({ slug, displayName, listed, defaultEffort, efforts })
/** The catalog of 0.160's display-name test: an auto preset and a custom-provider model whose name has a space. */
const CUSTOM = [
  model('codex-auto-fast', 'Auto Fast', ['low', 'high'], 'high'),
  model('us.openai.gpt-5.6-luna', 'GPT-5.6 Luna', ['low', 'high'], 'high'),
]
const parsed = (capture: string): CodexPicker => {
  const picker = parseCodexPicker(capture)
  if (!picker) throw new Error('no picker')
  return picker
}
const names = (picker: CodexPicker) => picker.rows.map((row) => `${row.number}. ${row.name}${row.current ? ' *' : ''}${row.isDefault ? ' (d)' : ''}`)

describe('Codex model picker, read off the pane', () => {
  it('reads 0.160 rows by their whole display name, markers apart', () => {
    const list = parsed(CODEX_0160_ALL_MODELS)
    expect(list.kind).toBe('models')
    expect(names(list)).toEqual([
      '1. GPT-6.1-Sol (d)', '2. GPT-6-Astra', '3. GPT-6-Sol', '4. GPT-6-Luna', '5. GPT-5.6-Sol', '6. GPT-5.6-Terra',
      '7. GPT-5.6-Luna', '8. GPT-5.5 *',
    ])
    // A name with a space in it is one name; the old reader stopped at the space and found nothing.
    expect(names(parsed(CODEX_0160_ALL_MODELS_SPACED))).toEqual(['1. GPT-5.6 Luna *'])
  })

  it('reads the quick menu, the reserve picker and both reasoning screens', () => {
    expect(parsed(CODEX_0160_QUICK_MENU)).toMatchObject({ kind: 'quick', model: null })
    expect(names(parsed(CODEX_0160_QUICK_MENU))).toEqual(['1. Auto Fast', '2. All models *'])
    expect(parsed(CODEX_0160_RESERVE)).toMatchObject({ kind: 'reserve' })
    expect(names(parsed(CODEX_0160_RESERVE))).toEqual(['1. GPT-6-Luna *'])

    const reasoning = parsed(CODEX_0160_REASONING)
    expect(reasoning).toMatchObject({ kind: 'efforts', model: 'GPT-5.5' })
    expect(codexEffortRows(reasoning)).toEqual({
      efforts: new Map([['low', 1], ['medium', 2], ['high', 3], ['xhigh', 4], ['persistent', 5]]),
      defaultRow: 2,
      advancedRow: 6,
    })
    // `(default)` is part of an effort's name and `(current)` is Codex's marker; a row can carry both.
    const spaced = parsed(CODEX_0160_REASONING_SPACED)
    expect(spaced.model).toBe('GPT-5.6 Luna')
    expect(codexEffortRows(spaced)).toMatchObject({ efforts: new Map([['low', 1], ['high', 2]]), defaultRow: 2, advancedRow: null })
    const advanced = parsed(CODEX_0160_ADVANCED)
    expect(advanced.kind).toBe('advanced')
    expect(codexEffortRows(advanced).efforts).toEqual(new Map([['max', 1], ['ultra', 2]]))
    expect(parsed(CODEX_0160_RESERVE_REASONING).model).toBe('GPT-6-Luna')
    // An effort Codex does not know by name (its `Custom`) is drawn as itself, and is not one to pick.
    expect(codexEffortRows(parsed('  Select Reasoning Level for GPT-5.5\n\n  1. Low\n  2. future')).efforts).toEqual(new Map([['low', 1]]))
  })

  it('reads 0.145, which named its rows and its reasoning title by slug', () => {
    const list = parsed(CODEX_0145_ALL_MODELS)
    expect(list.kind).toBe('models')
    expect(names(list)).toEqual(['1. gpt-5.6-sol (d)', '2. gpt-5.6-terra', '3. gpt-5.6-luna', '4. gpt-5.5', '5. gpt-5.2 *'])
    expect(parsed(CODEX_0145_REASONING)).toMatchObject({ kind: 'efforts', model: 'gpt-5.4' })
    expect(codexEffortRows(parsed(CODEX_0145_REASONING))).toMatchObject({ defaultRow: 2, advancedRow: 5 })
  })

  it('joins a header and a name that wrapped in a narrow pane', () => {
    const list = parsed(CODEX_0160_ALL_MODELS_NARROW)
    expect(list.kind).toBe('models')
    expect(names(list)).toEqual(['1. GPT-6.1-Sol (d)', '2. GPT-6-Astra', '3. GPT-6-Sol', '4. GPT-5.6 Luna *'])
  })

  it('finds no picker under a newer composer, nor a screen it does not know', () => {
    expect(parseCodexPicker(CODEX_0160_COMPOSER)).toBeNull()
    expect(parseCodexPicker(`${CODEX_0160_ALL_MODELS}\n› \n  gpt-5.5 high · /tmp`)).toBeNull()
    // A title with no rows under it, and one Codex does not draw.
    expect(parseCodexPicker('  Select Model and Effort\n\n  enter select · esc back')).toBeNull()
    expect(parseCodexPicker('  Select Model\n  Something else entirely\n\n› 1. GPT-5.5')).toBeNull()
    expect(parseCodexPicker('  Select Reasoning Level for\n\n› 1. Low')).toBeNull()
  })

  it('tells a list redrawn with its rows renumbered from the same list', () => {
    expect(sameCodexPicker(parsed(CODEX_0160_ALL_MODELS), parsed(CODEX_0160_ALL_MODELS))).toBe(true)
    expect(sameCodexPicker(parsed(CODEX_0160_ALL_MODELS), parsed(CODEX_0160_ALL_MODELS_REFRESHED))).toBe(false)
    expect(sameCodexPicker(parsed(CODEX_0160_ALL_MODELS), parsed(CODEX_0145_ALL_MODELS))).toBe(false)
    const current = parsed(CODEX_0160_ALL_MODELS)
    const moved = { ...current, rows: current.rows.map((row) => ({ ...row, current: row.number === 1 })) }
    expect(sameCodexPicker(current, moved)).toBe(false)
  })
})

describe('Codex catalog', () => {
  it('reads models_cache.json as Codex builds its picker from it', () => {
    expect(CATALOG.filter((entry) => entry.listed).map((entry) => entry.slug)).toEqual([
      'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5',
    ])
    expect(CATALOG.find((entry) => entry.slug === 'gpt-5.5')).toEqual({
      slug: 'gpt-5.5', displayName: 'GPT-5.5', listed: true, defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh'],
    })
    expect(CATALOG.find((entry) => entry.slug === 'codex-auto-review')).toMatchObject({ listed: false })
  })

  it('takes what it can from a damaged cache, as Codex reads a missing default effort', () => {
    expect(parseCodexCatalog(null)).toEqual([])
    expect(parseCodexCatalog({ models: 'none' })).toEqual([])
    expect(parseCodexCatalog({ models: [null, { display_name: 'No slug' }, { slug: 'gpt-x', supported_reasoning_levels: [{}, { effort: 'High' }] }, { slug: 'gpt-y' }] }))
      .toEqual([
        { slug: 'gpt-x', displayName: 'gpt-x', listed: false, defaultEffort: 'none', efforts: ['high'] },
        { slug: 'gpt-y', displayName: 'gpt-y', listed: false, defaultEffort: 'none', efforts: [] },
      ])
  })

  it('knows the quick presets by their slug', () => {
    expect(isCodexAutoModel('codex-auto-fast')).toBe(true)
    expect(isCodexAutoModel('gpt-5.5')).toBe(false)
  })
})

describe('the row a target is reached through', () => {
  it('finds a 0.160 row by the target display name, and a 0.145 row by its slug', () => {
    expect(chooseCodexRow(parsed(CODEX_0160_ALL_MODELS), { model: 'gpt-6-luna', effort: 'high' }, CATALOG))
      .toMatchObject({ row: { number: 4, name: 'GPT-6-Luna' }, opens: 'efforts' })
    expect(chooseCodexRow(parsed(CODEX_0160_ALL_MODELS_SPACED), { model: 'us.openai.gpt-5.6-luna', effort: 'low' }, CUSTOM))
      .toMatchObject({ row: { number: 1 }, opens: 'efforts' })
    expect(chooseCodexRow(parsed(CODEX_0145_ALL_MODELS), { model: 'gpt-5.6-terra', effort: 'low' }, CATALOG))
      .toMatchObject({ row: { number: 2, name: 'gpt-5.6-terra' }, opens: 'efforts' })
    // Renumbered by a refresh: the same model, a row further down.
    expect(chooseCodexRow(parsed(CODEX_0160_ALL_MODELS_REFRESHED), { model: 'gpt-6-luna', effort: 'high' }, CATALOG))
      .toMatchObject({ row: { number: 5 } })
  })

  it('goes through All models from the quick menu for any model that is not a quick preset', () => {
    expect(chooseCodexRow(parsed(CODEX_0160_QUICK_MENU), { model: 'us.openai.gpt-5.6-luna', effort: 'low' }, CUSTOM))
      .toMatchObject({ row: { number: 2, name: 'All models' }, opens: 'list' })
    // The first row carries gpt-5.5's name but is an auto preset: gpt-5.5 itself is behind All models.
    const shared = [...CATALOG, model('codex-auto-test', 'GPT-5.5', ['low', 'medium', 'high'], 'medium')]
    expect(chooseCodexRow(parsed(CODEX_0160_QUICK_MENU_SHARED_NAME), { model: 'gpt-5.5', effort: 'high' }, shared))
      .toMatchObject({ row: { number: 2 }, opens: 'list' })
    expect(chooseCodexRow(parsed(CODEX_0160_QUICK_MENU_SHARED_NAME), { model: 'codex-auto-test', effort: 'auto' }, shared))
      .toMatchObject({ row: { number: 1 }, opens: 'applied', effort: 'medium' })
    expect(chooseCodexRow(parsed('  Select Model\n  Pick a quick auto mode or browse all models.\n\n  1. Auto Fast'), { model: 'gpt-5.5', effort: 'high' }, CATALOG))
      .toEqual({ error: 'MODEL_UNAVAILABLE' })
  })

  it('knows which rows apply at once, and refuses an effort such a row cannot give', () => {
    // A quick preset without Max or Ultra applies its default effort, here High.
    const quick = parsed(CODEX_0160_QUICK_MENU)
    expect(chooseCodexRow(quick, { model: 'codex-auto-fast', effort: 'auto' }, CUSTOM)).toMatchObject({ row: { number: 1 }, opens: 'applied', effort: 'high' })
    expect(chooseCodexRow(quick, { model: 'codex-auto-fast', effort: 'high' }, CUSTOM)).toMatchObject({ opens: 'applied' })
    expect(chooseCodexRow(quick, { model: 'codex-auto-fast', effort: 'low' }, CUSTOM)).toEqual({ error: 'EFFORT_UNSUPPORTED' })
    // One with an advanced effort opens its reasoning picker instead.
    const advanced = [model('codex-auto-fast', 'Auto Fast', ['low', 'max'], 'low'), CUSTOM[1]]
    expect(chooseCodexRow(quick, { model: 'codex-auto-fast', effort: 'max' }, advanced)).toMatchObject({ opens: 'efforts' })
    // A listed model with one effort, or none (its default), applies it.
    const single = [model('gpt-solo', 'GPT Solo', ['medium']), model('gpt-bare', 'GPT Bare', [], 'low')]
    const list = parsed('  Select Model and Effort\n\n  1. GPT Solo\n  2. GPT Bare')
    expect(chooseCodexRow(list, { model: 'gpt-solo', effort: 'medium' }, single)).toMatchObject({ opens: 'applied', effort: 'medium' })
    expect(chooseCodexRow(list, { model: 'gpt-solo', effort: 'high' }, single)).toEqual({ error: 'EFFORT_UNSUPPORTED' })
    expect(chooseCodexRow(list, { model: 'gpt-bare', effort: 'auto' }, single)).toMatchObject({ opens: 'applied', effort: 'low' })
    // A model the catalog does not describe is pressed by its slug, and the pane says what happened.
    expect(chooseCodexRow(parsed(CODEX_0145_ALL_MODELS), { model: 'gpt-5.2', effort: 'auto' }, CATALOG)).toMatchObject({ row: { number: 5 }, opens: 'unknown' })
  })

  it('presses nothing for a name more than one model could carry', () => {
    const catalog = [model('gpt-5.5', 'Shared display name', ['low', 'high']), model('gpt-5.6-terra', 'Shared display name', ['low', 'high']),
      model('gpt-renamed', 'Renamed model', ['low', 'high'])]
    expect(chooseCodexRow(parsed(CODEX_0160_SHARED_NAMES), { model: 'gpt-5.5', effort: 'low' }, catalog)).toEqual({ error: 'MODEL_UNAVAILABLE' })
    expect(chooseCodexRow(parsed(CODEX_0160_SHARED_NAMES), { model: 'gpt-renamed', effort: 'low' }, catalog)).toMatchObject({ row: { number: 1 } })
    // Two rows naming it, whatever the catalog says.
    expect(chooseCodexRow(parsed('  Select Model and Effort\n\n  1. GPT-5.5\n  2. GPT-5.5'), { model: 'gpt-5.5', effort: 'low' }, CATALOG))
      .toEqual({ error: 'MODEL_UNAVAILABLE' })
  })

  it('presses nothing for a row it cannot find exactly, or reach with one digit', () => {
    const fail = { error: 'MODEL_UNAVAILABLE' }
    expect(chooseCodexRow(parsed(CODEX_0160_ALL_MODELS), { model: 'gpt-7', effort: 'low' }, CATALOG)).toEqual(fail)
    expect(chooseCodexRow(parsed(CODEX_0160_ALL_MODELS), { model: 'us.openai.gpt-5.6-luna', effort: 'low' }, CATALOG)).toEqual(fail)
    // A name cut short with an ellipsis is not the name.
    expect(chooseCodexRow(parsed('  Select Model and Effort\n\n  1. GPT-6.1-S…  Latest'), { model: 'gpt-6.1-sol', effort: 'low' }, CATALOG)).toEqual(fail)
    // Row 10 has no key: `1` would accept row 1.
    const ten = ['  Select Model and Effort', '', ...Array.from({ length: 10 }, (_, i) => `  ${i + 1}. Model ${i + 1}`)].join('\n')
    expect(chooseCodexRow(parsed(ten), { model: 'gpt-ten', effort: 'auto' }, [model('gpt-ten', 'Model 10', ['low', 'high'])])).toEqual(fail)
    expect(chooseCodexRow(parsed(ten), { model: 'gpt-nine', effort: 'auto' }, [model('gpt-nine', 'Model 9', ['low', 'high'])])).toMatchObject({ row: { number: 9 } })
    expect(codexDigitPressable(0)).toBe(false)
    expect(codexDigitPressable(1.5)).toBe(false)
    // A reasoning screen is not a list to choose a model from.
    expect(chooseCodexRow(parsed(CODEX_0160_REASONING), { model: 'gpt-5.5', effort: 'low' }, CATALOG)).toEqual(fail)
    expect(chooseCodexRow(parsed('  Select Model\n  Pick a quick auto mode or browse all models.\n\n  1. Auto Fast\n  2. All models\n  3. All models'),
      { model: 'gpt-5.5', effort: 'low' }, CATALOG)).toEqual(fail)
  })

  it('offers nothing but the reserve model to an account held to it', () => {
    const reserve = parsed(CODEX_0160_RESERVE)
    expect(chooseCodexRow(reserve, { model: 'gpt-6-luna', effort: 'high' }, CATALOG)).toEqual({ error: 'MODEL_UNAVAILABLE' })
    expect(chooseCodexRow(reserve, { model: 'gpt-reserve', effort: 'high' }, CATALOG)).toMatchObject({ row: { number: 1, name: 'GPT-6-Luna' }, opens: 'unknown' })
    expect(chooseCodexRow({ ...reserve, rows: [...reserve.rows, { ...reserve.rows[0], number: 2 }] }, { model: 'gpt-reserve', effort: 'high' }, CATALOG))
      .toEqual({ error: 'MODEL_UNAVAILABLE' })
  })
})
