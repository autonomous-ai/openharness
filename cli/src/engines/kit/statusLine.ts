/**
 * Harness's status line for a launch (facets/launch.ts `StatusLineContract`, task #4137): a settings object whose status
 * line runs hook/statusline.mjs, which records the plan's rate limits the engine reports to it and then runs the
 * person's own status line command, read here from their settings as the engine reads them, so their line shows as
 * before. The router's quota comes from that record, never from a login (lib/quotaReports.ts).
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StatusLineContract } from '../facets/launch.js'
import { managedNodePath } from '../../lib/nodeRuntime.js'
import { shellSingleQuote } from '../../lib/shellQuote.js'
import { isRecord, jsonObject, merged, type AttributionFiles } from './attribution.js'

declare const __STATUS_LINE_SCRIPT__: string | undefined

/** Where a launch's status line reads the person's settings; `folder: false` reads only their own, not the folder's. */
export type StatusLineFiles = AttributionFiles & { folder: boolean }

/**
 * The script, as this release ships it. The release bundle carries it inside cli.js (build-bundle.mjs `define`): the
 * self-updater and the Windows installer move cli.js and notify.mjs alone. A dev checkout and the tests read the file.
 */
function scriptText(): string {
  return typeof __STATUS_LINE_SCRIPT__ === 'string'
    ? __STATUS_LINE_SCRIPT__
    : readFileSync(new URL('../../../hook/statusline.mjs', import.meta.url), 'utf8')
}

let missing = false

/**
 * The script's path in the data folder, written there when it differs from this release's, or null when it cannot be.
 * Renamed into place: a session's status line may be running the one there.
 */
function scriptIn(dataDir: string): string | null {
  const folder = join(dataDir, 'statusline')
  const file = join(folder, 'statusline.mjs')
  try {
    const text = scriptText()
    let current: string | null = null
    try { current = readFileSync(file, 'utf8') } catch { /* not written yet */ }
    if (current !== text) {
      mkdirSync(folder, { recursive: true, mode: 0o700 })
      const temporary = join(folder, `.statusline.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
      try {
        writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' })
        renameSync(temporary, file)
      } catch (error) {
        rmSync(temporary, { force: true })
        throw error
      }
    }
    return file
  } catch (error) {
    // The session starts with the person's status line untouched, and the router reads no report for it.
    if (!missing) console.warn(`[statusline] not written in ${folder}, so Claude sessions start without the quota report: ${String(error)}`)
    missing = true
    return null
  }
}

/** A word every shell a status line may run in reads as itself. */
const BARE_WORD = /^[A-Za-z0-9_-]+$/
const WINDOWS_WORD = /^[A-Za-z0-9_:/.-]+$/

/**
 * [argv] as one shell line. Off Windows a POSIX shell reads it, so a word that is not bare is single-quoted. On Windows
 * the engine runs it in Git Bash or PowerShell, which no one quoting serves (kit/notifyHooks.ts `quoteHookCommand`), and a
 * status line has no exec form: paths go with forward slashes, which both read as themselves, and a word that would need
 * quoting gives no line.
 */
function commandLine(argv: string[], platform: NodeJS.Platform): string | null {
  if (platform !== 'win32') return argv.map((arg) => BARE_WORD.test(arg) ? arg : shellSingleQuote(arg)).join(' ')
  const words = argv.map((arg) => arg.replace(/\\/g, '/'))
  return words.every((word) => WINDOWS_WORD.test(word)) ? words.join(' ') : null
}

/** The settings object that gives the launch Harness's status line, or null where it cannot have one. */
export function statusLineSetting(contract: StatusLineContract, files: StatusLineFiles, dataDir: string,
  platform: NodeJS.Platform = process.platform): Record<string, unknown> | null {
  const paths = [join(files.home, contract.file), ...(files.cwd && files.folder ? contract.folder.map((name) => join(files.cwd!, name)) : [])]
  let theirs: unknown
  for (const path of paths) {
    const settings = jsonObject(files.read(path))
    if (settings && Object.hasOwn(settings, contract.key)) theirs = merged(theirs, settings[contract.key])
  }
  const own = isRecord(theirs) && theirs.type === contract.type && typeof theirs.command === 'string' && theirs.command.trim() ? theirs : null
  // On Windows the script would run the person's command in another shell than the engine does: theirs is left as it is.
  if (own && platform === 'win32') return null
  const script = scriptIn(dataDir)
  if (!script) return null
  const command = commandLine([managedNodePath(), script, '--data', dataDir,
    ...(own ? ['--then', Buffer.from(own.command as string, 'utf8').toString('base64url')] : [])], platform)
  if (!command) return null
  const { type: _type, command: _command, ...kept } = own ?? {}
  return { [contract.key]: { ...kept, type: contract.type, command } }
}

/** A settings value of [args] as an object, or null for one that is not (a settings file's path). */
const settingsObject = (value: string | undefined): Record<string, unknown> | null => value === undefined ? null : jsonObject(value)

/** Two settings objects as one, as the engine merges its settings files, and lists (hooks) kept from both. */
const both = (into: unknown, value: unknown): unknown => Array.isArray(into) && Array.isArray(value) ? [...into, ...value]
  : isRecord(into) && isRecord(value) ? { ...into, ...Object.fromEntries(Object.entries(value).map(([key, child]) => [key, both(into[key], child)])) }
    : value

/**
 * [args] with every settings object given by [flag] merged into one, where the first was: the engine keeps only the
 * last, and a Swarm's shell guard (lib/agentShellGuard.ts), Harness's status line and the pull request setting are each
 * one. Left as they are when any of them is not an object.
 */
export function joinedSettings(flag: string, args: readonly string[]): string[] {
  const at: number[] = []
  for (let i = 0; i < args.length - 1; i++) if (args[i] === flag) at.push(i++)
  if (at.length < 2) return [...args]
  const objects = at.map((i) => settingsObject(args[i + 1]))
  if (objects.some((object) => object === null)) return [...args]
  const one = JSON.stringify(objects.reduce<unknown>((into, object) => both(into, object), {}))
  const skipped = new Set(at.slice(1).flatMap((i) => [i, i + 1]))
  return args.flatMap((arg, i) => i === at[0]! + 1 ? [one] : skipped.has(i) ? [] : [arg])
}
