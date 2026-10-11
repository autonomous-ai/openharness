/** Native plugin bytes are engine declarations. Installing them never loads an interpreter. */
import { mkdirSync } from 'node:fs'
import { HookPreparationHeld, inspectHookFile, type HookFilePublication, runHookPreparation, type HookPreparationAttempt, type HookPreparationOptions } from './nativeHookFiles.js'

export interface NativePlugin {
  file: string
  template: readonly (string | { argument: 'port' | 'credential' | 'version' })[]
  directories?: readonly { path: string; mode?: number }[]
  messages: { current: string; installed: string; after: readonly string[]; failed: string }
}
export interface NativePluginValues { port: string; credential: string; version: string }
export interface PreparedNativePlugin { verify(): void; commit(attempt: HookPreparationAttempt): Promise<HookFilePublication> }

/** Joining parts once keeps a path's contents literal, even when it resembles a template argument. */
export function nativePluginSource(rule: NativePlugin, values: NativePluginValues): string {
  return rule.template.map(part => typeof part === 'string' ? part : values[part.argument]).join('')
}

/** Observe every destination before a multi-file installation changes any of them. */
export function prepareNativePlugin(rule: NativePlugin, values: NativePluginValues): PreparedNativePlugin {
  const source = nativePluginSource(rule, values), observed = inspectHookFile(rule.file)
  const current = observed.content === source
  // The generated first line declares this managed artifact's engine and owner.
  // An occupied path without that declaration belongs to its author.
  const prefix = source.slice(0, source.indexOf('\n') + 1)
  if (!current && observed.content !== null && (!prefix || !observed.content.startsWith(prefix))) {
    throw new HookPreparationHeld('the plugin path contains another author’s file')
  }
  observed.prepare(source)
  return { verify: observed.verify, commit: async attempt => {
    attempt.verify()
    observed.verify()
    for (const directory of current ? [] : rule.directories ?? []) {
      attempt.verify(); attempt.check()
      mkdirSync(directory.path, { recursive: true, mode: directory.mode })
    }
    const published = await observed.replace(source, attempt)
    console.log(current ? rule.messages.current : rule.messages.installed.replace('{file}', () => rule.file))
    if (!current) for (const line of rule.messages.after) console.log(line)
    return published
  } }
}

export async function installNativePlugin(rule: NativePlugin, values: NativePluginValues, options: HookPreparationOptions = {}): Promise<boolean> {
  try { return await runHookPreparation([rule.file], async attempt => {
    const published = await prepareNativePlugin(rule, values).commit(attempt)
    published.verify(); return true
  }, { ...options, identity: nativePluginSource(rule, values) }) }
  catch (err) { console.error(rule.messages.failed, err); return false }
}

export interface NativePluginRemoval {
  file: string
  prefix: string
  contains: string
  removed: string
  failed: string
}

export function prepareNativePluginRemoval(rule: NativePluginRemoval): PreparedNativePlugin {
  const observed = inspectHookFile(rule.file), source = observed.content
  if (source !== null && !(source.startsWith(rule.prefix) && source.includes(rule.contains))) {
    throw new HookPreparationHeld('the incompatible plugin path contains another author’s file')
  }
  observed.prepare(null)
  return { verify: observed.verify, commit: async attempt => {
    attempt.check()
    const removed = await observed.remove(attempt)
    if (source !== null) console.log(rule.removed)
    return removed
  } }
}

/** The engine may discover an older incompatible plugin. Remove only our artifact. */
export async function removeNativePlugin(rule: NativePluginRemoval): Promise<boolean> {
  try { return await runHookPreparation([rule.file], async attempt => {
    const removed = await prepareNativePluginRemoval(rule).commit(attempt)
    removed.verify(); return true
  }, { identity: JSON.stringify(rule) }) }
  catch (err) { console.error(rule.failed, err); return false }
}
