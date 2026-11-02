/** Native plugin bytes are engine declarations. Installing them never loads an interpreter. */
import { mkdirSync } from 'node:fs'
import { HookPreparationHeld, inspectHookFile, type HookFilePublication, runHookPreparation, type HookPreparationAttempt, type HookPreparationOptions } from './nativeHookFiles.js'

export interface NativePlugin {
  file: string
  template: readonly (string | { argument: 'port' | 'credential' | 'version' | 'socket' })[]
  directories?: readonly { path: string; mode?: number }[]
  messages: { current: string; installed: string; after: readonly string[]; failed: string }
}
/** `socket`: the daemon's private socket as JSON, or `null` where it can have none (Windows, or a home too long as well). Absent reads as `null`. */
export interface NativePluginValues { port: string; credential: string; version: string; socket?: string }

/**
 * `fetch` for a plugin's one post to the daemon. Any account can bind the TCP port while the daemon restarts, and would hear the hook token
 * and the session in it (audit H1), so where a socket can be the post goes over it, and only if it is this account's, owner only, in a folder
 * nobody else can write to. Otherwise it fails as a post does, and nothing goes to the port. `node:http` because a plugin's runtime (Bun, Node)
 * has it, where `fetch`'s socket option is Bun's alone.
 */
export const PLUGIN_FETCH = [
`const harnessSocket = `,
{ argument: 'socket' },
`
const harnessFetch = async (url, init) => {
  if (!harnessSocket) return fetch(url, init)
  const { lstatSync } = await import("node:fs")
  const { dirname } = await import("node:path")
  const { request } = await import("node:http")
  const uid = process.getuid?.()
  const file = lstatSync(harnessSocket), folder = lstatSync(dirname(harnessSocket))
  if (!file.isSocket() || (file.mode & 0o077) !== 0 || !folder.isDirectory() || (folder.mode & 0o022) !== 0
    || (uid !== undefined && (file.uid !== uid || folder.uid !== uid))) throw new Error("The Harness socket is not private.")
  return new Promise((resolve, reject) => {
    const asked = request({ socketPath: harnessSocket, method: init.method, path: new URL(url).pathname,
      headers: { ...init.headers, "content-length": String(Buffer.byteLength(init.body)) } }, (answer) => {
      answer.resume()
      answer.on("end", () => resolve({ ok: answer.statusCode >= 200 && answer.statusCode < 300, status: answer.statusCode }))
      answer.on("error", reject)
    })
    asked.on("error", reject)
    asked.end(init.body)
  })
}
`,
] as const
export interface PreparedNativePlugin { verify(): void; commit(attempt: HookPreparationAttempt): Promise<HookFilePublication> }

/** Joining parts once keeps a path's contents literal, even when it resembles a template argument. */
export function nativePluginSource(rule: NativePlugin, values: NativePluginValues): string {
  return rule.template.map(part => typeof part === 'string' ? part : values[part.argument] ?? 'null').join('')
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
