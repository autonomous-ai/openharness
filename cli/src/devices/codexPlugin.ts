/**
 * Codex's harness-device plugin, set up in a Codex home through Codex's own `codex plugin` commands, from the marketplace
 * folder Harness writes for Claude Code from what cli.js carries (claudePlugin.ts): one folder serves both engines, as
 * Codex reads `.codex-plugin/` and Claude Code `.claude-plugin/`. Codex runs a plugin's hooks only once they are trusted,
 * so each install and update ends with the trust records (codexPluginTrust.ts), written only when the installed copy is
 * the one this CLI carries.
 *
 * A home whose `openharness` marketplace is the person's own (from GitHub, as the harness plugin's README tells Codex
 * users, or a clone) is theirs: Codex installs its plugins from there and refreshes them by itself, so Harness writes
 * nothing there and runs nothing after `--version`.
 */
import { realpathSync, statSync } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { parseVersion, versionAtLeast } from '../engines/kit/runtime.js'
import { agentCommandOwnershipSnapshotAsync, engineNearby, installedEngineBin } from '../lib/engineBin.js'
import { type ClaudeAnswer, type ClaudePluginFiles, type ClaudeRun, claudeRunner, failureReason, MARKETPLACE } from './claudePlugin.js'
import { filesContentHash, readConfigText, writePluginTrust } from './codexPluginTrust.js'
import { DIAL_PLUGIN_ID } from './dialSkill.js'
import { ensurePluginFolder } from './pluginFolder.js'

/** The first Codex whose plugin hooks and trust records the spike measured (codex-cli 0.172.0, 2026-11-26). */
export const MIN_CODEX = '0.172.0'
const MIN = parseVersion(MIN_CODEX)!

/** Which step failed: a fixed word the devices count, where Codex's own line could name a path. */
export type CodexStep = 'unsupported' | 'launcher' | 'config' | 'folder' | 'marketplace' | 'install' | 'trust' | 'remove'
/** [added]: the step failed after `plugin add` succeeded, so the home holds the plugin all the same. */
export type CodexFailure = { ok: false; step: CodexStep; error: string; reason?: string; added?: true }
/** What a setup did: installed or updated the plugin, [trusted] when its records were written; found it absent, as the
 *  person left it; or found the home's marketplace the person's own, and did nothing. */
export type CodexSetup = { ok: true; outcome: 'installed' | 'updated' | 'absent'; trusted: boolean } | { ok: true; outcome: 'own'; trusted: false } | CodexFailure
export type CodexResult = { ok: true } | CodexFailure

/** A Codex run; [bin]: the `codex` it runs, by which its `--version` is kept (supportedRun). */
export type CodexRun = ClaudeRun & { readonly bin?: string }
export interface CodexPluginDeps { run: CodexRun | null; home: string; platform: NodeJS.Platform }
/** [folder]: Harness's marketplace folder, by its absolute path; [files]: what cli.js carries for it. */
export interface CodexInstallDeps extends CodexPluginDeps { folder: string; files: ClaudePluginFiles }

const PLUGIN_NAME = DIAL_PLUGIN_ID.split('@')[0]
const PLUGIN_PREFIX = `plugins/${PLUGIN_NAME}/`
/** `plugin add` copies the plugin into Codex's cache. A local `marketplace add` copies nothing, it only records the
 *  folder in config.toml (marketplace_add.rs), yet keeps the copy's bound, which costs nothing when it answers; the
 *  version and a remove only read or write config.toml. */
const COPY_MS = 60_000
const LOCAL_MS = 15_000
const UNSUPPORTED: CodexFailure = { ok: false, step: 'unsupported', error: `Codex ${MIN_CODEX} or later is needed.` }
const LAUNCHER: CodexFailure = { ok: false, step: 'launcher', error: 'Harness cannot run this codex launcher.' }
const CONFIG: CodexFailure = { ok: false, step: 'config', error: "Harness could not read Codex's config.toml." }
const FOLDER_ERROR = "Harness could not write Codex's plugin folder."
const INSTALL_ERROR = 'Codex did not install the plugin where Harness looks.'
const TRUST_ERROR = "Harness could not trust the plugin's hooks."
const NO_ANSWER = 'Codex did not answer.'

/** Where Codex installs the plugin: its manifest carries no version, so Codex names the folder `local`. */
export function installedRoot(home: string): string {
  return join(home, 'plugins', 'cache', MARKETPLACE, PLUGIN_NAME, 'local')
}

/** The fingerprint Codex computes of the plugin once installed from [files], on [platform]. */
export function carriedCodexHash(files: ClaudePluginFiles, platform: NodeJS.Platform): string {
  const plugin = Object.entries(files.files).filter(([path]) => path.startsWith(PLUGIN_PREFIX))
  return filesContentHash(Object.fromEntries(plugin.map(([path, text]) => [path.slice(PLUGIN_PREFIX.length), text])), platform)
}

type Config = Record<string, unknown>
const table = (value: unknown): Config | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Config : undefined

/** [home]'s config.toml parsed; empty when there is none; 'unknown' when it cannot be read or parsed. */
function readConfig(home: string): Config | 'unknown' {
  try {
    const text = readConfigText(join(home, 'config.toml'))
    return text === null ? {} : parseToml(text, { integersAsBigInt: true, maxDepth: 64 }) as Config
  } catch {
    return 'unknown'
  }
}

/** [path]'s real path; for one not there yet (the folder before its first write), its nearest real parent's, joined. */
function realPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(realPath(parent), basename(path))
  }
}

/** Codex records a local marketplace by its canonical path, so [folder] is compared by its real path. */
function marketplaceIn(config: Config, folder: string): 'harness' | 'own' | 'none' {
  const marketplace = table(config.marketplaces)?.[MARKETPLACE]
  if (marketplace === undefined) return 'none'
  const { source_type: type, source } = table(marketplace) ?? {}
  return type === 'local' && typeof source === 'string' && realPath(source) === realPath(folder) ? 'harness' : 'own'
}

/** Codex takes a plugin's table with no `enabled` as on. */
function stateIn(config: Config): 'on' | 'off' | 'absent' {
  const plugin = table(config.plugins)?.[DIAL_PLUGIN_ID]
  if (plugin === undefined) return 'absent'
  return table(plugin)?.enabled === false ? 'off' : 'on'
}

/** Whose `openharness` marketplace [home] has: Harness's [folder], the person's own, none, or unknown when its
 *  config.toml cannot be read or parsed. */
export function codexMarketplace(home: string, folder: string): 'harness' | 'own' | 'none' | 'unknown' {
  const config = readConfig(home)
  return config === 'unknown' ? config : marketplaceIn(config, folder)
}

export function codexPluginState(home: string): 'on' | 'off' | 'absent' | 'unknown' {
  const config = readConfig(home)
  return config === 'unknown' ? config : stateIn(config)
}

/** codexMarketplace's and codexPluginState's answers from one parse of [home]'s config.toml, for a caller that needs
 *  both. */
export function codexHomeState(home: string, folder: string): { marketplace: 'harness' | 'own' | 'none'; plugin: 'on' | 'off' | 'absent' } | 'unknown' {
  const config = readConfig(home)
  return config === 'unknown' ? config : { marketplace: marketplaceIn(config, folder), plugin: stateIn(config) }
}

/** The Codex the daemon would run, pointed at [home]; its folder first on PATH, so an npm install's
 *  `#!/usr/bin/env node` finds the node beside it. [shell]: claudeFound's. */
export async function codexFound(home: string, shell: boolean): Promise<CodexRun | null> {
  let bin: string | null
  try {
    bin = shell && process.platform !== 'win32' ? installedEngineBin('codex', await agentCommandOwnershipSnapshotAsync()) : engineNearby('codex')
  } catch {
    return null
  }
  if (!bin) return null
  return codexRunner(bin, { ...process.env, CODEX_HOME: home, PATH: [dirname(bin), process.env.PATH].filter(Boolean).join(delimiter) })
}

/** Codex as claudeRunIn finds Claude Code, pointed at [home] on this child alone; null: no `codex`. */
export function codexRunIn(home: string): CodexRun | null {
  const bin = process.platform === 'win32' ? engineNearby('codex') : installedEngineBin('codex')
  return bin ? codexRunner(bin, { ...process.env, CODEX_HOME: home }) : null
}

const codexRunner = (bin: string, env: NodeJS.ProcessEnv): CodexRun => Object.assign(claudeRunner(bin, env), { bin })

/** `--version`'s answer by the binary's real path, for its modification time then. Asked for each home, a hanging Codex
 *  could hold one pass up to 16 minutes (64 homes × 15 s). The promise is kept, so two asks at once share one; once it
 *  answers, it is kept for keptFor. A few binaries at most, the oldest out first. */
const versions = new Map<string, { mtimeMs: number; answer: Promise<ClaudeAnswer>; until: number }>()
const MAX_VERSIONS = 8
/** The hour the plugin setup waits on a Codex too old (dialCodexPluginSetup.ts). */
const TOO_OLD_MS = 3_600_000

/** How long [answer] is kept: a supported version until the binary changes; one too old for the setup's hour, as a
 *  version manager's shim keeps its path and time across an upgrade; a failure, hang or refusal one bound, long enough
 *  for the rest of its pass, whose homes ask at once, and not for the next, as a first launch or a loaded machine can
 *  hang once. */
function keptFor(answer: ClaudeAnswer): number {
  if (answer.code !== 0 || !parseVersion(answer.stdout)) return LOCAL_MS
  return versionAtLeast(answer.stdout, MIN) ? Infinity : TOO_OLD_MS
}

/** [bin]'s real path and modification time; null for none, or one that cannot be read. */
function binaryNow(bin: string | undefined): { path: string; mtimeMs: number } | null {
  if (bin === undefined) return null
  try {
    const path = realpathSync(bin)
    return { path, mtimeMs: statSync(path).mtimeMs }
  } catch {
    return null
  }
}

/** [run]'s `--version`, asked once for its binary as it is now while its answer is kept; a run with no binary, or one
 *  that cannot be read, asks each time. */
function askVersion(run: CodexRun): Promise<ClaudeAnswer> {
  const binary = binaryNow(run.bin)
  if (!binary) return run(['--version'], LOCAL_MS)
  const { path, mtimeMs } = binary
  const kept = versions.get(path)
  if (kept?.mtimeMs === mtimeMs && Date.now() < kept.until) return kept.answer
  const entry = { mtimeMs, answer: run(['--version'], LOCAL_MS), until: Infinity }
  // Set before the caller reads the answer, as this reaction is the promise's first.
  void entry.answer.then((answer) => { entry.until = Date.now() + keptFor(answer) })
  versions.delete(path)
  versions.set(path, entry)
  if (versions.size > MAX_VERSIONS) versions.delete(versions.keys().next().value!)
  return entry.answer
}

/** [run] when its Codex is at least MIN_CODEX, asked with one `--version`: an older one is asked nothing more. A
 *  `--version` that fails or hangs is a broken install, not an older one, so it fails as the launcher, with why. */
async function supportedRun(run: CodexRun | null): Promise<ClaudeRun | CodexFailure> {
  if (!run) return UNSUPPORTED
  const answer = await askVersion(run)
  if (answer.refused) return LAUNCHER
  if (answer.code !== 0) return failure(answer, 'launcher')
  return versionAtLeast(answer.stdout, MIN) ? run : UNSUPPORTED
}

/** A call's failure: the first line Codex wrote about it, and why in a fixed word. */
function failure(answer: ClaudeAnswer, step: CodexStep): CodexFailure {
  return { ok: false, step, error: answer.stderr.split('\n').map((line) => line.trim()).find(Boolean) ?? NO_ANSWER, reason: failureReason(answer) }
}

/** A failure as the devices count it, as Claude Code's are (failureWords): `<step> · <reason>`, or the step alone when it
 *  has no reason. */
export function codexFailureWords({ step, reason }: Pick<CodexFailure, 'step' | 'reason'>): string {
  return reason ? `${step} · ${reason}` : step
}

async function change(run: ClaudeRun, args: string[], timeoutMs: number, step: CodexStep): Promise<CodexFailure | null> {
  const answer = await run(args, timeoutMs)
  return answer.code === 0 ? null : failure(answer, step)
}

/** Whether `plugin add --json` says it installed the plugin into [root]: compared by real path, as Codex may print the
 *  canonical one. */
function installedAt(stdout: string, root: string): boolean | 'not json' {
  let installed: unknown
  try {
    installed = table(JSON.parse(stdout))?.installedPath
  } catch {
    return 'not json'
  }
  try {
    return typeof installed === 'string' && realpathSync.native(installed) === realpathSync.native(root)
  } catch {
    return false
  }
}

/**
 * The plugin installed ([update] false) or brought to the carried copy ([update] true), then trusted. A setup installs
 * where the plugin is absent or on; an update only where it is on. One the person turned off is theirs. The marketplace
 * folder is added only to a home with no `openharness` marketplace; the plugin is added again over an installed one,
 * which Codex allows.
 */
async function bringCurrent(deps: CodexInstallDeps, update: boolean): Promise<CodexSetup> {
  const run = await supportedRun(deps.run)
  if (typeof run !== 'function') return run
  const config = readConfig(deps.home)
  if (config === 'unknown') return CONFIG
  const marketplace = marketplaceIn(config, deps.folder)
  if (marketplace === 'own') return { ok: true, outcome: 'own', trusted: false }
  const state = stateIn(config)
  if (state === 'off' || (update && state === 'absent')) return { ok: true, outcome: 'absent', trusted: false }
  const written = ensurePluginFolder(deps.folder, deps.files.files, deps.files.executable)
  if (typeof written === 'object') return { ok: false, step: 'folder', error: FOLDER_ERROR, reason: written.failed }
  if (marketplace === 'none') {
    // The absolute path: Codex records it canonical, which marketplaceIn compares by real path.
    const failed = await change(run, ['plugin', 'marketplace', 'add', deps.folder], COPY_MS, 'marketplace')
    if (failed) return failed
  }
  const added = await run(['plugin', 'add', DIAL_PLUGIN_ID, '--json'], COPY_MS)
  if (added.code !== 0) return failure(added, 'install')
  const root = installedRoot(deps.home)
  const at = installedAt(added.stdout, root)
  if (at !== true) return { ok: false, step: 'install', error: INSTALL_ERROR, reason: at || 'path', added: true }
  const outcome = update ? 'updated' : 'installed'
  const trust = writePluginTrust(deps.home, root, carriedCodexHash(deps.files, deps.platform))
  if (trust.ok) return { ok: true, outcome, trusted: true }
  // A copy that is not the carried one is left for Codex to ask the person about.
  if (trust.kind === 'differs') return { ok: true, outcome, trusted: false }
  return { ok: false, step: 'trust', error: TRUST_ERROR, reason: trust.kind, added: true }
}

export function codexSetUp(deps: CodexInstallDeps): Promise<CodexSetup> {
  return bringCurrent(deps, false)
}

export function codexUpdate(deps: CodexInstallDeps): Promise<CodexSetup> {
  return bringCurrent(deps, true)
}

/** Removes the plugin, on or off, and keeps the marketplace, which Claude Code's plugins come from too. One not in
 *  config.toml runs nothing. */
export async function codexRemove({ run, home }: CodexPluginDeps): Promise<CodexResult> {
  if (!run) return { ok: true }
  const config = readConfig(home)
  if (config === 'unknown') return CONFIG
  if (stateIn(config) === 'absent') return { ok: true }
  const supported = await supportedRun(run)
  if (typeof supported !== 'function') return supported
  return await change(supported, ['plugin', 'remove', DIAL_PLUGIN_ID], LOCAL_MS, 'remove') ?? { ok: true }
}
