/**
 * Harness's status line for a launch (facets/launch.ts `StatusLineContract`, task #4137): a settings object whose status
 * line runs hook/statusline.mjs, which records the plan's rate limits the engine reports to it and then runs the
 * person's own status line command, read here from their settings as the engine reads them, so their line shows as
 * before. The router's quota comes from that record, never from a login (lib/quotaReports.ts).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StatusLineContract } from '../facets/launch.js'
import { shellSingleQuote } from '../../lib/shellQuote.js'
import type { AttributionFiles } from './attribution.js'
import { isRecord, jsonObject } from './launchValues.js'
import { quoteHookCommand } from './hookCommand.js'

/** Claude merges settings objects recursively, retaining the person's nested status-line properties. */
const merged = (into: unknown, value: unknown): unknown => isRecord(into) && isRecord(value)
  ? { ...into, ...Object.fromEntries(Object.entries(value).map(([key, child]) => [key, merged(into[key], child)])) }
  : value

declare const __STATUS_LINE_SCRIPT__: string | undefined

/** Where a launch's status line reads the person's settings: their own, then the folder's. */
export type StatusLineFiles = AttributionFiles

/**
 * The script, as this release ships it. The release bundle carries it inside cli.js (build-bundle.mjs `define`): the
 * self-updater and the Windows installer move cli.js and notify.mjs alone. A dev checkout and the tests read the file.
 */
export function statusLineScript(): string {
  return typeof __STATUS_LINE_SCRIPT__ === 'string'
    ? __STATUS_LINE_SCRIPT__
    : readFileSync(new URL('../../../hook/statusline.mjs', import.meta.url), 'utf8')
}

/** A word a POSIX shell reads as itself. */
const BARE_WORD = /^[A-Za-z0-9_-]+$/

let leftAlone = false

/**
 * [argv] as the line the shell that runs it reads: a POSIX shell off Windows; on Windows the one Claude Code runs its status
 * line in (lib/windows/claudeCodeGitBash.ts, task #4164), Git Bash with its paths in forward slashes, else PowerShell (`& 'program' …`).
 * Null for a word PowerShell would not pass whole.
 */
function commandLine(argv: string[], platform: NodeJS.Platform, bash: string | null): string | null {
  if (platform === 'win32' && !bash) {
    try { return quoteHookCommand('powershell', argv) as string } catch { return null }
  }
  const words = platform === 'win32' ? argv.map((arg) => arg.replace(/\\/g, '/')) : argv
  return words.map((arg) => BARE_WORD.test(arg) ? arg : shellSingleQuote(arg)).join(' ')
}

/** Rendering uses captured settings and owner-selected runtime paths; publication belongs to the caller. */
export function preparedStatusLine(contract: StatusLineContract, files: StatusLineFiles, dataDir: string,
  runtimeNode: string, script: () => string | null, platform: NodeJS.Platform, gitBash: string | null): Record<string, unknown> | null {
  const paths = [join(files.home, contract.file), ...(files.cwd ? contract.folder.map((name) => join(files.cwd!, name)) : [])]
  let theirs: unknown
  for (const path of paths) {
    const settings = jsonObject(files.read(path))
    if (settings && Object.hasOwn(settings, contract.key)) theirs = merged(theirs, settings[contract.key])
  }
  const own = isRecord(theirs) && theirs.type === contract.type && typeof theirs.command === 'string' && theirs.command.trim() ? theirs : null
  const bash = platform === 'win32' ? gitBash : null
  // In PowerShell the script could not run the person's line as Claude Code runs it there: theirs is left as it is.
  if (own && platform === 'win32' && !bash) {
    if (!leftAlone) console.warn('[statusline] Claude Code runs status lines in PowerShell here (no Git Bash), so a session with the person\'s own status line reports no quota')
    leftAlone = true
    return null
  }
  const path = script()
  if (!path) return null
  const command = commandLine([runtimeNode, path, '--data', dataDir,
    ...(own ? ['--then', Buffer.from(own.command as string, 'utf8').toString('base64url')] : []), ...(bash ? ['--bash', bash] : [])], platform, bash)
  if (!command) return null
  const { type: _type, command: _command, ...kept } = own ?? {}
  return { [contract.key]: { ...kept, type: contract.type, command } }
}
