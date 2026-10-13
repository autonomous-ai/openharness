/** Eager mechanics for native JSON hook schemas; unreadable settings are never empty settings. */
import { command, isOurs, isManagedHookCommand, foreignHookBlocks, type Settings, type HookBlock } from './notifyHooks.js'
import { HookPreparationHeld, inspectHookFile, runHookPreparation } from './nativeHookFiles.js'
import type { NativeHookOptions } from './nativeLocations.js'

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

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const ours = (entry: Entry) => isManagedHookCommand(entry?.command)
function entries(value: unknown): Entry[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new HookPreparationHeld('a hook event is not a list')
  if (value.some(entry => !object(entry) || (entry.command !== undefined && typeof entry.command !== 'string'))) {
    throw new HookPreparationHeld('a hook entry has an unconfirmed shape')
  }
  return value
}

export async function installNativeHookSettings(rule: NativeHookSettings, port: number, options: NativeHookOptions = {}): Promise<boolean> {
  const cmd = command(port, rule.engine, undefined, undefined, options.environment)
  try { return await runHookPreparation([rule.file], async attempt => {
    const observed = inspectHookFile(rule.file)
    const parsed: unknown = observed.content === null ? {} : JSON.parse(observed.content)
    if (!object(parsed)) throw new HookPreparationHeld('the settings do not have the declared object shape')
    let changed = false
    if (rule.schema === 'named') {
      const prior = parsed[rule.block!]
      if (prior !== undefined && !object(prior)) throw new HookPreparationHeld('the named hooks block is not an object')
      const block = { ...(prior as Record<string, unknown> | undefined) }
      for (const event of rule.events) {
        const list = entries(block[event])
        block[event] = [...list.filter(entry => !ours(entry)),
          { type: 'command', command: `${cmd} ${rule.eventFlag} ${event}`, timeout: rule.timeout }]
      }
      changed = JSON.stringify(prior) !== JSON.stringify(block)
      parsed[rule.block!] = block
    } else {
      if (rule.schema === 'file' && parsed.version === undefined) { parsed.version = rule.version; changed = true }
      if (parsed.hooks !== undefined && !object(parsed.hooks)) throw new HookPreparationHeld('the hooks member is not an object')
      const hooks = (parsed.hooks ??= {}) as Record<string, unknown>
      if (rule.schema === 'entries' || rule.schema === 'file') {
        const settings = parsed as EntrySettings
        if (settings.version === undefined) { settings.version = rule.version; changed = true }
        for (const event of rule.events) {
          const list = entries(hooks[event]), owned = list.filter(ours)
          const canonical: Entry = rule.schema === 'file'
            ? { type: 'command', command: `${cmd} ${rule.eventFlag} ${event}` }
            : { command: cmd, failClosed: rule.failClosed }
          if (owned.length !== 1 || JSON.stringify(owned[0]) !== JSON.stringify(canonical)) changed = true
          hooks[event] = [...list.filter(entry => !ours(entry)), canonical]
        }
      } else {
        const settings = parsed as Settings
        for (const event of rule.events) {
          const blocks = entries(hooks[event]) as unknown as HookBlock[]
          const owned = blocks.filter(isOurs)
          if (owned.length !== 1 || owned[0]?.hooks?.[0]?.command !== cmd) changed = true
          settings.hooks![event] = [...foreignHookBlocks(blocks), { hooks: [{ type: 'command', command: cmd, timeout: rule.timeout }] }]
        }
      }
    }
    const published = await observed.replace(changed ? JSON.stringify(parsed, null, 2) + '\n' : observed.content!, attempt)
    published.verify()
    console.log(changed ? rule.messages.installed.replace('{file}', () => rule.file) : rule.messages.current)
    if (changed && rule.messages.after) console.log(rule.messages.after)
    return true
  }, { ...options, identity: JSON.stringify([rule, port, cmd]) }) } catch (error) {
    console.error(rule.messages.failed, error)
    return false
  }
}
