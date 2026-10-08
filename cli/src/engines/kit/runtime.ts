/** Shared runtime value and formatting mechanics; no engine registry or profile manager. */
import { readFile } from 'node:fs/promises'
import type { EngineRuntime, RuntimeField, RuntimeModelOption, RuntimeProfile, RuntimeSession, RuntimeState } from '../facets/runtime.js'

export const blankRuntimeState = (): RuntimeState => ({ model: null, effort: null, mode: 'unknown', cliVersion: null, observedAt: null })

/** Wire vocabulary only. Eligibility for a particular model belongs to its engine. */
export const RUNTIME_EFFORTS: ReadonlySet<string> = new Set([
  'auto', 'none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent', 'ultracode',
])

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;:]*[A-Za-z]/g, '')
}

export function flattenContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((item) => {
    if (typeof item === 'string') return item
    const obj = record(item)
    return text(obj?.text) || text(obj?.content)
  }).filter(Boolean).join('\n')
}

export function parseVersion(value: string | null): [number, number, number] | null {
  const match = /(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:\D|$)/.exec(value ?? '')
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export function versionAtLeast(value: string | null, wanted: [number, number, number]): boolean {
  const parsed = parseVersion(value)
  if (!parsed) return false
  for (let i = 0; i < wanted.length; i++) {
    if (parsed[i] !== wanted[i]) return parsed[i] > wanted[i]
  }
  return true
}

export function encodeRuntimeProfile(profile: Omit<RuntimeProfile, 'id'>): string {
  return `runtime-v1:${encodeURIComponent(profile.sessionId)}:${profile.engine}:${encodeURIComponent(profile.model)}@${profile.effort}`
}

export function runtimeModelLabel(model: string): string {
  const alias = /^(default|best|fable|opus|sonnet|haiku)(\[1m\])?$/i.exec(model)
  if (alias) return `${titlePart(alias[1].toLowerCase())}${alias[2] ?? ''}`
  return model.split(/[-_]/).filter(Boolean).map(titlePart).join(' ')
}

export function titlePart(value: string): string {
  if (/^gpt$/i.test(value)) return 'GPT'
  if (/^xhigh$/i.test(value)) return 'XHigh'
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function effortLabel(effort: string): string {
  return effort === 'xhigh' ? 'XHigh' : titlePart(effort)
}

export function currentPaneUi(paneText: string): string {
  const lines = paneText.split('\n')
  const promptIndex = lines.findLastIndex((line) => {
    const marker = line.search(/[›❯→]/u)
    return marker >= 0 && !/^\s*\d+\.\s/.test(line.slice(marker + 1))
  })
  return (promptIndex >= 0 ? lines.slice(promptIndex) : lines).join('\n')
}

export async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try { return record(JSON.parse(await readFile(file, 'utf8'))) } catch { return null }
}

export function addOption(
  output: RuntimeModelOption[],
  seen: Set<string>,
  session: RuntimeSession,
  model: string,
  effort: string,
  modelLabel = runtimeModelLabel(model),
): void {
  // The id inside a `runtime-v1:` string is what the web/device echoes back on a pick, so it is the
  // AGENT id — the public one — not the engine session that happens to be bound right now.
  const id = encodeRuntimeProfile({ sessionId: session.agentId, engine: session.engine, model, effort })
  if (seen.has(id)) return
  seen.add(id)
  output.push({ id, displayName: `${modelLabel} / ${effortLabel(effort)}` })
}

/** Use the engine's actual reducer on an isolated value. No live session or control is mutated. */
export function transcriptFields(adapter: EngineRuntime | undefined, session: RuntimeSession, line: string): RuntimeField[] {
  if (!adapter) return []
  let raw: Record<string, unknown> | null
  try { raw = record(JSON.parse(line)) } catch { return [] }
  if (!raw) return []
  const state = blankRuntimeState()
  adapter.transcript({ session: { ...session }, state }, raw)
  const fields: RuntimeField[] = []
  if (state.model !== null) fields.push('model')
  if (state.effort !== null) fields.push('effort')
  if (state.mode !== 'unknown') fields.push('mode')
  return fields
}
