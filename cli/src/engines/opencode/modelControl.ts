/** OpenCode owns its commands, picker filters and footer evidence; core owns every input effect. */
import { RuntimeProfileControlError, type EngineModelControl, type ModelControlHost, type ModelControlInput } from '../facets/modelControl.js'
import type { RuntimeCatalogModel } from '../facets/runtime.js'
import { stripAnsi } from '../kit/pane.js'
import { countOpencodePickers, countOpencodeVariantPickers, opencodeFooterModelId, opencodeModelTarget,
  opencodeRowMatches, opencodeRowNamesModel, parseOpencodeFooter, parseOpencodePickerRows, parseOpencodeVariantRows,
  type OpencodeModelTarget, type OpencodePickerRow } from './runtimeProfile.js'

const COMMAND_CONFIRM_MS = 8_000
const PICKER_OPEN_MS = 3_000
const PICKER_STEP_MS = 2_000
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const targets = (catalog: RuntimeCatalogModel[]): OpencodeModelTarget[] => catalog.flatMap(entry => {
  const target = opencodeModelTarget(entry.slug, entry.displayName === entry.slug ? undefined : entry.displayName)
  return target ? [{ ...target, efforts: entry.efforts }] : []
})

export const modelControl: EngineModelControl = {
  async validate({ stage, target, catalog }) {
    if (stage !== 'target') return
    const entry = targets(catalog).find(entry => entry.id === target.model)
    if (!entry) throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')
    if (target.effort !== 'auto' && !entry.efforts?.includes(target.effort)) throw new RuntimeProfileControlError('EFFORT_UNSUPPORTED')
  },
  apply: (input, host) => new OpencodeModelControl(host).apply(input),
}

class OpencodeModelControl {
  constructor(private readonly host: ModelControlHost) {}

  async apply(input: ModelControlInput): Promise<void> {
    try { await this.select(input) }
    catch (error) {
      // Cleanup has the same authority as the failed operation, so a revoked grant never presses a late Escape.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!await this.host.key('Escape').catch(() => false)) break
        const text = await this.host.capture(100).catch(() => null)
        if (!text || (!countOpencodePickers(stripAnsi(text)) && !countOpencodeVariantPickers(stripAnsi(text)))) break
        await sleep(100)
      }
      throw error
    }
  }

  private async select({ session, target, current, catalog: supplied }: ModelControlInput): Promise<void> {
    const catalog = targets(supplied)
    const entry = catalog.find(item => item.id === target.model)
    if (!entry) throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')
    const onScreen = (capture: string) => {
      const text = stripAnsi(capture), footer = parseOpencodeFooter(text)
      return footer && { model: opencodeFooterModelId(text, catalog), effort: footer.effort ?? 'auto' }
    }
    const shows = (capture: string, effort: boolean) => {
      const now = onScreen(capture)
      return now?.model === target.model && (!effort || now.effort === target.effort)
    }
    let variantOpen = false
    if (current?.model !== target.model) {
      await this.pickModel(entry)
      // OpenCode 2.2 opens its variant picker after choosing a model. Default must answer it too.
      if (entry.efforts?.length) variantOpen = !!await this.waitPane(text => parseOpencodeVariantRows(stripAnsi(text)) !== null, PICKER_STEP_MS)
      if (!await this.waitPane(text => shows(text, false), COMMAND_CONFIRM_MS, true)) throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
    }
    const effortNow = onScreen(await this.host.capture(100) ?? '')?.effort
    if (variantOpen || effortNow !== target.effort) {
      if (target.effort !== 'auto' && !entry.efforts?.includes(target.effort)) throw new RuntimeProfileControlError('EFFORT_UNSUPPORTED')
      await this.pickVariant(target.effort === 'auto' ? 'Default' : target.effort, variantOpen)
    }
    // Captures feed the existing fenced runtime reader for a bound conversation. Before the first
    // message there is no accepted profile to wait for, so only the live footer confirms the switch.
    if (!await this.waitPane(text => shows(text, true), COMMAND_CONFIRM_MS, true)
      || (session.sessionId && !await this.host.waitForProfile(1))) throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
  }

  private async openPicker(command: string, opened: (capture: string) => boolean): Promise<void> {
    if (!await this.host.literal(command)) throw new RuntimeProfileControlError('TMUX_FAILED')
    // The command must be listed on one line; a composer's next gutter is not a command description.
    const listed = new RegExp(`┃[ \\t]*${command.replace('/', '\\/')}[ \\t]{2,}\\S`)
    if (!await this.waitPane(text => listed.test(stripAnsi(text)), PICKER_STEP_MS)) {
      for (let i = 0; i < command.length; i++) await this.host.key('BSpace')
      throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
    }
    if (!await this.host.key('Enter')) throw new RuntimeProfileControlError('TMUX_FAILED')
    if (!await this.waitPane(text => opened(stripAnsi(text)), PICKER_OPEN_MS)) throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
  }

  private async pickVariant(variant: string, open: boolean): Promise<void> {
    if (!open) {
      const before = countOpencodeVariantPickers(stripAnsi(await this.host.capture(100) ?? ''))
      await this.openPicker('/effort', text => countOpencodeVariantPickers(text) > before)
    }
    if (!await this.host.literal(variant)) throw new RuntimeProfileControlError('TMUX_FAILED')
    if (!await this.waitPane(text => parseOpencodeVariantRows(stripAnsi(text))?.[0]?.name.toLowerCase() === variant.toLowerCase(), PICKER_STEP_MS)) {
      await this.host.key('Escape')
      throw new RuntimeProfileControlError('EFFORT_UNSUPPORTED')
    }
    if (!await this.host.key('Enter')) throw new RuntimeProfileControlError('TMUX_FAILED')
  }

  private async pickModel(entry: OpencodeModelTarget): Promise<void> {
    if (await this.pickRow(entry.filter, row => opencodeRowMatches(entry, row))) return
    // A single provider can be a section heading rather than part of each searchable row.
    if (entry.modelFilter !== entry.filter && await this.pickRow(entry.modelFilter, row => opencodeRowNamesModel(entry, row))) return
    throw new RuntimeProfileControlError('MODEL_UNAVAILABLE')
  }

  private async pickRow(filter: string, matches: (row: OpencodePickerRow) => boolean): Promise<boolean> {
    const before = countOpencodePickers(stripAnsi(await this.host.capture(100) ?? ''))
    await this.openPicker('/models', text => countOpencodePickers(text) > before)
    if (!await this.host.literal(filter)) throw new RuntimeProfileControlError('TMUX_FAILED')
    const capture = await this.waitPane(text => parseOpencodePickerRows(stripAnsi(text))?.length === 1, PICKER_STEP_MS)
    const rows = capture ? parseOpencodePickerRows(stripAnsi(capture)) ?? [] : []
    if (rows.length !== 1 || !matches(rows[0])) {
      await this.host.key('Escape')
      await this.waitPane(text => countOpencodePickers(stripAnsi(text)) <= before, PICKER_STEP_MS)
      return false
    }
    if (!await this.host.key('Enter')) throw new RuntimeProfileControlError('TMUX_FAILED')
    return true
  }

  private async waitPane(matches: (capture: string) => boolean, timeout: number, observe = false): Promise<string | null> {
    const end = Date.now() + timeout
    do {
      const text = await this.host.capture(100, observe)
      if (text && matches(text)) return text
      await sleep(100)
    } while (Date.now() < end)
    return null
  }
}
