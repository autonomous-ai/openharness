/**
 * `harness device claude status|enable|disable`: whether Claude Code has the harness-device plugin, and turning it on
 * or off, all through Claude Code's own `claude plugin` commands. Harness never writes Claude Code's settings itself.
 * This runs only in the `harness` command's own process (the menu-bar app calls it), never in the daemon.
 */
import { execFile } from 'node:child_process'
import { installedEngineBin } from '../lib/engineBin.js'

export const PLUGIN_ID = 'harness-device@openharness'
export const MARKETPLACE = 'openharness'
export const MIN_CLAUDE = '2.1.287'

export type ClaudeRun = (args: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>

export interface ClaudeDeps {
  run: ClaudeRun | null
  platform: NodeJS.Platform
}

export interface ClaudeStatus {
  supported: boolean
  installed: boolean
  enabled: boolean
  claudeVersion: string | null
}

export type ClaudeResult = { ok: true } | { ok: false; error: string }

/** The marketplace add and the install fetch the repository; every other call only reads or writes local settings. */
const FETCH_MS = 60_000
const LOCAL_MS = 15_000
/** `claude plugin list --json` grows with every installed plugin; past this the output is not ours to read. */
const MAX_OUTPUT_BYTES = 1024 * 1024
const UNSUPPORTED = `Claude Code ${MIN_CLAUDE} or later is needed.`
const NO_ANSWER = 'Claude Code did not answer.'

/** The Claude Code binary as Harness finds it for its own agents, run with no shell; null when it is not installed. */
export function claudeRun(): ClaudeRun | null {
  const bin = installedEngineBin('claude')
  if (!bin) return null
  return (args, timeoutMs) => new Promise((resolve) => {
    const child = execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        // A kill (the timeout), a missing file or output past the bound has no exit code: it is no answer.
        const code = !error ? 0 : typeof error.code === 'number' ? error.code : null
        resolve({ code, stdout, stderr })
      })
    // Nothing is asked on stdin: a `claude` that waits for it would only run out its time.
    child.stdin?.end()
  })
}

const VERSION = /(\d+)\.(\d+)\.(\d+)/

/** By number, part by part: 2.10.0 is after 2.9.0. */
function atLeast(version: string, min: string): boolean {
  const [a, b] = [VERSION.exec(version)!, VERSION.exec(min)!].map((match) => match.slice(1).map(Number))
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return true
}

async function jsonList(run: ClaudeRun, args: string[]): Promise<Record<string, unknown>[]> {
  const { code, stdout } = await run(args, LOCAL_MS)
  if (code !== 0) return []
  try {
    const value: unknown = JSON.parse(stdout)
    return Array.isArray(value) ? value.filter((entry) => !!entry && typeof entry === 'object') : []
  } catch {
    return []
  }
}

export async function claudeStatus({ run, platform }: ClaudeDeps): Promise<ClaudeStatus> {
  if (!run) return { supported: false, installed: false, enabled: false, claudeVersion: null }
  const version = await run(['--version'], LOCAL_MS)
  const claudeVersion = version.code === 0 ? VERSION.exec(version.stdout)?.[0] ?? null : null
  const supported = (platform === 'darwin' || platform === 'linux') && !!claudeVersion && atLeast(claudeVersion, MIN_CLAUDE)
  // A project-scope entry turns the plugin on for one repository only; the dial needs it in every session.
  const entry = (await jsonList(run, ['plugin', 'list', '--json']))
    .find((plugin) => plugin.id === PLUGIN_ID && plugin.scope === 'user')
  return { supported, installed: !!entry, enabled: entry?.enabled === true, claudeVersion }
}

/** Runs one call that changes something; a failure is the first line Claude Code wrote about it. */
async function change(run: ClaudeRun, args: string[], timeoutMs: number): Promise<ClaudeResult | null> {
  const { code, stderr } = await run(args, timeoutMs)
  if (code === 0) return null
  return { ok: false, error: stderr.split('\n').map((line) => line.trim()).find(Boolean) ?? NO_ANSWER }
}

export async function claudeEnable(deps: ClaudeDeps): Promise<ClaudeResult> {
  const status = await claudeStatus(deps)
  if (!status.supported || !deps.run) return { ok: false, error: UNSUPPORTED }
  const run = deps.run
  if (status.installed) {
    if (status.enabled) return { ok: true }
    return await change(run, ['plugin', 'enable', PLUGIN_ID, '--scope', 'user'], LOCAL_MS) ?? { ok: true }
  }
  const marketplaces = await jsonList(run, ['plugin', 'marketplace', 'list', '--json'])
  if (!marketplaces.some((marketplace) => marketplace.name === MARKETPLACE)) {
    // Only the two folders the plugin lives in: the rest of the repository is never cloned onto the person's computer.
    const failed = await change(run, ['plugin', 'marketplace', 'add', 'autonomous-ai/openharness', '--sparse', '.claude-plugin', 'plugins'], FETCH_MS)
    if (failed) return failed
  }
  return await change(run, ['plugin', 'install', PLUGIN_ID, '--scope', 'user'], FETCH_MS) ?? { ok: true }
}

/** Uninstalls the plugin and keeps the marketplace, which the harness plugin may come from too. */
export async function claudeDisable(deps: ClaudeDeps): Promise<ClaudeResult> {
  const status = await claudeStatus(deps)
  if (!status.installed || !deps.run) return { ok: true }
  return await change(deps.run, ['plugin', 'uninstall', PLUGIN_ID, '--scope', 'user'], LOCAL_MS) ?? { ok: true }
}
