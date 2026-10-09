/** Native plugin bytes are engine declarations. Installing them never loads an interpreter. */
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export interface NativePlugin {
  file: string
  template: readonly (string | { argument: 'port' | 'credential' | 'version' })[]
  directories?: readonly { path: string; mode?: number }[]
  messages: { current: string; installed: string; after: readonly string[]; failed: string }
}
export interface NativePluginValues { port: string; credential: string; version: string }

/** Joining parts once keeps a path's contents literal, even when it resembles a template argument. */
export function nativePluginSource(rule: NativePlugin, values: NativePluginValues): string {
  return rule.template.map(part => typeof part === 'string' ? part : values[part.argument]).join('')
}

export function installNativePlugin(rule: NativePlugin, values: NativePluginValues): void {
  const source = nativePluginSource(rule, values)
  const file = rule.file
  try {
    if (existsSync(file) && readFileSync(file, 'utf-8') === source) {
      console.log(rule.messages.current)
      return
    }
  } catch { /* unreadable — rewrite it */ }
  try {
    mkdirSync(dirname(file), { recursive: true })
    for (const directory of rule.directories ?? []) mkdirSync(directory.path, { recursive: true, mode: directory.mode })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, source)
    renameSync(tmp, file)
    console.log(rule.messages.installed.replace('{file}', () => file))
    for (const line of rule.messages.after) console.log(line)
  } catch (err) { console.error(rule.messages.failed, err) }
}

export interface NativePluginRemoval {
  file: string
  prefix: string
  contains: string
  removed: string
  failed: string
}
/** The engine may still discover an older plugin with an incompatible API. Remove only our artifact. */
export function removeNativePlugin(rule: NativePluginRemoval): void {
  try {
    const source = readFileSync(rule.file, 'utf8')
    if (source.startsWith(rule.prefix) && source.includes(rule.contains)) {
      unlinkSync(rule.file)
      console.log(rule.removed)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(rule.failed, err)
  }
}
