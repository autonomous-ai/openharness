/** Eager mechanics for the native JSON hook schemas. Each engine declares its events and ownership rules. */
import { existsSync, readFileSync } from 'node:fs'
import { command, isOurs, writeJsonAtomic, type Settings, type HookBlock } from './notifyHooks.js'

export interface NativeHookSettings {
  file: string
  engine: Parameters<typeof command>[1]
  schema: 'nested' | 'entries' | 'named' | 'file'
  events: readonly string[]
  timeout?: number
  eventFlag?: string
  version?: number
  block?: string
  failClosed?: boolean
  messages: { current: string; installed: string; after?: string; failed: string; malformed?: readonly string[] }
}
type Entry = { type?: string; command: string; timeout?: number; failClosed?: boolean }
type EntrySettings = { version?: number; hooks?: Record<string, Entry[]> } & Record<string, unknown>
type NamedSettings = Record<string, Record<string, Entry[]> | unknown>
const UNREADABLE = Symbol('unreadable')

function readSettings(rule: NativeHookSettings, file: string): unknown | typeof UNREADABLE {
  if (!existsSync(file)) return {}
  try { return JSON.parse(readFileSync(file, 'utf-8')) } catch {
    for (const line of rule.messages.malformed ?? []) console.error(line.replace('{file}', () => file))
    return UNREADABLE
  }
}
function writeSettings(rule: NativeHookSettings, file: string, settings: unknown): void {
  try {
    writeJsonAtomic(file, settings)
    console.log(rule.messages.installed.replace('{file}', () => file))
    if (rule.messages.after) console.log(rule.messages.after)
  } catch (err) { console.error(rule.messages.failed, err) }
}

export function installNativeHookSettings(rule: NativeHookSettings, port: number): void {
  const file = rule.file
  if (rule.schema === 'file') {
    const cmd = command(port, rule.engine)
    const settings = { version: rule.version!, hooks: Object.fromEntries(rule.events.map(event =>
      [event, [{ type: 'command', command: `${cmd} ${rule.eventFlag} ${event}` }]])) }
    let existing: unknown = null
    if (existsSync(file)) { try { existing = JSON.parse(readFileSync(file, 'utf-8')) } catch { existing = null } }
    if (JSON.stringify(existing) === JSON.stringify(settings)) { console.log(rule.messages.current); return }
    writeSettings(rule, file, settings)
    return
  }
  const parsed = readSettings(rule, file)
  if (parsed === UNREADABLE) return
  if (rule.schema === 'named') {
    const settings: NamedSettings = !parsed || typeof parsed !== 'object' || Array.isArray(parsed) ? {} : parsed as NamedSettings
    const cmd = command(port, rule.engine)
    const block = Object.fromEntries(rule.events.map(event => [event,
      [{ type: 'command', command: `${cmd} ${rule.eventFlag} ${event}`, timeout: rule.timeout }]]))
    if (JSON.stringify(settings[rule.block!]) === JSON.stringify(block)) { console.log(rule.messages.current); return }
    settings[rule.block!] = block
    writeSettings(rule, file, settings)
    return
  }
  if (rule.schema === 'entries') {
    const settings = parsed as EntrySettings
    if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}
    if (typeof settings.version !== 'number') settings.version = rule.version
    const cmd = command(port, rule.engine)
    let changed = false
    for (const event of rule.events) {
      const entries = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
      const foreign = entries.filter(entry => !entry?.command?.includes('notify.mjs'))
      const ours = entries.filter(entry => entry?.command?.includes('notify.mjs'))
      const canonical: Entry = { command: cmd, failClosed: rule.failClosed }
      if (ours.length !== 1 || ours[0]?.command !== cmd || ours[0]?.failClosed !== rule.failClosed) changed = true
      settings.hooks[event] = [...foreign, canonical]
    }
    if (!changed) { console.log(rule.messages.current); return }
    writeSettings(rule, file, settings)
    return
  }
  const settings = parsed as Settings
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}
  const cmd = command(port, rule.engine)
  let changed = false
  for (const event of rule.events) {
    const blocks = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
    const foreign = blocks.filter(block => !isOurs(block))
    const ours = blocks.filter(isOurs)
    const canonical: HookBlock = { hooks: [{ type: 'command', command: cmd, timeout: rule.timeout }] }
    if (ours.length !== 1 || ours[0]?.hooks?.[0]?.command !== cmd) changed = true
    settings.hooks[event] = [...foreign, canonical]
  }
  if (!changed) { console.log(rule.messages.current); return }
  writeSettings(rule, file, settings)
}
