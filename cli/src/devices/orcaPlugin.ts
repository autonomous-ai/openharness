/**
 * What Harness Device's plugin for Orca (plugins/harness-device-orca) is in Orca, from Orca's own CLI: `orca status`,
 * `orca plugin inspect` and `orca plugin list`, each with `--json`; and its setup and removal there
 * (`orca plugin install|update|enable|uninstall`). Orca installs the plugin from a folder in Harness's data root that
 * holds the files cli.js carries (orcaPluginFolder.ts), written before Orca is asked about it; a folder that cannot be
 * written is said through `err` by its error's code. It runs in the `harness` command's process (`harness device orca`)
 * and in the devices' process (cable/orcaPluginSetup.ts), never in the core's. Orca's answers are outside text: each is
 * read up to ORCA_ANSWER_MAX_BYTES, only the fields named here are read, and nothing of them is logged
 * (docs/plans/2026-11-19-device-orca-default-on-design.md).
 */
import { realpathSync } from 'node:fs'
import { readOrcaConnected, readRemoved, readSetup } from './dialSkillFiles.js'
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
export type OrcaPluginState = 'on' | 'off' | 'held' | 'setup' | 'absent'

/** What a change asks Orca with: the `orca` to run, the plugin's key to name to Orca, and the version cli.js carries,
 *  to know a plugin Orca lists as the one asked for. */
interface Asking { orca: string; key: string; version: string }
/** Why Orca is not asked about the plugin: `none`, no Orca here (Windows, no `orca`); `no-plugin`, a CLI from the
 *  sources; `old`, an Orca below the plugin's engines; `folder`, the plugin's folder not written; `not-running`, an Orca
 *  not reachable, or an answer that cannot be read. */
interface Unasked { why: 'none' | 'no-plugin' | 'old' | 'folder' | 'not-running' }
/** The state, and what a change needs beside it: why it is `absent` (`other` for an entry that is the person's to mend:
 *  a development install, or one Orca could not load), what it asks Orca with in the states it asks Orca in, and
 *  whether the entry Orca lists was installed from the plugin's own folder. */
type Found =
  | { state: 'absent'; why: Unasked['why'] | 'other' }
  | { state: 'current' }
  | ({ state: 'offer' | 'off' | 'approve' | 'behind'; ours: boolean } & Asking)

const NOT_RUNNING: Found = { state: 'absent', why: 'not-running' }
const OTHER: Found = { state: 'absent', why: 'other' }
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

/** The orca-plugin.json cli.js carries. */
const manifestOf = (files: OrcaPluginFiles) => JSON.parse(files['orca-plugin.json']) as { version: string; engines: { orca: string } }

/** Orca asked up to the plugin's key, the folder written before Orca is asked about it. Orca is asked `status` first:
 *  every other plugin command waits about 30 seconds for an Orca that is not reachable. */
async function reach(deps: OrcaPluginDeps): Promise<Asking | Unasked> {
  if (deps.platform === 'win32') return { why: 'none' }
  const files = deps.files()
  if (files === null) return { why: 'no-plugin' }
  const orca = deps.orca()
  if (orca === null) return { why: 'none' }
  const carried = manifestOf(files)
  const runtime = (await ask(deps, orca, ['status', '--json'], ORCA_STATUS_MS))?.runtime
  if (!isObject(runtime) || runtime.reachable !== true || typeof runtime.appVersion !== 'string') return { why: 'not-running' }
  if (!meets(runtime.appVersion, carried.engines.orca)) return { why: 'old' }
  const written = ensureOrcaPluginFolder(deps.folder, files)
  if (typeof written === 'object') {
    // Not Orca's absence: the person would be told Orca is not running.
    deps.err(`orca plugin folder: ${written.failed}`)
    return { why: 'folder' }
  }
  const plugin = (await ask(deps, orca, ['plugin', 'inspect', deps.folder, '--json'], ORCA_READ_MS))?.plugin
  const key = isObject(plugin) ? plugin.pluginKey : undefined
  if (typeof key !== 'string' || !PLUGIN_KEY.test(key)) return { why: 'not-running' }
  return { orca, key, version: carried.version }
}

/** Whether the plugin was set up here before, by the devices (`dial-setup.json`'s `orca`) or by an `enable` or 0.1.9's
 *  connect (`orcaConnected`), so one the person removed since is not set up again; `orcaHeld` alone set nothing up.
 *  Undefined when a record cannot be read: that is not "never set up". */
function setUpBefore(dataDir: string): boolean | undefined {
  const setup = readSetup(dataDir)
  const connected = readOrcaConnected(dataDir)
  if (setup.orca !== undefined || connected.connected) return true
  return setup.unread || connected.unread ? undefined : false
}

/** The first rule that holds (the design's `status`). With [force] (`enable`), an earlier removal does not count and
 *  no record is read. */
async function find(deps: OrcaPluginDeps, force: boolean): Promise<Found> {
  const asking = await reach(deps)
  if ('why' in asking) return { state: 'absent', why: asking.why }
  const entry = await entryOf(deps, asking.orca, asking.key)
  if (entry === null) return NOT_RUNNING
  if (entry === undefined) {
    const before = force ? false : setUpBefore(deps.dataDir)
    if (before === undefined) return NOT_RUNNING
    return { state: before ? 'off' : 'offer', ours: false, ...asking }
  }
  const { version, status, source } = entry
  if (typeof version !== 'string' || typeof status !== 'string') return NOT_RUNNING
  if (entry.isDev === true) return OTHER
  const ours = fromFolder(source, deps.folder)
  if (status === 'disabled') return { state: 'off', ours, ...asking }
  if (status === 'pending' || entry.needsReconsent === true) return { state: 'approve', ours, ...asking }
  if (version !== asking.version || !ours) return { state: 'behind', ours, ...asking }
  if (status === 'errored' || status === 'invalid') return OTHER
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

/** The version in the orca-plugin.json cli.js carries; null in a run from the sources. */
export function carriedVersion(run: Pick<OrcaPluginRun, 'files'>): string | null {
  const files = run.files()
  return files === null ? null : manifestOf(files).version
}

/** What the plugin is for the person, the first that holds (PM, 2026-11-19): `off` once `harness device orca disable`
 *  removed it, with Orca asked nothing; `absent` with no Orca to ask, or an entry that is the person's to mend; `off`
 *  once the person removed it in Orca; `on`; `held` while the devices hold this version for asking more access than
 *  ORCA_APPROVED; else `setup`, which the devices do once a dial has attached here and Orca runs. */
export async function orcaStatus(deps: OrcaPluginDeps): Promise<{ orca: OrcaPluginState }> {
  if (readRemoved(deps.dataDir).orca === true) return { orca: 'off' }
  const found = await find(deps, false)
  if (found.state === 'absent' || found.state === 'off') return { orca: found.state }
  if (found.state === 'current') return { orca: 'on' }
  return { orca: readSetup(deps.dataDir).orcaHeld === found.version ? 'held' : 'setup' }
}

/** An approval fingerprint as Orca prints one, held to it where it comes in from Orca. */
const ORCA_FINGERPRINT = /^ap1-[0-9a-f]{32}$/

/** What Diego agreed Harness may approve for the person (2026-11-19): the access the plugin asks for as it ships, a
 *  contribution as `<kind>/<name>` in Orca's words. A change here is that decision, reviewed. */
export const ORCA_APPROVED: {
  readonly execution: 'trusted-worker'
  readonly capabilities: readonly string[]
  readonly contributions: readonly string[]
} = {
  execution: 'trusted-worker',
  capabilities: ['workspace:read'],
  contributions: ['panels/Harness Device', 'statusBarItems/Dial', 'events/workspace.changed'],
}

/** A list of an approval's `grants`: absent is none, as Orca leaves `replacements` out when there are none; undefined
 *  when it is no list. */
const grantList = (value: unknown): unknown[] | undefined => value === undefined ? [] : Array.isArray(value) ? value : undefined

/** Whether an approval's `data` asks for nothing beyond ORCA_APPROVED, for [key] at [version]. A field of another shape
 *  is not within it. */
export function withinApproved(data: unknown, key: string, version: string): boolean {
  if (!isObject(data) || data.pluginKey !== key || data.version !== version) return false
  const { grants } = data
  if (!isObject(grants) || grants.execution !== ORCA_APPROVED.execution) return false
  const capabilities = grantList(grants.capabilities)
  const contributions = grantList(grants.contributions)
  const replacements = grantList(grants.replacements)
  if (capabilities === undefined || contributions === undefined || replacements === undefined || replacements.length > 0) return false
  // Orca counts a capability by its whole object, so a field beside its kind and words (a scope) is access the pin
  // never agreed to.
  return capabilities.every((capability) => isObject(capability)
      && Object.keys(capability).every((field) => field === 'kind' || field === 'description')
      && typeof capability.kind === 'string' && ORCA_APPROVED.capabilities.includes(capability.kind))
    && contributions.every((contribution) => isObject(contribution)
      && typeof contribution.kind === 'string' && typeof contribution.name === 'string'
      && ORCA_APPROVED.contributions.includes(`${contribution.kind}/${contribution.name}`))
}

/** Each install, update, enable or uninstall. */
export const ORCA_CHANGE_MS = 60_000

/** Whether Orca lists the plugin as a change asked for it: at the version cli.js carries, from the plugin's folder,
 *  waiting on no approval and not disabled. */
async function finished(deps: OrcaPluginDeps, { orca, key, version }: Asking): Promise<boolean> {
  const entry = await entryOf(deps, orca, key)
  return isObject(entry) && entry.version === version && fromFolder(entry.source, deps.folder)
    && typeof entry.status === 'string' && entry.status !== 'pending' && entry.status !== 'disabled' && entry.needsReconsent !== true
}

/** Orca's answer to `plugin <args> --json` (an install, update, enable or uninstall): `ok`, its deadline passed, the
 *  `data` of a refusal for want of an approval, or `failed` for anything else. Orca's message is never read: it can
 *  hold a path. */
async function change(deps: OrcaPluginDeps, orca: string, args: string[]): Promise<'ok' | 'timeout' | 'failed' | { refused: unknown }> {
  const { code, stdout, timedOut } = await deps.run(orca, ['plugin', ...args, '--json'], { timeoutMs: ORCA_CHANGE_MS, maxBytes: ORCA_ANSWER_MAX_BYTES })
  if (timedOut) return 'timeout'
  const answer = parse(stdout)
  if (code === 0 && answer?.ok === true) return 'ok'
  const error = answer?.ok === false && isObject(answer.error) ? answer.error : undefined
  return error?.code === 'approval_required' || error?.code === 'approval_stale' ? { refused: error.data } : 'failed'
}

export type OrcaSetUp =
  | { orca: 'on'; did?: 'set up' | 'updated' }
  | { orca: 'held' }
  | { orca: 'off' }
  | { orca: 'absent'; error: 'not-running' | 'old' | 'other' }
  | { orca: 'failed'; error: 'timeout' | 'failed' | 'folder' }

const SETUP_FAILED: OrcaSetUp = { orca: 'failed', error: 'failed' }

/** Sets the plugin up in Orca, or brings it current, as its state there asks; [force] (`enable`) also brings back one
 *  the person removed. `did` says what ran: none when it was current. Orca refuses a plugin that runs code without its
 *  approval's fingerprint; Harness passes it only for a refusal within ORCA_APPROVED, and only once: Diego agreed to
 *  that access for the person, and anything more is held for his decision. It writes no record and says nothing but
 *  the folder's code. */
export async function orcaSetUp(deps: OrcaPluginDeps, { force }: { force: boolean }): Promise<OrcaSetUp> {
  const found = await find(deps, force)
  if (found.state === 'absent') {
    if (found.why === 'folder') return { orca: 'failed', error: 'folder' }
    return { orca: 'absent', error: found.why === 'old' || found.why === 'other' ? found.why : 'not-running' }
  }
  if (found.state === 'current') return { orca: 'on' }
  if (found.state === 'off' && !force) return { orca: 'off' }
  // Harness enables or updates only an entry it installed from its own folder, never code put elsewhere, such as a
  // pending install from a person's checkout: that one is installed from the folder, which Orca counts as a moved source.
  const word = !found.ours ? ['install', deps.folder] : found.state === 'behind' ? ['update', found.key] : ['enable', found.key]
  const on: OrcaSetUp = { orca: 'on', did: found.state === 'offer' ? 'set up' : 'updated' }
  let answer = await change(deps, found.orca, word)
  if (typeof answer === 'object') {
    if (!withinApproved(answer.refused, found.key, found.version)) return { orca: 'held' }
    const { approvalFingerprint } = answer.refused as { approvalFingerprint?: unknown }
    // An answer Harness cannot read, not access it would hold: tried again later.
    if (typeof approvalFingerprint !== 'string' || !ORCA_FINGERPRINT.test(approvalFingerprint)) return SETUP_FAILED
    answer = await change(deps, found.orca, [...word, '--approve', approvalFingerprint])
    // A second refusal (the plugin changed in between) is never answered by a third run.
    if (typeof answer === 'object') return SETUP_FAILED
  }
  // Orca may finish what it was asked after the deadline.
  if (answer === 'timeout') return await finished(deps, found) ? on : { orca: 'failed', error: 'timeout' }
  return answer === 'ok' ? on : SETUP_FAILED
}

export type OrcaRemove = { orca: 'off' } | { orca: 'off'; error: 'not-running' | 'timeout' | 'failed' }

const OFF: OrcaRemove = { orca: 'off' }

/** Uninstalls the plugin from Orca, whichever folder Orca holds it from. With no Orca that could hold it (none here,
 *  a CLI from the sources, an Orca below its engines) there is nothing to uninstall. It writes no record and says
 *  nothing but the folder's code: the folder is written for Orca to name the plugin's key. */
export async function orcaRemove(deps: OrcaPluginDeps): Promise<OrcaRemove> {
  const asking = await reach(deps)
  if ('why' in asking) {
    if (asking.why === 'not-running') return { orca: 'off', error: 'not-running' }
    return asking.why === 'folder' ? { orca: 'off', error: 'failed' } : OFF
  }
  const entry = await entryOf(deps, asking.orca, asking.key)
  if (entry === null) return { orca: 'off', error: 'not-running' }
  if (entry === undefined) return OFF
  const answer = await change(deps, asking.orca, ['uninstall', asking.key])
  return answer === 'ok' ? OFF : { orca: 'off', error: answer === 'timeout' ? 'timeout' : 'failed' }
}
