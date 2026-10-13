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
import { parse as parseToml } from 'smol-toml'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import type { HookReviewRecord } from '../facets/hooks.js'
import { HookPreparationHeld, inspectHookFile, runHookPreparation, type HookPreparationAttempt } from './nativeHookFiles.js'
import { isMessagesBlock } from './messagesHook.js'
import { isOurs, type HookBlock, type Settings } from './notifyHooks.js'

/** Harness's own: notify.mjs's blocks, and Agent Messages' (kit/messagesHook.ts). */
const harnessOwn = (block: HookBlock): boolean => isOurs(block) || isMessagesBlock(block)

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
    // An optional Messages block can precede a required notify block. Approving
    // only the first would report a prepared launch with SessionStart disabled.
    for (const [blockIndex, block] of blocks.entries()) {
      if (!harnessOwn(block)) continue
      for (const [hookIndex, hook] of block.hooks.entries()) {
        if (!harnessOwn({ hooks: [hook] }) || hook.type !== 'command' || typeof hook.command !== 'string') continue
        // A hook edited into a shape Harness does not write is one the engine reads its own way: it asks.
        if ((hook.timeout !== undefined && typeof hook.timeout !== 'number') || (block.matcher !== undefined && typeof block.matcher !== 'string')) continue
        records.set(`${settingsFile}:${label}:${blockIndex}:${hookIndex}`, reviewHash(record, event, block.matcher, hook))
      }
    }
  }
  return records
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** One key, bare or quoted: `hooks`, `"hooks"` and `'hooks'` name the same table. */
const segment = (key: string): string => `(?:${escape(key)}|"${escape(key)}"|'${escape(key)}')`
/** `hooks.state` as a header path, however its dots are spaced and its keys quoted. */
const tablePath = (table: string): string => table.split('.').map(segment).join(String.raw`[ \t]*\.[ \t]*`)
/** A key in a header: bare, or a one-line string. */
const KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')`
const HEADER = new RegExp(String.raw`^[ \t]*\[\[?[ \t]*${KEY}(?:[ \t]*\.[ \t]*${KEY})*[ \t]*\]\]?[ \t]*(?:#.*)?\r?$`)

/**
 * The text as it is read for its structure: multi-line strings and a byte order mark blanked to spaces,
 * newlines kept, so that a line inside a string is never taken for a header or a key, and every offset still
 * points into the real text. Codex refuses a config.toml that does not parse, every setting in it lost: a
 * header appended in the wrong place would cost a person far more than a hook review.
 */
const structure = (text: string): string => text
  .replace(/^﻿/, ' ')
  .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, (string) => string.replace(/[^\n]/g, ' '))

/** How many arrays and inline tables a line opens, less those it closes; its strings and comment left out. */
const opens = (line: string): number => {
  const bare = line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '').replace(/#.*/, '')
  return (bare.match(/[[{]/g)?.length ?? 0) - (bare.match(/[\]}]/g)?.length ?? 0)
}

interface Line { start: number; end: number; text: string }
/** The table headers, in order: a line of an array or inline table that spans lines (`["a"]`) is a value. */
function headers(shape: string): Line[] {
  const found: Line[] = []
  let depth = 0
  let start = 0
  for (const text of shape.split('\n')) {
    if (depth === 0 && HEADER.test(text)) found.push({ start, end: start + text.length, text })
    else depth = Math.max(0, depth + opens(text))
    start += text.length + 1
  }
  return found
}

/** The key a quoted TOML key names; null for an escape JSON does not share. */
function tomlKey(quoted: string): string | null {
  if (quoted.startsWith("'")) return quoted.slice(1, -1)
  try { return JSON.parse(quoted) as string } catch { return null }
}

/**
 * The table, or the table above it, defined in a form a header appended after it could collide with: an
 * inline table, dotted keys, an array of tables, or values in the table's own body. Codex writes
 * `[hooks.state]` with nothing in it, then a header per hook.
 */
function definedOtherwise(shape: string, table: string): boolean {
  const [top, sub] = table.split('.')
  const list = headers(shape)
  const body = (i: number): string => shape.slice(list[i].end, list[i + 1]?.start ?? shape.length)
  const preamble = shape.slice(0, list[0]?.start ?? shape.length)
  if (new RegExp(String.raw`^[ \t]*${segment(top)}[ \t]*[.=]`, 'm').test(preamble)) return true
  const topHeader = new RegExp(String.raw`^[ \t]*\[[ \t]*${segment(top)}[ \t]*\]`)
  const tableHeader = new RegExp(String.raw`^[ \t]*\[[ \t]*${tablePath(table)}[ \t]*\]`)
  const arrayOfTables = new RegExp(String.raw`^[ \t]*\[\[[ \t]*${segment(top)}(?:[ \t]*\.[ \t]*${segment(sub)})?[ \t]*\]\]`)
  return list.some((line, i) => arrayOfTables.test(line.text)
    || (topHeader.test(line.text) && new RegExp(String.raw`^[ \t]*${segment(sub)}[ \t]*[.=]`, 'm').test(body(i)))
    || (tableHeader.test(line.text) && /^[ \t]*[^\s#]/m.test(body(i))))
}

/**
 * The config file's text with each record in place: an existing table's hash replaced when it differs, a
 * missing table appended. 'unsafe' when the file defines the table, or a record, in a form this could make
 * invalid; the engine then asks the person, as it would anyway.
 */
export function withReviewRecords(text: string, record: HookReviewRecord, records: Map<string, string>): string | 'unchanged' | 'unsafe' {
  if (definedOtherwise(structure(text), record.table)) return 'unsafe'
  const header = new RegExp(String.raw`^[ \t]*\[[ \t]*${tablePath(record.table)}[ \t]*\.[ \t]*("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')[ \t]*\]`)
  const field = new RegExp(String.raw`^([ \t]*${segment(record.key)}[ \t]*=[ \t]*)([^\n]*)$`, 'm')
  const value = /^("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')[ \t]*(?:#.*)?\r?$/
  let next = text
  for (const [key, hash] of records) {
    const shape = structure(next)
    const list = headers(shape)
    const found = list.flatMap((line, i) => {
      const match = header.exec(line.text)
      return match ? [{ i, key: tomlKey(match[1]) }] : []
    })
    if (found.some((one) => one.key === null)) return 'unsafe'
    const ours = found.filter((one) => one.key === key)
    if (ours.length > 1) return 'unsafe'
    if (ours.length === 1) {
      const at = list[ours[0].i].end
      const line = field.exec(shape.slice(at, list[ours[0].i + 1]?.start ?? shape.length))
      if (line) {
        // Only a one-line string is read and replaced; anything else (a multi-line string, another type) is
        // a record this does not understand, and a second key beside it would not parse.
        const from = at + line.index + line[1].length
        const quoted = value.exec(next.slice(from, at + line.index + line[0].length))
        if (!quoted) return 'unsafe'
        if (tomlKey(quoted[1]) === hash) continue
        next = next.slice(0, from) + JSON.stringify(hash) + next.slice(from + quoted[1].length)
      } else {
        next = `${next.slice(0, at)}\n${record.key} = ${JSON.stringify(hash)}${next.slice(at)}`
      }
      continue
    }
    // A TOML basic string is a JSON string, except that DEL must be escaped too.
    const table = `[${record.table}.${JSON.stringify(key).replace(/\x7f/g, '\\u007f')}]`
    next = `${next.replace(/\s*$/, '')}${next.trim() ? '\n\n' : ''}${table}\n${record.key} = ${JSON.stringify(hash)}\n`
  }
  return next === text ? 'unchanged' : next
}

/** Inspect approvals before publishing hooks. An unreadable or conflicting
 * config cannot authorize even the first write of the installation. */
export function prepareReviewed(record: HookReviewRecord, home: string, settingsFile: string, settings: Settings) {
  const config = join(home, record.file), observed = inspectHookFile(config, 0o600)
  // Codex uses the real home plus the literal hooks filename, even when that
  // leaf is an alias. The config's own leaf alias does not change that home.
  const records = reviewRecords(record, join(observed.directory, basename(settingsFile)), settings)
  if (records.size === 0) throw new HookPreparationHeld('the hooks have no verifiable approval records')
  const text = observed.content ?? ''
  try { parseToml(text, { integersAsBigInt: true, maxDepth: 64 }) }
  catch { throw new HookPreparationHeld('the hook review configuration is not complete TOML') }
  const next = withReviewRecords(text, record, records)
  if (next === 'unsafe') throw new HookPreparationHeld('the hook review configuration cannot be safely updated')
  const output = next === 'unchanged' ? text : next
  try { parseToml(output, { integersAsBigInt: true, maxDepth: 64 }) }
  catch { throw new HookPreparationHeld('the prepared hook reviews are not complete TOML') }
  observed.prepare(output)
  return {
    verify: observed.verify,
    commit: async (attempt: HookPreparationAttempt) => {
      const published = await observed.replace(next === 'unchanged' ? text : next, attempt)
      if (next !== 'unchanged') console.log(record.messages.recorded.replace('{config}', config))
      return published
    },
  }
}

/** Record the exact settings already on disk. Failure is explicit so launch
 * remains held until both the hook and its approval are confirmed durable. */
export async function recordReviewed(record: HookReviewRecord, home: string, settingsFile: string): Promise<boolean> {
  const config = join(home, record.file)
  try { return await runHookPreparation([settingsFile, config], async attempt => {
    const source = inspectHookFile(settingsFile)
    const settings = JSON.parse(source.content ?? 'null') as Settings
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) || !settings.hooks || typeof settings.hooks !== 'object') return false
    const prepared = prepareReviewed(record, home, settingsFile, settings)
    source.verify(); const published = await prepared.commit(attempt)
    source.verify(); published.verify()
    return true
  }) } catch (err) {
    console.error(record.messages.skipped.replace('{config}', config), err)
    return false
  }
}
