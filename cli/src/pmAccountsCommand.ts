/**
 * `harness pm accounts` — choose which Claude accounts this machine's Product Managers may move between, and sign a new one in,
 * from a terminal alone (a machine with no screen). The choices are the owner's requests to the daemon (superTabs/pmAccountsRequests.ts);
 * this file only asks, resolves names to ids, and prints. Adding an account runs `claude auth login` in a new folder under
 * `~/.harness/claude-profiles/`, the folder Desktop's "Add Claude account" makes, so both see the same accounts.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync as realSpawnSync } from 'node:child_process'
import type { ClaudeProfile, ClaudeProfileError } from './lib/claudeProfiles.js'

export interface PmAccountsDeps {
  argv: string[]
  home: string
  /** One request to this machine's daemon; rejects with an Error whose message says what went wrong. */
  request: (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>
  claudeBin: string
  /** The environment `claude` runs in. */
  env: NodeJS.ProcessEnv
  link: (folder: string) => { profile: ClaudeProfile } | ClaudeProfileError
  output: (line: string) => void
  error: (line: string) => void
  /** For a spec: the platform, and the process runner. */
  platform?: NodeJS.Platform
  spawn?: typeof realSpawnSync
}

interface Account {
  id: string
  label: string
  email?: string
  pmMayUse: boolean
  pmHere: string[]
  windows: Array<{ name: string; leftPercent: number; resetsAt?: string }>
}
interface Move { at: number; pm: string; from: string; to: string; why: string; awayMs?: number; ok: boolean }

const WHY: Record<string, string> = { low: 'under 5% left', out: 'at its limit', reset: 'back after a reset', fallback: 'a move undone' }
const clock = (at: number | string): string => {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return Number.isNaN(d.getTime()) ? String(at) : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map(r => r[c]!.length)))
  return rows.map(r => r.map((cell, c) => cell.padEnd(widths[c]!)).join('  ').trimEnd())
}

function left(a: Account, name: string): string {
  const w = a.windows.find(x => x.name === name)
  if (!w) return '-'
  const pct = `${Math.round(w.leftPercent)}%`
  return w.leftPercent < 5 && w.resetsAt ? `${pct} (back ${clock(w.resetsAt)})` : pct
}

async function list(deps: PmAccountsDeps): Promise<Account[]> {
  const reply = await deps.request('pm_accounts_list', {})
  return (reply.accounts ?? []) as Account[]
}

async function showList(deps: PmAccountsDeps): Promise<number> {
  const accounts = await list(deps)
  if (!accounts.length) { deps.output('No Claude accounts on this machine yet. Add one with `harness pm accounts add`.'); return 0 }
  const rows = [['Account', 'Email', '5-hour left', 'Week left', 'PM may use', 'PM here'],
    ...accounts.map(a => [a.label, a.email ?? '-', left(a, '5-hour'), left(a, 'weekly'), a.pmMayUse ? 'yes' : 'no', a.pmHere.join(', ') || '-'])]
  table(rows).forEach(deps.output)
  return 0
}

async function use(deps: PmAccountsDeps, names: string[], on: boolean): Promise<number> {
  if (!names.length) { deps.error('Name at least one account: harness pm accounts use [--off] <account>…'); return 1 }
  const accounts = await list(deps)
  const ids: string[] = []
  for (const name of names) {
    const lower = name.toLowerCase()
    const hit = accounts.find(a => a.id === name) ?? accounts.find(a => a.label.toLowerCase() === lower || a.email?.toLowerCase() === lower)
    if (!hit) {
      deps.error(`No account called "${name}". Known accounts: ${accounts.map(a => a.label).join(', ') || 'none'}.`)
      return 1
    }
    ids.push(hit.id)
  }
  await deps.request('pm_accounts_use', { ids, on })
  deps.output(`${on ? 'PM may now use' : 'PM may no longer use'} ${names.join(', ')}.`)
  return 0
}

async function history(deps: PmAccountsDeps, limit: number | undefined): Promise<number> {
  const reply = await deps.request('pm_accounts_history', limit ? { limit } : {})
  const moves = [...((reply.moves ?? []) as Move[])].sort((a, b) => b.at - a.at)
  if (!moves.length) { deps.output('No account moves yet.'); return 0 }
  // The moves hold account ids; the owner knows the accounts by name.
  const names = new Map((await list(deps)).map(a => [a.id, a.label]))
  const name = (id: string): string => names.get(id) ?? (id ? 'a removed account' : 'unknown')
  table([['Time', 'PM', 'Move', 'Why', 'Away', 'OK'],
    ...moves.map(m => [clock(m.at), m.pm, `${name(m.from)} → ${name(m.to)}`, WHY[m.why] ?? m.why, m.awayMs ? `${Math.round(m.awayMs / 1000)}s` : '-', m.ok ? 'yes' : 'no'])]).forEach(deps.output)
  return 0
}

/** Runs `claude` with fixed arguments only. A Windows `.cmd` or `.bat` cannot be started without a shell, so only then is one used, with the
 *  path quoted: the arguments are ours, and the folder travels in the environment, never in the command line. */
function run(deps: PmAccountsDeps, args: string[], folder: string): { status: number | null; signal: boolean; stdout: string } {
  const shell = (deps.platform ?? process.platform) === 'win32' && /\.(?:cmd|bat)$/i.test(deps.claudeBin)
  const r = (deps.spawn ?? realSpawnSync)(shell ? `"${deps.claudeBin}"` : deps.claudeBin, args,
    { env: { ...deps.env, CLAUDE_CONFIG_DIR: folder }, stdio: args[1] === 'login' ? 'inherit' : ['inherit', 'pipe', 'inherit'], encoding: 'utf8', shell })
  return { status: r.error ? null : r.status, signal: !!r.signal, stdout: typeof r.stdout === 'string' ? r.stdout : '' }
}

async function add(deps: PmAccountsDeps, tick: boolean): Promise<number> {
  const folder = join(deps.home, '.harness', 'claude-profiles', randomUUID())
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  // Ctrl-C reaches `claude` and this process alike; Node only runs a handler once the child has gone, so it marks the interruption.
  let interrupted = false
  const mark = (): void => { interrupted = true }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  for (const signal of signals) process.on(signal, mark)
  let signedIn = false
  const undo = (message: string): number => {
    // A sign-in that succeeded leaves a token behind: it is signed out before its folder goes.
    if (signedIn) run(deps, ['auth', 'logout'], folder)
    rmSync(folder, { recursive: true, force: true })
    deps.error(`${message} Nothing was added.`)
    return interrupted ? 130 : 1
  }
  try {
    deps.output('Signing in a new Claude account. Follow the link Claude prints.')
    const login = run(deps, ['auth', 'login'], folder)
    if (interrupted || login.signal) { interrupted = true; return undo('Cancelled.') }
    if (login.status !== 0) return undo('The Claude sign-in did not finish.')
    signedIn = true
    const status = run(deps, ['auth', 'status'], folder)
    if (interrupted || status.signal) { interrupted = true; return undo('Cancelled.') }
    if (status.status !== 0) return undo('Claude does not show this account as signed in.')
    const linked = deps.link(folder)
    if ('error' in linked) return undo(`Harness could not use the new folder (${linked.error}).`)
    deps.output(`Added ${linked.profile.label}.`)
    if (!tick) return 0
    await deps.request('pm_accounts_use', { ids: [linked.profile.id], on: true })
    deps.output('PM may use it now. Turn that off with `harness pm accounts use --off`.')
    return 0
  } finally { for (const signal of signals) process.off(signal, mark) }
}

export async function pmAccountsCommand(deps: PmAccountsDeps): Promise<number> {
  const [sub, ...rest] = deps.argv
  try {
    if (sub === undefined) return await showList(deps)
    if (sub === 'add') return await add(deps, !rest.includes('--no-use'))
    if (sub === 'use') return await use(deps, rest.filter(a => a !== '--off'), !rest.includes('--off'))
    if (sub === 'history') {
      const at = rest.indexOf('--limit')
      const limit = at >= 0 ? Number(rest[at + 1]) : undefined
      if (at >= 0 && !(Number.isInteger(limit) && limit! > 0)) { deps.error('--limit takes a whole number above 0.'); return 1 }
      return await history(deps, limit)
    }
    deps.error(`Unknown: harness pm accounts ${sub}. Use: add [--no-use] | use [--off] <account>… | history [--limit N]`)
    return 1
  } catch (failure) {
    deps.error(failure instanceof Error ? failure.message : String(failure))
    return 1
  }
}
