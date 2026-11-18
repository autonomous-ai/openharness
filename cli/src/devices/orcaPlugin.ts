/**
 * What Harness Device's plugin for Orca (plugins/harness-device-orca) is in Orca, from Orca's own CLI: `orca status`,
 * `orca plugin inspect` and `orca plugin list`, each with `--json`; and the connect that installs, updates or enables
 * it (`orca plugin install|update|enable`). Orca installs the plugin from a folder in the data folder that holds the
 * files cli.js carries (orcaPluginFolder.ts), written before Orca is asked about it. It runs in the `harness` command's
 * own process (`harness device orca`), never in the core's or the devices' process. Orca's answers are outside text:
 * each is read up to ORCA_ANSWER_MAX_BYTES, only the fields named here are read, and nothing of them is logged
 * (docs/plans/2026-11-18-connect-orca-design.md).
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

/** The state, and what a connect needs beside it: whether `absent` is a CLI from the sources, the `orca` to run for
 *  the states a connect asks Orca in, the plugin's key to name to Orca, and whether a plugin `behind` was installed
 *  from the plugin's own folder. */
type Found =
  | { state: 'absent'; fromSources?: true }
  | { state: 'off' }
  | { state: 'current' }
  | { state: 'offer'; orca: string }
  | { state: 'approve'; orca: string; key: string }
  | { state: 'behind'; orca: string; key: string; ours: boolean }

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

/** Orca's `--json` answer, one object; undefined for anything else. */
function parse(stdout: string): Record<string, unknown> | undefined {
  try {
    const answer: unknown = JSON.parse(stdout)
    return isObject(answer) ? answer : undefined
  } catch {
    return undefined
  }
}

/** Orca's `result` for a run that exited 0 and answered `ok`; undefined for any other, a deadline passed among them. */
async function ask(deps: OrcaPluginDeps, orca: string, args: string[], timeoutMs: number): Promise<Record<string, unknown> | undefined> {
  const { code, stdout } = await deps.run(orca, args, { timeoutMs, maxBytes: ORCA_ANSWER_MAX_BYTES })
  const answer = code === 0 ? parse(stdout) : undefined
  return answer?.ok === true && isObject(answer.result) ? answer.result : undefined
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
    return record.connected ? { state: 'off' } : { state: 'offer', orca }
  }
  const { version, status, source } = entry
  if (typeof version !== 'string' || typeof status !== 'string' || entry.isDev === true) return ABSENT
  if (status === 'disabled') return { state: 'off' }
  if (status === 'pending' || entry.needsReconsent === true) return { state: 'approve', orca, key }
  const ours = isObject(source) && source.kind === 'local-path' && typeof source.reference === 'string' && real(source.reference) === real(deps.folder)
  if (version !== carried.version || !ours) return { state: 'behind', orca, key, ours }
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

/** An approval fingerprint as Orca prints one, held to it where it comes in: from the caller and from Orca. */
export const ORCA_FINGERPRINT = /^ap1-[0-9a-f]{32}$/
export const ORCA_CONNECT_MS = 60_000
export const ORCA_GRANTS_MAX = 10
export const ORCA_GRANT_MAX_CHARS = 300
export type OrcaConnectError = 'not-running' | 'no-plugin' | 'off' | 'timeout' | 'failed'
export type OrcaConnect =
  | { connect: 'done' }
  | { connect: 'approve'; name: string; version: string; fingerprint: string; grants: string[]; update: boolean }
  | { connect: 'failed'; error: OrcaConnectError }

const FAILED: OrcaConnect = { connect: 'failed', error: 'failed' }
/** Line breaks and tabs among them. */
const CONTROL = /\p{Cc}/u

/** [text] as one line of an approval, trimmed; undefined when it is no string, holds a control character or is longer
 *  than ORCA_GRANT_MAX_CHARS. Characters are code points, as the app counts them (Rust's `chars()`), so a line this
 *  passes the app passes too. */
function line(text: unknown): string | undefined {
  if (typeof text !== 'string' || CONTROL.test(text)) return undefined
  const trimmed = text.trim()
  return [...trimmed].length > ORCA_GRANT_MAX_CHARS ? undefined : trimmed
}

/** The access an approval's `grants` lists, in Orca's order and words: what runs, each capability, each replacement
 *  as Orca's own message words it (its panels and other contributions are not access). Undefined when any of it cannot
 *  be shown whole: a field of another shape, a line past a bound, more than ORCA_GRANTS_MAX lines, or none. Nothing is
 *  cut, so a person never approves access the window did not show. */
function grantLines(grants: unknown): string[] | undefined {
  if (!isObject(grants)) return undefined
  // Orca leaves `replacements` out when there are none.
  const { capabilities = [], replacements = [] } = grants
  if (!Array.isArray(capabilities) || !Array.isArray(replacements)) return undefined
  const texts: unknown[] = [
    grants.executionDescription,
    ...capabilities.map((capability) => isObject(capability) ? capability.description : undefined),
    ...replacements.map((replacement) => isObject(replacement) && typeof replacement.command === 'string' && typeof replacement.action === 'string'
      ? `Runs "${replacement.command}" instead of Orca's own ${replacement.action}`
      : undefined),
  ]
  const lines: string[] = []
  for (const text of texts) {
    const shown = line(text)
    if (shown === undefined) return undefined
    if (shown !== '') lines.push(shown)
  }
  return lines.length === 0 || lines.length > ORCA_GRANTS_MAX ? undefined : lines
}

/** The approve line from an approval's `data`; undefined when anything it passes on is off its pattern or bounds. */
function approval(data: unknown, update: boolean): OrcaConnect | undefined {
  if (!isObject(data)) return undefined
  const name = line(data.name)
  const version = line(data.version)
  const fingerprint = data.approvalFingerprint
  const grants = grantLines(data.grants)
  if (name === undefined || version === undefined || grants === undefined) return undefined
  if (typeof fingerprint !== 'string' || !ORCA_FINGERPRINT.test(fingerprint)) return undefined
  return { connect: 'approve', name, version, fingerprint, grants, update }
}

/** Installs, updates or enables the plugin, as its state in Orca asks. Without [approve], Orca answers with the access
 *  it would grant, or goes through when it asks for nothing new; [approve] is the fingerprint of the access a person
 *  was shown and accepted. It writes no record and logs nothing. */
export async function orcaConnect(deps: OrcaPluginDeps, approve?: string): Promise<OrcaConnect> {
  if (approve !== undefined && !ORCA_FINGERPRINT.test(approve)) return FAILED
  const found = await find(deps)
  if (found.state === 'absent') return { connect: 'failed', error: found.fromSources ? 'no-plugin' : 'not-running' }
  // A plugin the person removed or disabled after a connect stays so: no stale click installs it again.
  if (found.state === 'off') return { connect: 'failed', error: 'off' }
  if (found.state === 'current') return { connect: 'done' }
  // Orca updates a folder install from the folder it first copied. One from elsewhere (a person's checkout) is
  // installed from ours, which Orca counts as a moved source.
  const word = found.state === 'approve' ? ['enable', found.key]
    : found.state === 'behind' && found.ours ? ['update', found.key]
    : ['install', deps.folder]
  const args = ['plugin', ...word, ...(approve === undefined ? [] : ['--approve', approve]), '--json']
  const { code, stdout, timedOut } = await deps.run(found.orca, args, { timeoutMs: ORCA_CONNECT_MS, maxBytes: ORCA_ANSWER_MAX_BYTES })
  if (timedOut) return { connect: 'failed', error: 'timeout' }
  const answer = parse(stdout)
  if (code === 0 && answer?.ok === true) return { connect: 'done' }
  // Orca's message is never read: it can hold a path.
  const error = answer?.ok === false && isObject(answer.error) ? answer.error : undefined
  if (error?.code === 'approval_required' || error?.code === 'approval_stale') {
    // An update is whether Orca lists the plugin, so the app words the screen as one.
    return approval(error.data, found.state !== 'offer') ?? FAILED
  }
  return FAILED
}
