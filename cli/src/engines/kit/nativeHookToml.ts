/** Eager mechanics for a vendor whose hooks are [[hooks]] arrays-of-tables in a config.toml
 * (Kimi Code CLI). Foreign content is never rewritten: Harness owns only the text between its
 * marker comments, and appends that block at EOF when absent. */
import { parse as parseToml } from 'smol-toml'
import { command, hooksNotInstalled, hooksNotOnWindows, type NotifyEngine } from './notifyHooks.js'
import { HookPreparationHeld, inspectHookFile, runHookPreparation } from './nativeHookFiles.js'
import type { NativeHookOptions } from './nativeLocations.js'
import { hostPlatform } from './windowsFiles.js'

export interface NativeHookTomlSettings {
  file: string
  engine: NotifyEngine
  events: readonly string[]
  timeout?: number
  /** Ownership proof: the marker comments bracketing the managed block. */
  startMarker: string
  endMarker: string
  messages: { current: string; installed: string; after?: string; failed: string; malformed?: readonly string[] }
}

/** TOML basic-string escaping for the values we write (event names and a shell command line). */
function tomlString(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\b]/g, '\\b')
    .replace(/\f/g, '\\f')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`
}

function managedBlock(rule: NativeHookTomlSettings, cmd: string): string {
  const lines = [rule.startMarker]
  for (const event of rule.events) {
    lines.push('[[hooks]]')
    lines.push(`event = ${tomlString(event)}`)
    lines.push(`command = ${tomlString(cmd)}`)
    if (rule.timeout !== undefined) lines.push(`timeout = ${rule.timeout}`)
  }
  lines.push(rule.endMarker)
  return lines.join('\n') + '\n'
}

/** The managed block's span, or null when absent. A start marker without its end marker is a
 *  hand-edited file: refuse rather than guess where the person's content ends. */
function managedSpan(content: string, rule: NativeHookTomlSettings): { start: number; end: number } | null {
  const start = content.indexOf(rule.startMarker)
  const end = content.indexOf(rule.endMarker)
  if (start === -1 && end === -1) return null
  if (start === -1 || end === -1 || end < start) throw new HookPreparationHeld('the managed hook markers are incomplete')
  return { start, end: end + rule.endMarker.length }
}

export async function installNativeTomlHooks(rule: NativeHookTomlSettings, port: number, options: NativeHookOptions = {}, platform: NodeJS.Platform = hostPlatform()): Promise<boolean> {
  // Kimi's hook runner on Windows is unverified; a POSIX line in a config the Windows build reads
  // would be a hook that never fires, silently. No win32Runner, like the engines without one.
  if (platform === 'win32') return hooksNotOnWindows(rule.engine)
  const cmd = command(port, rule.engine, undefined, undefined, options.environment, 'bash')
  try {
    return await runHookPreparation([rule.file], async attempt => {
      const observed = inspectHookFile(rule.file)
      const content = observed.content ?? ''
      if (content !== '') {
        // Validate the person's file BEFORE touching it; a malformed config.toml left by us would
        // stop the vendor CLI from loading its configuration at all.
        try {
          parseToml(content)
        } catch {
          throw new HookPreparationHeld('the config file is not valid TOML; leaving it unchanged')
        }
      }
      const span = content === '' ? null : managedSpan(content, rule)
      const block = managedBlock(rule, cmd)
      // The block carries its own trailing newline; the span ends at the end marker, so a remainder
      // that begins with the old block's newline would double it.
      const next = span === null
        ? content + (content === '' || content.endsWith('\n') ? '' : '\n') + block
        : content.slice(0, span.start) + block + content.slice(span.end).replace(/^\n/, '')
      const changed = next !== content
      const published = await observed.replace(changed ? next : content, attempt)
      published.verify()
      console.log(changed ? rule.messages.installed.replace('{file}', () => rule.file) : rule.messages.current)
      if (changed && rule.messages.after) console.log(rule.messages.after)
      return true
    }, { ...options, identity: JSON.stringify(['toml-hooks', rule.engine, rule.file, port, cmd]) })
  } catch (error) {
    const line = hooksNotInstalled(rule.engine, error, platform)
    if (line) console.error(line)
    else console.error(rule.messages.failed, error)
    return false
  }
}
