/**
 * What Harness Device's plugin for Orca (plugins/harness-device-orca) is in Orca, from Orca's own CLI: `orca status`,
 * `orca plugin inspect` and `orca plugin list`, each with `--json`; and the connect that installs, updates or enables
 * it (`orca plugin install|update|enable`). Orca installs the plugin from a folder in Harness's data root that holds the
 * files cli.js carries (orcaPluginFolder.ts), written before Orca is asked about it; a folder that cannot be written is
 * said on stderr by its error's code. It runs in the `harness` command's own process (`harness device orca`), never in
 * the core's or the devices' process. Orca's answers are outside text: each is read up to ORCA_ANSWER_MAX_BYTES, only
 * the fields named here are read, and nothing of them is logged (docs/plans/2026-11-18-connect-orca-design.md).
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
export interface OrcaPluginDeps extends OrcaPluginRun { folder: string; dataDir: string; err(line: string): void }
export type OrcaPluginState = 'absent' | 'offer' | 'off' | 'approve' | 'behind' | 'current'

/** What a connect asks Orca with: the `orca` to run, the plugin's key to name to Orca, and the version cli.js carries,
 *  to know a plugin Orca lists as the one asked for. */
interface Asking { orca: string; key: string; version: string }
/** The state, and what a connect needs beside it: its error for an `absent` that is not `not-running` (a CLI from the
 *  sources, a folder that cannot be written), what it asks Orca with in the states it asks Orca in, and whether a plugin
 *  `behind` was installed from the plugin's own folder. */
type Found =
  | { state: 'absent'; error?: 'no-plugin' | 'failed' }
  | { state: 'off' }
  | { state: 'current' }
  | ({ state: 'offer' } & Asking)
  | ({ state: 'approve' } & Asking)
  | ({ state: 'behind'; ours: boolean } & Asking)

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

/** A path by its real path, or as written when it does not resolve. */
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

/** The plugin's entry in Orca's `plugin list`: undefined when Orca lists none, null when the list cannot be read. */
async function entryOf(deps: OrcaPluginDeps, orca: string, key: string): Promise<Record<string, unknown> | undefined | null> {
  const plugins = (await ask(deps, orca, ['plugin', 'list', '--json'], ORCA_READ_MS))?.plugins
  if (!Array.isArray(plugins)) return null
  return plugins.find((listed): listed is Record<string, unknown> => isObject(listed) && listed.pluginKey === key)
}

/** Whether an entry's `source` is the plugin's folder as Orca counts it: Orca records the real path of the folder it
 *  was handed and updates from that path, so any other path is another folder, even one that leads to it through a link
 *  (its place before Harness's files moved on Linux, now the bridge's link). Such an entry is installed from the folder
 *  itself, which Orca asks the person to approve, so Orca's record follows the move and never reads the link. */
const fromFolder = (source: unknown, folder: string): boolean =>
  isObject(source) && source.kind === 'local-path' && source.reference === real(folder)

/** The first rule that holds (the design's `status`). Orca is asked `status` first: every other plugin command waits
 *  about 30 seconds for an Orca that is not reachable. */
async function find(deps: OrcaPluginDeps): Promise<Found> {
  if (deps.platform === 'win32') return ABSENT
  const files = deps.files()
  if (files === null) return { state: 'absent', error: 'no-plugin' }
  const orca = deps.orca()
  if (orca === null) return ABSENT
  const carried = JSON.parse(files['orca-plugin.json']) as { version: string; engines: { orca: string } }
  const runtime = (await ask(deps, orca, ['status', '--json'], ORCA_STATUS_MS))?.runtime
  if (!isObject(runtime) || runtime.reachable !== true || typeof runtime.appVersion !== 'string') return ABSENT
  if (!meets(runtime.appVersion, carried.engines.orca)) return ABSENT
  const written = ensureOrcaPluginFolder(deps.folder, files)
  if (typeof written === 'object') {
    // Not Orca's absence: a connect would tell the person Orca is not running.
    deps.err(`orca plugin folder: ${written.failed}`)
    return { state: 'absent', error: 'failed' }
  }
  const plugin = (await ask(deps, orca, ['plugin', 'inspect', deps.folder, '--json'], ORCA_READ_MS))?.plugin
  const key = isObject(plugin) ? plugin.pluginKey : undefined
  if (typeof key !== 'string' || !PLUGIN_KEY.test(key)) return ABSENT
  const entry = await entryOf(deps, orca, key)
  if (entry === null) return ABSENT
  const asking: Asking = { orca, key, version: carried.version }
  if (entry === undefined) {
    // A record that cannot be read is not "never connected": that would offer the plugin again to a person who
    // removed it.
    const record = readOrcaConnected(deps.dataDir)
    if (record.unread) return ABSENT
    return record.connected ? { state: 'off' } : { state: 'offer', ...asking }
  }
  const { version, status, source } = entry
  if (typeof version !== 'string' || typeof status !== 'string' || entry.isDev === true) return ABSENT
  if (status === 'disabled') return { state: 'off' }
  if (status === 'pending' || entry.needsReconsent === true) return { state: 'approve', ...asking }
  const ours = fromFolder(source, deps.folder)
  if (version !== carried.version || !ours) return { state: 'behind', ours, ...asking }
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
/** With `status`, `inspect`, `list` and the `list` after a deadline passed, 95 s: within the app's 120 s for a connect. */
export const ORCA_CONNECT_MS = 60_000
export const ORCA_GRANTS_MAX = 10
export const ORCA_GRANT_MAX_CHARS = 300
export type OrcaConnectError = 'not-running' | 'no-plugin' | 'off' | 'timeout' | 'failed'
export type OrcaConnect =
  | { connect: 'done' }
  | { connect: 'approve'; name: string; version: string; fingerprint: string; grants: string[]; update: boolean }
  | { connect: 'failed'; error: OrcaConnectError }

const FAILED: OrcaConnect = { connect: 'failed', error: 'failed' }
/** What a line cannot show as written: control characters (line breaks and tabs among them), format characters (bidi
 *  overrides and isolates, zero-width ones) that make a line read other than it is, Unicode's line and paragraph
 *  separators (WebKit breaks a line on them), and a lone surrogate (`Cs` matches only an unpaired one), which is not
 *  text the app can read. The app holds a grant to the same set (`UNSHOWN` in orca_cli.rs). */
const UNSHOWN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u

/** [text] as one line of an approval, trimmed; undefined when it is no string, holds an UNSHOWN character or is longer
 *  than ORCA_GRANT_MAX_CHARS. Characters are code points, as the app counts them (Rust's `chars()`), so a line this
 *  passes the app passes too. */
function line(text: unknown): string | undefined {
  if (typeof text !== 'string' || UNSHOWN.test(text)) return undefined
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

/** Whether Orca lists the plugin as a connect asked for it: at the version cli.js carries, from the plugin's folder,
 *  and waiting on no approval. */
async function finished(deps: OrcaPluginDeps, { orca, key, version }: Asking): Promise<boolean> {
  const entry = await entryOf(deps, orca, key)
  return isObject(entry) && entry.version === version && fromFolder(entry.source, deps.folder)
    && typeof entry.status === 'string' && entry.status !== 'pending' && entry.needsReconsent !== true
}

/** Installs, updates or enables the plugin, as its state in Orca asks. Without [approve], Orca answers with the access
 *  it would grant, or goes through when it asks for nothing new; [approve] is the fingerprint of the access a person
 *  was shown and accepted. It writes no record and logs nothing. */
export async function orcaConnect(deps: OrcaPluginDeps, approve?: string): Promise<OrcaConnect> {
  if (approve !== undefined && !ORCA_FINGERPRINT.test(approve)) return FAILED
  const found = await find(deps)
  if (found.state === 'absent') return { connect: 'failed', error: found.error ?? 'not-running' }
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
  // Orca may finish what it was asked after the deadline: `done` then, so the command records the connect.
  if (timedOut) return await finished(deps, found) ? { connect: 'done' } : { connect: 'failed', error: 'timeout' }
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
