/**
 * What Harness Device's plugin for Orca (plugins/harness-device-orca) is in Orca, from Orca's own CLI: `orca status`,
 * `orca plugin inspect` and `orca plugin list`, each with `--json`. Orca installs the plugin from a folder in the data
 * folder that holds the files cli.js carries (orcaPluginFolder.ts), written before Orca is asked about it. It runs in
 * the `harness` command's own process (`harness device orca`), never in the core's or the devices' process. Orca's
 * answers are outside text: each is read up to ORCA_ANSWER_MAX_BYTES, only the fields named here are read, and nothing
 * of them is logged (docs/plans/2026-11-18-connect-orca-design.md).
 */
import { realpathSync } from 'node:fs'
import { readOrcaConnected } from './dialSkillFiles.js'
import { orcaBinary, orcaHomesDeps } from './orcaHomes.js'
import { ensureOrcaPluginFolder } from './orcaPluginFolder.js'

declare const __ORCA_PLUGIN__: string | undefined

export const ORCA_STATUS_MS = 5_000
export const ORCA_READ_MS = 10_000
/** Each of Orca's answers is read up to this; a longer one is not read at all. */
export const ORCA_ANSWER_MAX_BYTES = 256 * 1024
export type OrcaPluginFiles = Readonly<Record<string, string>>
/** The real things: Orca's CLI and what cli.js carries. */
export interface OrcaPluginRun {
  platform: NodeJS.Platform
  /** Orca's CLI (`orcaBinary`), null when it is not here. */
  orca(): string | null
  /** `orcaHomesDeps().run`: no shell; `code` null for a kill, a binary that could not start or output past maxBytes. */
  run(file: string, args: string[], opts: { timeoutMs: number; maxBytes: number }): Promise<{ code: number | null; stdout: string; timedOut: boolean }>
  /** Null in a run from the sources. */
  files(): OrcaPluginFiles | null
}
export interface OrcaPluginDeps extends OrcaPluginRun { folder: string; dataDir: string }
export type OrcaPluginState = 'absent' | 'offer' | 'off' | 'approve' | 'behind' | 'current'

/** The state, and what a connect needs beside it: whether `absent` is a CLI from the sources, the plugin's key to name
 *  to Orca, and whether a plugin `behind` was installed from the plugin's own folder. */
type Found =
  | { state: 'absent'; fromSources?: true }
  | { state: 'offer' | 'off' | 'current' }
  | { state: 'approve'; key: string }
  | { state: 'behind'; key: string; ours: boolean }

const ABSENT: Found = { state: 'absent' }
/** The one range Orca's manifests take. */
const ENGINE = /^>=(\d+)\.(\d+)\.(\d+)$/
const APP_VERSION = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
/** `<publisher>.<id>`: a key is later an argument to Orca, so it is held to that. */
const PLUGIN_KEY = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether Orca at [version] takes a plugin whose `engines.orca` is [range], as Orca 1.4.262 checks it
 *  (satisfiesOrcaEngineRange): the three numbers in order, and a prerelease of the same three ranks below them. */
function meets(version: string, range: string): boolean {
  const app = APP_VERSION.exec(version)
  const floor = ENGINE.exec(range)
  if (app === null || floor === null) return false
  for (let i = 1; i <= 3; i++) {
    if (Number(app[i]) !== Number(floor[i])) return Number(app[i]) > Number(floor[i])
  }
  return app[4] === undefined
}

/** A path by its real path, or as written when it does not resolve: Orca may record the folder through a link, or
 *  resolve one the command was handed, and either names the same folder. */
function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Orca's `result` for a run that exited 0 and answered `ok`; undefined for any other, a deadline passed among them. */
async function ask(deps: OrcaPluginDeps, orca: string, args: string[], timeoutMs: number): Promise<Record<string, unknown> | undefined> {
  const { code, stdout } = await deps.run(orca, args, { timeoutMs, maxBytes: ORCA_ANSWER_MAX_BYTES })
  if (code !== 0) return undefined
  let answer: unknown
  try {
    answer = JSON.parse(stdout)
  } catch {
    return undefined
  }
  return isObject(answer) && answer.ok === true && isObject(answer.result) ? answer.result : undefined
}

/** The first rule that holds (the design's `status`). Orca is asked `status` first: every other plugin command waits
 *  about 30 seconds for an Orca that is not reachable. */
async function find(deps: OrcaPluginDeps): Promise<Found> {
  if (deps.platform === 'win32') return ABSENT
  const files = deps.files()
  if (files === null) return { state: 'absent', fromSources: true }
  const orca = deps.orca()
  if (orca === null) return ABSENT
  const carried = JSON.parse(files['orca-plugin.json']) as { version: string; engines: { orca: string } }
  const runtime = (await ask(deps, orca, ['status', '--json'], ORCA_STATUS_MS))?.runtime
  if (!isObject(runtime) || runtime.reachable !== true || typeof runtime.appVersion !== 'string') return ABSENT
  if (!meets(runtime.appVersion, carried.engines.orca)) return ABSENT
  if (ensureOrcaPluginFolder(deps.folder, files) === 'failed') return ABSENT
  const plugin = (await ask(deps, orca, ['plugin', 'inspect', deps.folder, '--json'], ORCA_READ_MS))?.plugin
  const key = isObject(plugin) ? plugin.pluginKey : undefined
  if (typeof key !== 'string' || !PLUGIN_KEY.test(key)) return ABSENT
  const plugins = (await ask(deps, orca, ['plugin', 'list', '--json'], ORCA_READ_MS))?.plugins
  if (!Array.isArray(plugins)) return ABSENT
  const entry = plugins.find((listed): listed is Record<string, unknown> => isObject(listed) && listed.pluginKey === key)
  if (entry === undefined) {
    // A record that cannot be read is not "never connected": that would offer the plugin again to a person who
    // removed it.
    const record = readOrcaConnected(deps.dataDir)
    if (record.unread) return ABSENT
    return { state: record.connected ? 'off' : 'offer' }
  }
  const { version, status, source } = entry
  if (typeof version !== 'string' || typeof status !== 'string' || entry.isDev === true) return ABSENT
  if (status === 'disabled') return { state: 'off' }
  if (status === 'pending' || entry.needsReconsent === true) return { state: 'approve', key }
  const ours = isObject(source) && source.kind === 'local-path' && typeof source.reference === 'string' && real(source.reference) === real(deps.folder)
  if (version !== carried.version || !ours) return { state: 'behind', key, ours }
  if (status === 'errored' || status === 'invalid') return ABSENT
  return { state: 'current' }
}

/** This computer's `orca`, and the plugin's files the build inlined. */
export function orcaPluginRun(): OrcaPluginRun {
  const deps = orcaHomesDeps()
  return {
    platform: deps.platform,
    orca: () => orcaBinary(deps),
    run: deps.run,
    files: () => typeof __ORCA_PLUGIN__ === 'string' ? JSON.parse(__ORCA_PLUGIN__) as OrcaPluginFiles : null,
  }
}

export async function orcaStatus(deps: OrcaPluginDeps): Promise<{ orca: OrcaPluginState }> {
  return { orca: (await find(deps)).state }
}
