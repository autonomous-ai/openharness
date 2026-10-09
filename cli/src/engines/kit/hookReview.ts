/**
 * Harness's own hook blocks recorded as reviewed, where the engine asks a person to review a hook before it
 * first runs (facets/hooks.ts `HookReviewRecord`): Codex 0.162 shows "Hooks need review" in the first Codex
 * pane, and a person who picks "Continue without trusting" switches Harness's hooks off without knowing it.
 *
 * The record is the engine's own, written as the engine writes it on "Trust all": a table per hook in its
 * config file, keyed by the settings file in the real path of the engine's home, the event, the block and
 * the hook, holding the hash the engine computes of the hook. The hash is the engine's: the hook normalized
 * (its matcher only where the engine honours one, a timeout always, `async`), every object's keys sorted,
 * compact JSON, sha256. It is matched against `codex app-server` `hooks/list` of codex-cli 0.162.0
 * (hookReview.spec.ts). Should an engine hash differently, it sees a changed hook and asks again, which is
 * where it was before.
 *
 * Only Harness's own blocks, never another hook in the same file. The config file is edited the way
 * folderTrust.ts edits it: through a symlink, atomically, and only where the table cannot end up defined twice.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { HookReviewRecord } from '../facets/hooks.js'
import { replaceConfigFile } from './folderTrust.js'
import { isOurs, type Settings } from './notifyHooks.js'

/** Every object's keys sorted, as the engine sorts them before it hashes. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedKeys((value as Record<string, unknown>)[key])]))
  }
  return value
}

/** The engine's hash of one command hook, as `hooks/list` reports it in `currentHash`. */
export function reviewHash(record: HookReviewRecord, event: string, matcher: string | undefined, hook: { command: string; timeout?: number; async?: boolean }): string {
  const identity = {
    event_name: record.events[event],
    ...(record.matcherEvents.includes(event) && matcher !== undefined ? { matcher } : {}),
    hooks: [{ type: 'command', command: hook.command, timeout: Math.max(1, hook.timeout ?? record.defaultTimeout), async: hook.async === true }],
  }
  return `sha256:${createHash('sha256').update(JSON.stringify(sortedKeys(identity))).digest('hex')}`
}

/** The records Harness's own blocks in `settings` need: key → hash. */
export function reviewRecords(record: HookReviewRecord, settingsFile: string, settings: Settings): Map<string, string> {
  const records = new Map<string, string>()
  for (const [event, label] of Object.entries(record.events)) {
    const blocks = settings.hooks?.[event]
    if (!Array.isArray(blocks)) continue
    const blockIndex = blocks.findIndex(isOurs)
    if (blockIndex < 0) continue
    const block = blocks[blockIndex]
    const hookIndex = block.hooks.findIndex((hook) => isOurs({ hooks: [hook] }))
    const hook = block.hooks[hookIndex]
    if (hook.type !== 'command' || typeof hook.command !== 'string') continue
    records.set(`${settingsFile}:${label}:${blockIndex}:${hookIndex}`, reviewHash(record, event, block.matcher, hook))
  }
  return records
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** `hooks.state` as a header path, however its dots are spaced. */
const tablePath = (table: string): string => table.split('.').map(escape).join(String.raw`[ \t]*\.[ \t]*`)

/** The key a quoted TOML key names; null for an escape JSON does not share. */
function tomlKey(quoted: string): string | null {
  if (quoted.startsWith("'")) return quoted.slice(1, -1)
  try { return JSON.parse(quoted) as string } catch { return null }
}

/** The text of a table's body: from its header to the next header. */
const bodyAfter = (text: string, end: number): { body: string; at: number } => {
  const rest = text.slice(end)
  const next = rest.search(/^[ \t]*\[/m)
  return { body: next < 0 ? rest : rest.slice(0, next), at: end }
}

/**
 * The table, or the table above it, defined in a form a header appended after it could collide with: an
 * inline table, dotted keys, or values in the table's own body. Codex writes `[hooks.state]` with nothing in
 * it, then a header per hook.
 */
function definedOtherwise(text: string, table: string): boolean {
  const [top, ...rest] = table.split('.')
  const firstHeader = text.search(/^[ \t]*\[/m)
  const preamble = firstHeader < 0 ? text : text.slice(0, firstHeader)
  if (new RegExp(String.raw`^[ \t]*${escape(top)}[ \t]*[.=]`, 'm').test(preamble)) return true
  const sub = rest.join('.')
  for (const match of text.matchAll(new RegExp(String.raw`^[ \t]*\[[ \t]*${escape(top)}[ \t]*\][^\n]*`, 'gm'))) {
    const { body } = bodyAfter(text, (match.index ?? 0) + match[0].length)
    if (new RegExp(String.raw`^[ \t]*${escape(sub.split('.')[0])}[ \t]*[.=]`, 'm').test(body)) return true
  }
  for (const match of text.matchAll(new RegExp(String.raw`^[ \t]*\[[ \t]*${tablePath(table)}[ \t]*\][^\n]*`, 'gm'))) {
    const { body } = bodyAfter(text, (match.index ?? 0) + match[0].length)
    if (/^[ \t]*[^\s#\[]/m.test(body)) return true
  }
  return false
}

/**
 * The config file's text with each record in place: an existing table's hash replaced when it differs, a
 * missing table appended. Null when nothing changes, or when the file defines the table in a form that this
 * could make invalid; the engine then asks the person, as it would anyway.
 */
export function withReviewRecords(text: string, record: HookReviewRecord, records: Map<string, string>): string | null {
  if (definedOtherwise(text, record.table)) return null
  const header = new RegExp(String.raw`^[ \t]*\[[ \t]*${tablePath(record.table)}[ \t]*\.[ \t]*("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')[ \t]*\][^\n]*`, 'gm')
  const field = new RegExp(String.raw`^([ \t]*${escape(record.key)}[ \t]*=[ \t]*)("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')`, 'm')
  let next = text
  for (const [key, hash] of records) {
    const found = [...next.matchAll(header)]
    if (found.some((match) => tomlKey(match[1]) === null)) return null
    const ours = found.filter((match) => tomlKey(match[1]) === key)
    if (ours.length > 1) return null
    if (ours.length === 1) {
      const { body, at } = bodyAfter(next, (ours[0].index ?? 0) + ours[0][0].length)
      const line = field.exec(body)
      if (line && tomlKey(line[2]) === hash) continue
      const updated = line
        ? body.replace(field, `$1${JSON.stringify(hash)}`)
        : `\n${record.key} = ${JSON.stringify(hash)}${body}`
      next = next.slice(0, at) + updated + next.slice(at + body.length)
      continue
    }
    // A TOML basic string is a JSON string, except that DEL must be escaped too.
    const table = `[${record.table}.${JSON.stringify(key).replace(/\x7f/g, '\\u007f')}]`
    next = `${next.replace(/\s*$/, '')}${next.trim() ? '\n\n' : ''}${table}\n${record.key} = ${JSON.stringify(hash)}\n`
  }
  return next === text ? null : next
}

/**
 * Record Harness's own blocks in `settings` (just written to `settingsFile` in `home`) as reviewed in the
 * engine's config file. Created when the engine has not written one yet: a new person's first Codex pane is
 * the one that asks. Never throws: a hook that is not recorded is asked about, as before.
 */
export function recordReviewed(record: HookReviewRecord, home: string, settingsFile: string, settings: Settings): void {
  const config = join(home, record.file)
  const say = (line: string): string => line.replace('{config}', config)
  try {
    // Codex keys a hook by the real path of CODEX_HOME joined with the file's name (codex-cli 0.162.0): a
    // symlinked home names its target, a symlinked hooks.json in it keeps its own name.
    const records = reviewRecords(record, join(realpathSync(dirname(settingsFile)), basename(settingsFile)), settings)
    if (records.size === 0) return
    const text = existsSync(config) ? readFileSync(config, 'utf8') : ''
    if (definedOtherwise(text, record.table)) {
      console.log(say(record.messages.skipped))
      return
    }
    const next = withReviewRecords(text, record, records)
    if (next === null) return
    if (existsSync(config)) replaceConfigFile(config, next)
    else writeFileSync(config, next, { mode: 0o600 })
    console.log(say(record.messages.recorded))
  } catch (err) {
    console.error(say(record.messages.skipped), err)
  }
}
