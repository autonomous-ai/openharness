/**
 * Prime Agent's own list of its agents (`prime-agent list --json`), the one public source that ties a session
 * to an ATTACHED interactive client. Prime runs the agent in a daemon worker outside the pane, so the pane's
 * process tree proves nothing about which session it shows (engines/prime/contract.ts).
 *
 * Measured on prime-agent 0.9.5: ~120 ms; one row per agent with `id` (the agent id `prime-agent attach`
 * takes), `sessionId`, `sessionFile`, `cwd`, `rlmDepth`, `runtimeKind` (`top-level` | `subagent`), `lifecycle`
 * (`live` | …), `attachedClients`, `workerPid`, `isStreaming`. Client-owned workers (`-p`, JSON, RPC) are left
 * out of this default list (Prime's docs/daemon.md). The worker descriptors under `daemon-workers/` hold
 * authentication tokens and are never read.
 */
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { engineBin } from './engineBin.js'

export interface PrimeAgentRow {
  id: string
  sessionId: string
  sessionFile: string
  cwd: string
  rlmDepth: number
  runtimeKind: string
  lifecycle: string
  attachedClients: number
  isStreaming: boolean
}

type Runner = () => Promise<string>

const LIST_TIMEOUT_MS = 5_000
const CACHE_MS = 1_000

const defaultRunner: Runner = () => new Promise((resolve, reject) => {
  execFile(engineBin('prime'), ['list', '--json'], { timeout: LIST_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, cwd: '/' },
    (error, stdout) => error ? reject(error) : resolve(stdout))
})

let runner: Runner = defaultRunner
let cached: { at: number; rows: Promise<PrimeAgentRow[] | null> } | null = null

/** Tests replace the binary. */
export function setPrimeListRunner(next: Runner | null): void { runner = next ?? defaultRunner; cached = null }

function row(value: unknown): PrimeAgentRow | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const s = (key: string) => typeof v[key] === 'string' ? v[key] as string : ''
  if (!s('id') || !s('sessionId')) return null
  return {
    id: s('id'), sessionId: s('sessionId'), sessionFile: s('sessionFile'), cwd: s('cwd'),
    rlmDepth: typeof v.rlmDepth === 'number' ? v.rlmDepth : 0, runtimeKind: s('runtimeKind'), lifecycle: s('lifecycle'),
    attachedClients: typeof v.attachedClients === 'number' ? v.attachedClients : 0, isStreaming: v.isStreaming === true,
  }
}

export function parsePrimeList(stdout: string): PrimeAgentRow[] | null {
  try {
    const parsed = JSON.parse(stdout) as { sessions?: unknown }
    if (!Array.isArray(parsed?.sessions)) return null
    return parsed.sessions.map(row).filter((r): r is PrimeAgentRow => r !== null)
  } catch { return null }
}

/**
 * The agents, or null when Prime cannot be asked (not installed, daemon down, unreadable output). `fresh`
 * skips the short cache: a hook verified against a read from before its client attached was refused (measured).
 */
export function listPrimeAgents(options: { fresh?: boolean } = {}): Promise<PrimeAgentRow[] | null> {
  const now = Date.now()
  if (!options.fresh && cached && now - cached.at < CACHE_MS) return cached.rows
  const rows = runner().then(parsePrimeList, () => null)
  cached = { at: now, rows }
  return rows
}

/** A root conversation a person has open in a client right now: what a pane can show. */
export function isAttachedRoot(agent: PrimeAgentRow): boolean {
  return agent.lifecycle === 'live' && agent.rlmDepth === 0 && agent.runtimeKind === 'top-level' && agent.attachedClients > 0
}

/** Whether `sessionId` is an attached root conversation. False when Prime cannot be asked: no evidence. */
export async function primeSessionAttached(sessionId: string | undefined): Promise<boolean> {
  if (!sessionId) return false
  const rows = await listPrimeAgents({ fresh: true })
  return !!rows?.some((agent) => agent.sessionId === sessionId && isAttachedRoot(agent))
}

/** `prime-agent attach <agent>`: the agent id a client process names, if it names one. */
export function primeAttachTarget(args: string): string | null {
  const tokens = args.trim().split(/\s+/)
  const at = tokens.indexOf('attach')
  return at >= 0 && at + 1 < tokens.length && /^[0-9a-z][0-9a-z_-]{3,63}$/i.test(tokens[at + 1]) ? tokens[at + 1] : null
}

async function sameDir(a: string, b: string): Promise<boolean> {
  if (a === b) return true
  const [ra, rb] = await Promise.all([realpath(a).catch(() => a), realpath(b).catch(() => b)])
  return ra === rb
}

/**
 * The conversation a Prime client in `cwd` most likely shows: the agent its argv attaches to, else the only
 * attached root conversation in that folder. Two attached in one folder is not a tie to break: null, and the
 * extension's registration (which names the session) decides.
 */
export async function primeAttachedSession(cwd: string, args?: string): Promise<{ sessionId: string; transcriptPath: string } | null> {
  const rows = await listPrimeAgents()
  if (!rows) return null
  const target = args ? primeAttachTarget(args) : null
  if (target) {
    const agent = rows.find((r) => r.id === target && r.rlmDepth === 0)
    return agent?.sessionFile ? { sessionId: agent.sessionId, transcriptPath: agent.sessionFile } : null
  }
  const here: PrimeAgentRow[] = []
  for (const agent of rows) if (isAttachedRoot(agent) && agent.sessionFile && await sameDir(agent.cwd, cwd)) here.push(agent)
  return here.length === 1 ? { sessionId: here[0].sessionId, transcriptPath: here[0].sessionFile } : null
}
