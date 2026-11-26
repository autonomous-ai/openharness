/**
 * The records that let Codex run Harness Device's plugin hooks without asking a person to review them, written as
 * Codex writes them on "Trust" (codex-cli 0.172.0, the spike of 2026-11-26): in the Codex home's config.toml, a
 * `hooks.state` table per hook holding the hash Codex computes of its declaration (`trusted_hash`, the hash of
 * engines/kit/hookReview.ts) and the fingerprint of the installed folder (`trusted_content_hash`).
 *
 * A record tells Codex to run what is in that folder unasked, so it is written only when the folder's fingerprint is
 * the one of the copy this CLI carries: never for a `main` Codex fetched by itself, nor for a file someone edited.
 * Codex computes the fingerprint again at every hook run and refuses a folder that changed since.
 *
 * config.toml has other writers (Codex, Harness's own hook review, the person): only the plugin's own tables change,
 * the way hookReview.ts edits the file (through a link, atomically, never a table defined twice), and a file that
 * changed since it was read is read again and redone, at most 3 times, so another writer's change is never dropped.
 * A failure is said by its kind alone.
 */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { join, sep } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { hooks } from '../engines/codex/hookContract.js'
import { replaceConfigFile } from '../engines/kit/folderTrust.js'
import { reviewHash, withReviewRecords } from '../engines/kit/hookReview.js'
import { settingsText } from '../lib/settingsText.js'
import { DIAL_PLUGIN_ID } from './dialSkill.js'

export const CODEX_HOOKS_FILE = 'hooks/codex.json'

/** Codex's record of a reviewed hook. A plugin's PermissionRequest matcher is part of its hash, unlike the native
 *  hook's, which has none (the spike: `hooks/list`'s hash of a plugin hook with `matcher: "*"`). */
const REVIEWED = { ...hooks.settings.reviewed!, matcherEvents: ['PermissionRequest', 'PreToolUse'] }
const CONTENT = { ...REVIEWED, key: 'trusted_content_hash' }

/** Bounds of what is read: the plugin is a few files of a few KB. */
const MAX_ENTRIES = 1000
const MAX_PLUGIN_BYTES = 8 * 1024 * 1024
const MAX_CONFIG_BYTES = 1024 * 1024
const ATTEMPTS = 3

/** One entry of Codex's walk: its path from the root, with the platform's separator, and a file's bytes (null: a
 *  folder). */
interface Entry { path: string; bytes: Buffer | null }

/** What Codex leaves out: Python's bytecode, environments and package metadata. */
const skipped = (name: string): boolean => name === '__pycache__' || name === '.venv' || name.endsWith('.pyc') || name.endsWith('.egg-info')
const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b))
const u64 = (value: number): Buffer => {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64LE(BigInt(value))
  return bytes
}

/** Codex's bundle fingerprint (hooks/src/engine/plugin_fingerprint.rs) of entries in its walk's order: depth first,
 *  each folder's names in UTF-8 byte order. */
function fingerprint(entries: readonly Entry[]): string {
  const hash = createHash('sha256').update('codex-plugin-bundle-v1')
  for (const { path, bytes } of entries) {
    const name = Buffer.from(path)
    hash.update(u64(name.length)).update(name)
    if (bytes === null) hash.update('directory')
    else hash.update('file').update(u64(bytes.length)).update(bytes)
  }
  return `sha256:${hash.digest('hex')}`
}

/**
 * A regular file's bytes, at most its size when opened. A FIFO is never waited on; a file that is not one, or is past
 * [max] bytes, throws. A file another writer changes meanwhile reads short or stale, which costs nothing: such a
 * folder's fingerprint is not the expected one, and such a config.toml is not the text read again before the write.
 */
function fileBytes(path: string, max: number): Buffer {
  // Windows defines no O_NONBLOCK: there the open is a plain read-only one.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile() || stats.size > max) throw new Error('not a file within its bound')
    const buffer = Buffer.alloc(stats.size)
    return buffer.subarray(0, readSync(fd, buffer, 0, stats.size, 0))
  } finally {
    closeSync(fd)
  }
}

/** The folder's entries as Codex walks them. A link (the root too), or anything but a file or folder, fails Codex's
 *  own walk and throws here; so does a tree past the bounds. */
function folderEntries(root: string): Entry[] {
  const entries: Entry[] = []
  const pending: Array<[string, string]> = [[root, '']]
  let listed = 1, bytes = 0
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [path, name] = next
    const stats = lstatSync(path)
    if (stats.isDirectory()) {
      entries.push({ path: name, bytes: null })
      const children = readdirSync(path).filter((child) => !skipped(child)).sort(byBytes)
      listed += children.length
      if (listed > MAX_ENTRIES) throw new Error('the plugin has too many entries')
      for (const child of children.reverse()) pending.push([join(path, child), name ? `${name}${sep}${child}` : child])
    } else if (stats.isFile()) {
      const content = fileBytes(path, MAX_PLUGIN_BYTES - bytes)
      bytes += content.length
      entries.push({ path: name, bytes: content })
    } else {
      throw new Error('the plugin holds an entry that is neither a file nor a folder')
    }
  }
  return entries
}

/** The fingerprint Codex computes of the plugin folder at [root]. */
export function pluginContentHash(root: string): string {
  return fingerprint(folderEntries(root))
}

/** A folder holding a map's files, as nested maps: a file's bytes, or a folder's names. */
type Tree = Map<string, Tree | Buffer>

/**
 * The fingerprint Codex would compute on [platform] of a folder holding exactly [files] (`/`-separated paths from its
 * root to UTF-8 text): the copy this CLI carries, before any of it is on disk.
 */
export function filesContentHash(files: Readonly<Record<string, string>>, platform: NodeJS.Platform): string {
  const root: Tree = new Map()
  for (const [path, text] of Object.entries(files)) {
    const names = path.split('/')
    let folder = root
    for (const name of names.slice(0, -1)) {
      let child = folder.get(name)
      if (!(child instanceof Map)) folder.set(name, child = new Map())
      folder = child
    }
    folder.set(names[names.length - 1], Buffer.from(text))
  }
  const separator = platform === 'win32' ? '\\' : '/'
  const entries: Entry[] = []
  const walk = (folder: Tree, path: string): void => {
    entries.push({ path, bytes: null })
    for (const name of [...folder.keys()].filter((child) => !skipped(child)).sort(byBytes)) {
      const child = folder.get(name)!, childPath = path ? `${path}${separator}${name}` : name
      if (child instanceof Map) walk(child, childPath)
      else entries.push({ path: childPath, bytes: child })
    }
  }
  walk(root, '')
  return fingerprint(entries)
}

export interface PluginTrustRecord { key: string; trustedHash: string; contentHash: string }

interface HookGroup { matcher?: unknown; hooks?: unknown }
interface Hook { type?: unknown; command?: unknown; timeout?: number; async?: boolean }

/**
 * The records the plugin at [root] needs, one per command hook its own hooks file declares for an event Codex reviews,
 * keyed as Codex keys a plugin's hook: the plugin, the file from its root, the event's label, the group's and the
 * hook's place. Throws when the folder cannot be walked or its hooks file read or parsed.
 */
export function pluginTrustRecords(root: string): PluginTrustRecord[] {
  const entries = folderEntries(root)
  return trustRecords(entries, fingerprint(entries))
}

/** pluginTrustRecords of a folder walked once: the declarations are read from the bytes that were fingerprinted. */
function trustRecords(entries: readonly Entry[], contentHash: string): PluginTrustRecord[] {
  const file = entries.find((entry) => entry.path === CODEX_HOOKS_FILE.split('/').join(sep))
  if (!file?.bytes) throw new Error('the plugin has no hooks file')
  const declared = (JSON.parse(settingsText(file.bytes)) as { hooks?: Record<string, unknown> }).hooks
  const records: PluginTrustRecord[] = []
  for (const [event, label] of Object.entries(REVIEWED.events)) {
    const groups = declared?.[event]
    if (!Array.isArray(groups)) continue
    groups.forEach((group: HookGroup, groupIndex) => {
      if (!Array.isArray(group?.hooks)) return
      group.hooks.forEach((hook: Hook, hookIndex) => {
        if (hook?.type !== 'command' || typeof hook.command !== 'string') return
        const matcher = typeof group.matcher === 'string' ? group.matcher : undefined
        records.push({
          key: `${DIAL_PLUGIN_ID}:${CODEX_HOOKS_FILE}:${label}:${groupIndex}:${hookIndex}`,
          trustedHash: reviewHash(REVIEWED, event, matcher, { command: hook.command, timeout: hook.timeout, async: hook.async }),
          contentHash,
        })
      })
    })
  }
  return records
}

/**
 * A Codex home's config.toml as text (its target's, when it is a link), or null when there is none. Throws for a file
 * past 1 MiB, one that is not a regular file, and bytes that are not UTF-8: nothing is written into text that could be
 * mojibake.
 */
export function readConfigText(file: string): string | null {
  try {
    return settingsText(fileBytes(file, MAX_CONFIG_BYTES))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export type TrustFailure = 'plugin' | 'differs' | 'missing' | 'unreadable' | 'unparsed' | 'unsafe' | 'changed' | 'write'
export type TrustWrite = { ok: true; changed: boolean } | { ok: false; kind: TrustFailure }

const parses = (text: string): boolean => {
  try {
    parseToml(text, { integersAsBigInt: true, maxDepth: 64 })
    return true
  } catch {
    return false
  }
}

/** [text] with both fields of each record in its own table; 'unsafe' where the file defines `hooks.state` in a form an
 *  edit could make invalid. */
function withTrust(text: string, records: readonly PluginTrustRecord[]): string | 'unsafe' {
  const declared = withReviewRecords(text, REVIEWED, new Map(records.map((record) => [record.key, record.trustedHash])))
  if (declared === 'unsafe') return declared
  const hashed = declared === 'unchanged' ? text : declared
  const both = withReviewRecords(hashed, CONTENT, new Map(records.map((record) => [record.key, record.contentHash])))
  return both === 'unchanged' ? hashed : both
}

/**
 * Trust the plugin installed at [root] in [codexHome]'s config.toml, only when its fingerprint is [expected], the
 * carried copy's. A missing config.toml is left missing: Codex writes it when it installs the plugin.
 */
export function writePluginTrust(codexHome: string, root: string, expected: string,
  io: { read(file: string): string | null; replace(file: string, text: string): void } = { read: readConfigText, replace: replaceConfigFile }): TrustWrite {
  const failed = (kind: TrustFailure): TrustWrite => ({ ok: false, kind })
  let entries: Entry[]
  try {
    entries = folderEntries(root)
  } catch {
    return failed('plugin')
  }
  // The fingerprint first: a folder edited by hand, its hooks file emptied, removed or broken among the edits, differs
  // from the carried copy, whatever it declares.
  if (fingerprint(entries) !== expected) return failed('differs')
  let records: PluginTrustRecord[]
  try {
    records = trustRecords(entries, expected)
  } catch {
    return failed('plugin')
  }
  // The carried copy itself declaring no hook would leave nothing trusted while saying it is.
  if (records.length === 0) return failed('plugin')
  const file = join(codexHome, REVIEWED.fileName)
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let text: string | null, now: string | null
    try {
      text = io.read(file)
    } catch {
      return failed('unreadable')
    }
    if (text === null) return failed('missing')
    if (!parses(text)) return failed('unparsed')
    const next = withTrust(text, records)
    if (next === 'unsafe' || !parses(next)) return failed('unsafe')
    if (next === text) return { ok: true, changed: false }
    try {
      now = io.read(file)
    } catch {
      return failed('unreadable')
    }
    // Another writer changed the file since it was read: its change is kept by starting over from it.
    if (now !== text) continue
    try {
      io.replace(file, next)
    } catch {
      return failed('write')
    }
    return { ok: true, changed: true }
  }
  return failed('changed')
}
