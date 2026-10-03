/**
 * Secrets out of what the pair keeps and what it hands on (daemons/BRAIN.md, "Security"): before a journal
 * line is written, before a journal page leaves for another machine, and before any text reaches a model —
 * the triage one-shot, or the pair harness through a read tool. The patterns are the learner's
 * (pair/learn/guard.ts `redact`): keys and tokens by shape, `token=…` values, bearer and URL credentials,
 * emails, and the home folder as `~`.
 *
 * What a window shows the person on this computer (a line, a proposal's `detail`) is NOT redacted: they must
 * see exactly what a key would approve.
 */
import { homedir } from 'node:os'
import { redact } from './learn/guard.js'
import type { PairJournalEntry } from './protocol.js'

export function redactText(text: string, home: string | null = homedir()): string {
  return redact(text, { home })
}

/** A journal entry with its text and options redacted. */
export function redactEntry<T extends Pick<PairJournalEntry, 'text' | 'options'>>(entry: T, home: string | null = homedir()): T {
  return {
    ...entry,
    ...(typeof entry.text === 'string' ? { text: redactText(entry.text, home) } : {}),
    ...(Array.isArray(entry.options) ? { options: entry.options.map((o) => redactText(o, home)) } : {}),
  }
}

/** Keys whose values are ids, folders or names the pair acts with — never untrusted text worth redacting. */
const KEEP = new Set(['agentId', 'machineId', 'requestId', 'id', 'cwd', 'engine', 'status', 'machine', 'epoch', 'kind', 'by', 'action', 'verb', 'name', 'error', 'untouchable'])

/** Every string in a read tool's answer, redacted, except ids and folders (what the pair acts with). */
export function redactDeep<T>(value: T, home: string | null = homedir(), key = ''): T {
  if (typeof value === 'string') return (KEEP.has(key) ? value : redactText(value, home)) as T
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, home, key)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v, home, k)])) as T
  }
  return value
}
