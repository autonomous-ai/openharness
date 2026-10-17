/**
 * `harness uninstall`'s half of the hook installers (hookSettings.ts, nativeHookSettings.ts, nativePlugin.ts): Harness's
 * entries out of an engine's settings, found by the same recognizers the installers use to keep their own apart from
 * everybody else's (notifyHooks.ts `isOurs`, `isManagedHookCommand`; messagesHook.ts `isMessagesBlock`). Nothing they do
 * not recognize is touched; a file that cannot be read as the settings it should be is reported, never rewritten.
 * Each file is written as the installers write it: inspected, staged and published under its own preparation.
 */
import { parse as parseToml } from 'smol-toml'
import { basename, join } from 'node:path'
import type { HookReviewRecord } from '../facets/hooks.js'
import { HookPreparationHeld, inspectHookFile, runHookPreparation } from './nativeHookFiles.js'
import { reviewRecords, withoutReviewRecords } from './hookReview.js'
import { IdentityReadUnavailable } from './identityScan.js'
import { isMessagesBlock } from './messagesHook.js'
import { foreignHookBlocks, isManagedHookCommand, isOurs, type HookBlock, type Settings } from './notifyHooks.js'
import { hostPlatform } from './windowsFiles.js'

export interface HookFileRemoval {
  file: string
  /** How many of Harness's entries (hooks, rules, approvals, or the file itself) went. */
  removed: number
  /** Why the file was left as it was. */
  failed?: string
  /** A file at a path of ours that is somebody else's. */
  kept?: string
}

export interface JsonHookRemoval {
  schema: 'nested' | 'entries' | 'file' | 'named'
  /** `named`: the member Harness's events are in. */
  block?: string
  /** Agent Messages' block (Claude Code's and Codex's settings). */
  messages?: boolean
  /** Harness's permission rules, in the list at this path (`permissions.allow`). */
  allowList?: readonly [string, string]
  allowRules?: readonly string[]
  /** The file is Harness's own (`hooks/harness.json`): deleted once nothing of anybody else's is left in it. */
  ownedFile?: boolean
}

export type JsonHookOutcome = { kind: 'unchanged' } | { kind: 'write'; text: string; removed: number } | { kind: 'delete'; removed: number }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * [text] without Harness's entries. [platform] is whose hook forms count as Harness's: the Windows lines and Claude
 * Code's exec form are Harness's only on Windows, where they are written (hostPlatform, so a spec that fakes win32 on
 * a POSIX host keeps POSIX judgement).
 */
export function withoutHarnessHooks(text: string | null, rule: JsonHookRemoval, platform: NodeJS.Platform = hostPlatform()): JsonHookOutcome {
  if (text === null) return { kind: 'unchanged' }
  const settings: unknown = JSON.parse(text)
  if (!object(settings)) throw new HookPreparationHeld('the settings do not have the declared object shape')
  const owns = (block: HookBlock) => isOurs(block, platform) || (rule.messages === true && isMessagesBlock(block))
  const member = rule.schema === 'named' ? rule.block! : 'hooks'
  const events = settings[member]
  let removed = 0
  if (events !== undefined) {
    if (!object(events)) throw new HookPreparationHeld(`the ${member} member is not an object`)
    for (const [event, list] of Object.entries(events)) {
      if (!Array.isArray(list)) continue
      let kept: unknown[], gone: number
      if (rule.schema === 'nested') {
        const blocks = list as HookBlock[]
        // foreignHookBlocks refuses a block of unconfirmed shape before anything is counted as removed.
        kept = foreignHookBlocks(blocks, owns)
        gone = blocks.reduce((n, b) => n + b.hooks.filter((hook) => owns({ hooks: [hook] })).length, 0)
      } else {
        kept = list.filter((entry) => !(object(entry) && isManagedHookCommand(entry.command, platform)))
        gone = list.length - kept.length
      }
      // Replaced only when something of Harness's went (a shared block keeps its length), so an untouched event keeps
      // its exact value; a replaced one keeps its place among the keys.
      if (gone) {
        removed += gone
        if (kept.length) events[event] = kept
        else delete events[event]
      }
    }
    if (rule.schema === 'named' && Object.keys(events).length === 0 && removed > 0) delete settings[member]
  }
  if (rule.allowList && rule.allowRules?.length) {
    const [table, name] = rule.allowList
    const lists = settings[table]
    if (object(lists) && Array.isArray(lists[name])) {
      const ours = new Set(rule.allowRules)
      const rules = lists[name] as unknown[]
      const kept = rules.filter((r) => !(typeof r === 'string' && ours.has(r)))
      if (kept.length !== rules.length) {
        removed += rules.length - kept.length
        lists[name] = kept
      }
    }
  }
  if (removed === 0) return { kind: 'unchanged' }
  const hooksLeft = object(settings.hooks) ? Object.keys(settings.hooks).length : 0
  if (rule.ownedFile && hooksLeft === 0 && Object.keys(settings).every((key) => key === 'hooks' || key === 'version')) return { kind: 'delete', removed }
  return { kind: 'write', text: JSON.stringify(settings, null, 2) + '\n', removed }
}

/**
 * Why a file was left, as the end of a sentence a person reads in uninstall's report: a held preparation's reason
 * without its "Hook preparation is waiting" prefix, which is the installers' wording, and a refused route's reason
 * without the identity reader's.
 */
export function failure(error: unknown): string {
  if (error instanceof HookPreparationHeld) return error.reason
  if (error instanceof IdentityReadUnavailable) return error.message.replace(/^Conversation identity is held: (.*?)\.?$/s, '$1')
  return error instanceof Error ? error.message : String(error)
}

/** Harness's entries out of one settings file. */
export async function removeJsonHooks(file: string, rule: JsonHookRemoval): Promise<HookFileRemoval> {
  try {
    return await runHookPreparation([file], async (attempt) => {
      const observed = inspectHookFile(file)
      const outcome = withoutHarnessHooks(observed.content, rule)
      if (outcome.kind === 'unchanged') return { file, removed: 0 }
      const published = outcome.kind === 'delete' ? await observed.remove(attempt) : await observed.replace(outcome.text, attempt)
      published.verify()
      return { file, removed: outcome.removed }
    }, { identity: JSON.stringify(['uninstall', file]) })
  } catch (error) {
    return { file, removed: 0, failed: failure(error) }
  }
}

/**
 * A file Harness writes whole (a plugin, a rules file): deleted when [owned] recognizes it (true), kept otherwise; a
 * string from [owned] is why it is kept, for a file that is Harness's but not as Harness wrote it.
 */
export async function removeOwnedFile(file: string, owned: (content: string) => boolean | string): Promise<HookFileRemoval> {
  try {
    return await runHookPreparation([file], async (attempt) => {
      const observed = inspectHookFile(file)
      if (observed.content === null) return { file, removed: 0 }
      const verdict = owned(observed.content)
      if (verdict !== true) return { file, removed: 0, kept: verdict === false ? 'another author’s file' : verdict }
      ;(await observed.remove(attempt)).verify()
      return { file, removed: 1 }
    }, { identity: JSON.stringify(['uninstall', file]) })
  } catch (error) {
    return { file, removed: 0, failed: failure(error) }
  }
}

/**
 * The engine's records of Harness's hooks as reviewed (hookReview.ts), out of its config file in [home]. A record goes
 * when it holds exactly the hash of one of Harness's hooks, and nothing else (`withoutReviewRecords`): the hook at its
 * place in [held.before], the settings file before Harness's hooks were taken out of it, or, by the settings file
 * alone, any of the hooks Harness writes there now ([held.now]), which finds them again on a second uninstall after
 * one that stopped between the hooks and their records. [held.now] is worked out here, inside the preparation: a hook
 * line Harness cannot write for this computer now (a path its quoting refuses, notifyHooks.ts `quoteHookCommand`) finds
 * none, and only the records of the hooks in [held.before] go. The rest of the config stays byte for byte.
 *
 * The limit: Codex keys a record by the hook's place in the settings file (block, hook) and holds its hash, which
 * covers the whole command. A record for a hook of Harness's that is no longer in the file, written by another
 * release, another port or another install folder, matches neither and stays: a stale entry Codex no longer uses.
 */
export async function removeReviewedHooks(record: HookReviewRecord, home: string, settingsFile: string,
  held: { before: Settings | null; now: () => Settings }, platform: NodeJS.Platform = hostPlatform()): Promise<HookFileRemoval> {
  const config = join(home, record.file)
  try {
    return await runHookPreparation([config], async (attempt) => {
      const observed = inspectHookFile(config, 0o600)
      if (observed.content === null) return { file: config, removed: 0 }
      // Keyed as prepareReviewed keys them: the config's real folder and the settings file's name.
      const keyed = join(observed.directory, basename(settingsFile))
      const before = held.before ? reviewRecords(record, keyed, held.before, platform) : new Map<string, string>()
      let current: Settings
      try { current = held.now() } catch { current = { hooks: {} } }
      const now = new Set(reviewRecords(record, keyed, current, platform).values())
      if (before.size === 0 && now.size === 0) return { file: config, removed: 0 }
      const owned = (key: string, hash: string) => before.get(key) === hash || (key.startsWith(`${keyed}:`) && now.has(hash))
      try { parseToml(observed.content, { integersAsBigInt: true, maxDepth: 64 }) }
      catch { throw new HookPreparationHeld('the hook review configuration is not complete TOML') }
      const { text, removed } = withoutReviewRecords(observed.content, record, owned)
      if (removed === 0) return { file: config, removed: 0 }
      try { parseToml(text, { integersAsBigInt: true, maxDepth: 64 }) }
      catch { throw new HookPreparationHeld('the hook review configuration would not stay complete TOML') }
      ;(await observed.replace(text, attempt)).verify()
      return { file: config, removed }
    }, { identity: JSON.stringify(['uninstall', config]) })
  } catch (error) {
    return { file: config, removed: 0, failed: failure(error) }
  }
}
