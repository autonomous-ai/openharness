import type { InlineRuntimeContext, InlineRuntimeReader } from '../facets/inlineRuntime.js'
import type { RuntimeModelOption } from '../facets/runtime.js'
import { currentPaneUi, effortLabel, encodeRuntimeProfile, stripAnsi, text } from '../kit/runtime.js'
import { env } from '../../config/env.js'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const CATALOG_TTL_MS = 5 * 60_000

export interface CursorModelTarget {
  rawId: string
  modelKey: string
  familyLabel: string
  context: string | null
  reasoning: string | null
  fast: boolean | null
  thinking: boolean | null
  /** Effort text rendered in the idle footer; null means Cursor omits its native default. */
  footerEffort?: string | null
}

interface CursorCatalogEntry {
  target: CursorModelTarget
  effort: string
  modelLabel: string
}

const CURSOR_EFFORTS = new Set(['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'])
const CURSOR_CATALOG_TTL_MS = CATALOG_TTL_MS

function cursorEffortFromId(rawId: string): { effort: string | null; modelKey: string } {
  const parts = rawId.split('-')
  let index = -1
  let width = 1
  for (let i = 2; i < parts.length; i++) {
    if (parts[i] === 'extra' && parts[i + 1] === 'high') {
      index = i
      width = 2
      i++
    } else if (['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(parts[i])) {
      index = i
      width = 1
    }
  }
  if (index < 0) return { effort: null, modelKey: rawId }
  const rawEffort = parts.slice(index, index + width).join('-')
  parts.splice(index, width)
  return {
    effort: rawEffort === 'extra-high' ? 'xhigh' : rawEffort,
    modelKey: parts.join('-'),
  }
}

function cursorEffortFromDisplay(value: string): string | null {
  const match = /\b(Extra High|None|Low|Medium|High|Max)\b/i.exec(value)
  if (!match) return null
  return match[1].toLowerCase().replace(/\s+/g, '') === 'extrahigh'
    ? 'xhigh'
    : match[1].toLowerCase()
}

function cursorDisplayParts(displayName: string): {
  familyLabel: string
  context: string | null
  fast: boolean
  thinking: boolean
} {
  let value = displayName
    .replace(/\s+\((?:current|default)(?:,\s*(?:current|default))?\)\s*$/i, '')
    .replace(/\s+\(NO ZDR\)\s*$/i, '')
    .replace(/\s*[·│]\s*\d+(?:\.\d+)?%.*$/i, '')
    .trim()
  const contextMatch = /\b(\d+(?:\.\d+)?[KM])\b/i.exec(value)
  const context = contextMatch?.[1].toLowerCase() ?? null
  const fast = /\bFast\b/i.test(value)
  const thinking = !/\bNo\s+Thinking\b/i.test(value) && /\bThinking\b/i.test(value)
  value = value
    .replace(/\b\d+(?:\.\d+)?[KM]\b/gi, '')
    .replace(/\bExtra High\b/gi, '')
    .replace(/\b(?:None|Low|Medium|High|Max)\b/gi, '')
    .replace(/\bNo\s+Thinking\b/gi, '')
    .replace(/\b(?:Fast|Thinking)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return { familyLabel: value, context, fast, thinking }
}

/** Strictly parse `agent models`; headings, tips and malformed rows are ignored. */
export function parseCursorModelsOutput(output: string): CursorCatalogEntry[] {
  const candidates: Array<CursorCatalogEntry & { explicitEffort: boolean }> = []
  for (const rawLine of output.split('\n')) {
    const match = /^([a-z0-9][a-z0-9._-]*) - (.+?)\s*$/i.exec(rawLine)
    if (!match) continue
    const rawId = match[1]
    const displayName = match[2].trim()
    const display = cursorDisplayParts(displayName)
    if (!display.familyLabel) continue
    if (rawId === 'auto') {
      candidates.push({
        target: {
          rawId,
          modelKey: rawId,
          familyLabel: 'Auto',
          context: null,
          reasoning: null,
          fast: null,
          thinking: null,
          footerEffort: 'auto',
        },
        effort: 'auto',
        modelLabel: 'Auto',
        explicitEffort: true,
      })
      continue
    }
    const parsed = cursorEffortFromId(rawId)
    const effort = parsed.effort
    const footerEffort = cursorEffortFromDisplay(displayName)
    candidates.push({
      target: {
        rawId,
        modelKey: parsed.modelKey,
        familyLabel: display.familyLabel,
        context: display.context,
        reasoning: effort,
        fast: display.fast,
        thinking: display.thinking,
        footerEffort,
      },
      effort: effort ?? 'auto',
      modelLabel: [
        display.familyLabel,
        display.context ? `(${display.context.toUpperCase()})` : '',
        display.thinking ? 'Thinking' : '',
        display.fast ? 'Fast' : '',
      ].filter(Boolean).join(' '),
      explicitEffort: effort !== null,
    })
  }

  // Some medium/default rows omit the effort segment (for example `gpt-5.3-codex`).
  // Infer medium only when explicit siblings prove that the same exact model group has efforts.
  const effortfulGroups = new Set(candidates.filter((item) => item.explicitEffort).map((item) => item.target.modelKey))
  for (const item of candidates) {
    if (item.target.rawId === 'auto' || item.effort !== 'auto' || !effortfulGroups.has(item.target.modelKey)) continue
    item.effort = 'medium'
    item.target.reasoning = 'medium'
  }
  return candidates.map(({ explicitEffort: _explicitEffort, ...item }) => item)
}

function parseCursorFooter(value: string): {
  familyLabel: string
  context: string | null
  effort: string | null
  fast: boolean
  thinking: boolean
} | null {
  const line = stripAnsi(value).trim()
  if (/^Auto(?:\s*$|\s*[·│])/i.test(line)) {
    return { familyLabel: 'Auto', context: null, effort: 'auto', fast: false, thinking: false }
  }
  const effort = cursorEffortFromDisplay(line)
  const hasUsage = /[·│]\s*\d+(?:\.\d+)?%/i.test(line)
  const hasThinkingMode = /\b(?:No\s+Thinking|Thinking)\b/i.test(line)
  if (!effort && !hasUsage && !hasThinkingMode) return null
  const parts = cursorDisplayParts(line)
  if (!parts.familyLabel || !/\d/.test(parts.familyLabel)) return null
  return {
    ...parts,
    effort,
  }
}

function cursorSyntheticTarget(
  parsed: NonNullable<ReturnType<typeof parseCursorFooter>>,
  effort: string,
): CursorModelTarget {
  if (parsed.familyLabel.toLowerCase() === 'auto' && parsed.effort === 'auto') {
    return {
      rawId: 'auto',
      modelKey: 'auto',
      familyLabel: 'Auto',
      context: null,
      reasoning: null,
      fast: null,
      thinking: null,
      footerEffort: 'auto',
    }
  }
  const family = parsed.familyLabel.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '') || 'model'
  // Keep the public runtime-v1 model key compatible with every client formatter. The Cursor routing
  // details remain on CursorModelTarget (and rawId) for selection/confirmation; they do not belong in
  // the user-facing profile key as a percent-encoded "[fast=...,thinking=...]" implementation detail.
  const modelKey = [
    family,
    parsed.context?.toLowerCase() ?? '',
    parsed.thinking ? 'thinking' : '',
    parsed.fast ? 'fast' : '',
  ].filter(Boolean).join('-')
  const parameters = [
    parsed.context ? `context=${parsed.context}` : '',
    `fast=${parsed.fast}`,
    `thinking=${parsed.thinking}`,
  ].filter(Boolean).join(',')
  return {
    rawId: `cursor-${family}[${parameters},effort=${effort}]`,
    modelKey,
    familyLabel: parsed.familyLabel,
    context: parsed.context,
    reasoning: effort === 'auto' ? null : effort,
    fast: parsed.fast,
    thinking: parsed.thinking,
    footerEffort: parsed.effort,
  }
}


class ProfileReader {
  readonly engine = 'cursor' as const
  private readonly cursorTargets = new Map<string, Map<string, CursorModelTarget>>()
  private cursorCatalogCache: { key: string; expiresAt: number; entries: CursorCatalogEntry[] } | null = null

  pane(context: InlineRuntimeContext, paneText: string): void | false {
    const { session, state, control } = context
    const currentUi = currentPaneUi(paneText)
    if (/Available models|Models matching|— Edit Parameters|Type to filter.*Tab to edit|Esc to go back/i.test(currentUi)) return false
    const footerLines = currentUi.split('\n')
      .filter((line) => stripAnsi(line).trim())
      .slice(-12)
      .reverse()
    const parsed = footerLines.map(parseCursorFooter).find((item) => item !== null)
    if (parsed) {
      const targets = this.cursorTargets.get(session.sessionId) ?? new Map<string, CursorModelTarget>()
      let target = [...targets.values()].find((candidate) =>
        candidate.familyLabel.toLowerCase() === parsed.familyLabel.toLowerCase()
        && (parsed.effort
          ? (candidate.reasoning ?? 'auto') === parsed.effort
          : candidate.footerEffort === null)
        && (candidate.fast ?? false) === parsed.fast
        && (candidate.thinking ?? false) === parsed.thinking
        && (!candidate.context || candidate.context === parsed.context))
      const effort = parsed.effort ?? target?.reasoning ?? 'auto'
      if (!target) {
        target = cursorSyntheticTarget(parsed, effort)
        const id = encodeRuntimeProfile({
          sessionId: session.agentId,
          engine: 'cursor',
          model: target.modelKey,
          effort,
        })
        targets.set(id, target)
        this.cursorTargets.set(session.sessionId, targets)
      }
      state.model = target.modelKey
      state.effort = effort
      state.observedAt = Date.now()
      if (control && target?.modelKey === control.target.model && effort === control.target.effort) {
        control.modelConfirmed = true
        control.effortConfirmed = true
      }
    }
    if (/\bPlan\b/i.test(currentUi)) state.mode = 'plan'
    else if (/Plan, search, build anything/i.test(currentUi)) state.mode = 'default'
  }

  transcript(context: InlineRuntimeContext, raw: Record<string, unknown>): void {
    const { session, state } = context
    const version = text(raw.version) || text(raw.cursor_version)
    if (version) {
      session.cliVersion = version
      state.cliVersion = version
    }
    const model = text(raw.model)
    if (model) {
      state.model = model
      // Default the effort to 'auto' when we do not have one yet. selectedModel() returns null unless BOTH
      // axes are known, so without this a Cursor session whose model we DO know shows nothing at all on
      // the device — the model is thrown away because the effort is missing.
      //
      // Cursor reports its model in the transcript but its reasoning level only in the pane footer, so
      // the effort arrives later (ingestPane) or not at all for a model that has no reasoning levels.
      // 'auto' is not a guess about Cursor's behaviour: it is exactly how the device renders "not
      // specified", and the pane path overwrites it with the real value the moment one is read.
      state.effort ??= 'auto'
      state.observedAt = Date.now()
    }
  }

  target(sessionId: string, profileId: string): CursorModelTarget | null {
    return this.cursorTargets.get(sessionId)?.get(profileId) ?? null
  }

  forget(sessionId: string): void { this.cursorTargets.delete(sessionId) }

  async models(context: InlineRuntimeContext): Promise<RuntimeModelOption[]> {
    const { session, state } = context
    const key = `${session.cliVersion ?? 'unknown'}\0${process.env.HOME ?? ''}`
    let entries = this.cursorCatalogCache?.key === key && this.cursorCatalogCache.expiresAt > Date.now()
      ? this.cursorCatalogCache.entries
      : null
    if (!entries) {
      try {
        const result = await execFileAsync('agent', ['models'], {
          env: process.env,
          timeout: 5_000,
          maxBuffer: 1024 * 1024,
        })
        entries = parseCursorModelsOutput(result.stdout)
        this.cursorCatalogCache = { key, entries, expiresAt: Date.now() + CURSOR_CATALOG_TTL_MS }
      } catch (err) {
        console.warn('[runtime-profile] Cursor model catalog failed:', err instanceof Error ? err.message : err)
        entries = []
      }
    }

    const output: RuntimeModelOption[] = []
    const previousTargets = this.cursorTargets.get(session.sessionId) ?? new Map<string, CursorModelTarget>()
    const targets = new Map<string, CursorModelTarget>()
    const seen = new Set<string>()
    for (const entry of entries) {
      if (!CURSOR_EFFORTS.has(entry.effort)) continue
      const id = encodeRuntimeProfile({
        sessionId: session.agentId,
        engine: 'cursor',
        model: entry.target.modelKey,
        effort: entry.effort,
      })
      if (seen.has(id)) continue
      seen.add(id)
      targets.set(id, entry.target)
      output.push({ id, displayName: `${entry.modelLabel} / ${effortLabel(entry.effort)}` })
    }
    const current = state?.model && state.effort
      ? encodeRuntimeProfile({
          sessionId: session.agentId,
          engine: 'cursor',
          model: state.model,
          effort: state.effort,
        })
      : null
    const observed = current ? previousTargets.get(current) : null
    if (observed) {
      const familyEfforts = [...new Set(entries
        .filter((entry) => entry.target.familyLabel.toLowerCase() === observed.familyLabel.toLowerCase())
        .map((entry) => entry.effort)
        .filter((effort) => effort !== 'auto'))]
      const efforts = familyEfforts.length ? familyEfforts : [state!.effort!]
      for (const effort of efforts) {
        const id = encodeRuntimeProfile({
          sessionId: session.agentId,
          engine: 'cursor',
          model: observed.modelKey,
          effort,
        })
        if (seen.has(id)) continue
        seen.add(id)
        targets.set(id, { ...observed, reasoning: effort, footerEffort: effort })
        const label = [
          observed.familyLabel,
          observed.context ? `(${observed.context.toUpperCase()})` : '',
          observed.thinking ? 'Thinking' : '',
          observed.fast ? 'Fast' : '',
        ].filter(Boolean).join(' ')
        output.push({ id, displayName: `${label} / ${effortLabel(effort)}` })
      }
    }
    this.cursorTargets.set(session.sessionId, targets)
    return output
  }
}

export function createRuntimeProfileReader(): InlineRuntimeReader & { engine: 'cursor' } { return new ProfileReader() }
