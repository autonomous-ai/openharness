import { join } from 'node:path'
import { createAgentUsage } from './agentUsage.js'
import type { CorePorts } from '../core/api.js'
/**
 * This machine's Claude and Codex allowances, as the CLIs report them (`usage_read`): how the desktop reads an account
 * on a machine it does not run on, and what the router's `quotaOf` reads (superTabs/capacity.ts). Claude's comes from
 * the report its status line writes (lib/quotaReports.ts), Codex's from its app-server (lib/codexRateLimits.ts):
 * Harness never opens a Claude or ChatGPT sign-in to ask (#4137).
 *
 * The reply keeps the shape the vendors' answers had, which Desktop from the last 30 days parses with the same code as
 * its own reading (desktop/lib/usage/*_usage_source.dart, remote_usage.dart): `answered` with HTTP 200 and the vendor's
 * field names, so a window is named in one place. `source: 'cli'` is the only addition.
 */
import type { CoreApi, ServiceRequests } from '../core/api.js'
import { readCodexRateLimits, type CodexRateLimits, type CodexWindow } from '../lib/codexRateLimits.js'
import { accountKey, readClaudeReport, type ClaudeReport, type UsageProviderId } from '../lib/quotaReports.js'
import { profileHome } from '../lib/claudeProfiles.js'
import { internalOnThrow } from './requestErrors.js'

/** The request usage answers for the apps, declared in core/api.ts for the core to route. */
export { USAGE_REQUESTS } from '../core/api.js'

/**
 * One provider's allowance. `answered` carries a body in the vendor's own field names; `unreachable` says why in
 * `message` when this side knows. `account` is `accountKey(provider, id)`, or null when the CLI does not name it.
 */
export interface UsageReading {
  provider: UsageProviderId
  account: string | null
  outcome: 'answered' | 'signedOut' | 'unreachable'
  httpStatus?: number
  body?: unknown
  message?: string
  source: 'cli'
}

export interface UsageDeps {
  /** Codex's own read for a CODEX_HOME, or the daemon's own. Injected so a spec starts no real codex. */
  codex: (options: { codexHome?: string }) => Promise<CodexRateLimits>
  now: () => number
  /** The daemon's environment: its CLAUDE_CONFIG_DIR is the default Claude account's folder. */
  env: NodeJS.ProcessEnv
}

const DEPS: UsageDeps = { codex: readCodexRateLimits, now: Date.now, env: process.env }
/** How long one Codex read stands for its home: the router asks every 3 minutes, Desktop on connect. */
const CODEX_FRESH_MS = 3 * 60_000
const NO_CLAUDE_REPORT = 'Claude Code has not reported its allowance on this machine yet: it does after its first reply in a session Harness started.'
/** How long a Claude report stands: Claude Code writes one after each reply, and the account's own use elsewhere moves it
 *  unseen, so an older one is a guess, not a reading (task #4217). */
const CLAUDE_REPORT_FRESH_MS = 60 * 60_000
const STALE_CLAUDE_REPORT = 'Claude Code last reported its allowance on this machine more than an hour ago: it reports again after its next reply in a session Harness started.'
const RESET_SINCE_REPORT = 'Claude Code\'s allowance reset after its last report on this machine: it reports again after its next reply in a session Harness started.'
const CODEX_UNREACHABLE = {
  missing: 'Codex is not installed where this machine\'s daemon can start it.',
  failed: 'Codex did not answer when asked for its allowance on this machine.',
}

type Wanted = { engine?: UsageProviderId; home?: string }

/** One profile the machine knows (by the shared id rule, lib/claudeProfiles.ts profileHome): its engine, and its folder
 *  unless it is the default account. Null for none. */
function readerOf(core: CoreApi, engine: unknown, id: unknown): Wanted | null {
  if (typeof id !== 'string' || (engine !== 'claude' && engine !== 'codex')) return null
  const home = profileHome(engine, id, core.daemon.machineId())
  if (home === null) return null
  return home === 'default' ? { engine } : { engine, home }
}

export function startUsage(core: CoreApi, deps: UsageDeps = DEPS): ServiceRequests {
  const codexReads = new Map<string, { value: Promise<CodexRateLimits>; at: number }>()
  const codex = (home?: string): Promise<CodexRateLimits> => {
    const key = home ?? '', kept = codexReads.get(key), now = deps.now()
    if (kept && now - kept.at < CODEX_FRESH_MS) return kept.value
    const value = deps.codex({ codexHome: home })
    codexReads.set(key, { value, at: now })
    return value
  }
  return {
    // Codex's read starts its app-server (up to 10s, lib/codexRateLimits.ts). Answered when it settles, never in the
    // connection's line: it is asked on connect beside the requests the terminal needs.
    // With a profile it answers for that one account only, and only to the machine's owner: the default reading is
    // already open to guests, a second account's is not.
    usage_read: internalOnThrow('usage_read', (payload, asker) => {
      const wanted = (payload as { profile?: { engine?: unknown; id?: unknown } } | undefined)?.profile
      let only: Wanted = {}
      if (wanted) {
        if (!asker.owner) return { error: 'OWNER_REQUIRED' }
        const found = readerOf(core, wanted.engine, wanted.id)
        if (!found) return { error: 'PROFILE_UNKNOWN' }
        only = found
      }
      const home = (engine: UsageProviderId) => only.engine === engine ? only.home : undefined
      return Promise.all([
        ...(only.engine !== 'codex' ? [claudeReading(readClaudeReport(core.dataDir, home('claude') ?? deps.env.CLAUDE_CONFIG_DIR), deps.now())] : []),
        ...(only.engine !== 'claude' ? [codex(home('codex')).then(codexReading)] : []),
      ]).then(
        (providers) => ({ providers }),
        () => ({ error: 'USAGE_READ_FAILED' }),
      )
    }),
  }
}

/** Claude's report as Anthropic's usage answer was shaped (`utilization`, ISO `resets_at`). Only what it still knows: a report
 *  over [CLAUDE_REPORT_FRESH_MS] old is unknown, and so is a window whose reset has passed since, which says nothing of its use
 *  after the reset; never read as unused (task #4217). */
function claudeReading(report: ClaudeReport | null, now: number): UsageReading {
  const unknown = (message: string): UsageReading => ({ provider: 'claude', account: null, outcome: 'unreachable', source: 'cli', message })
  if (!report) return unknown(NO_CLAUDE_REPORT)
  if (now - report.at > CLAUDE_REPORT_FRESH_MS) return unknown(STALE_CLAUDE_REPORT)
  const body: Record<string, unknown> = {}
  for (const name of ['five_hour', 'seven_day'] as const) {
    const window = report[name]
    const resetsAt = window?.resets_at == null ? null : window.resets_at * 1000
    if (window && (resetsAt === null || resetsAt > now)) {
      body[name] = { utilization: window.used_percentage, resets_at: resetsAt === null ? null : new Date(resetsAt).toISOString() }
    }
  }
  if (!Object.keys(body).length) return unknown(RESET_SINCE_REPORT)
  return { provider: 'claude', account: null, outcome: 'answered', httpStatus: 200, source: 'cli', body }
}

/** Codex's read as its usage answer was shaped (`rate_limit.primary_window`, seconds-long windows, unix `reset_at`). */
function codexReading(read: CodexRateLimits): UsageReading {
  if (!read.ok) {
    return read.reason === 'signedOut'
      ? { provider: 'codex', account: null, outcome: 'signedOut', source: 'cli' }
      : { provider: 'codex', account: null, outcome: 'unreachable', source: 'cli', message: CODEX_UNREACHABLE[read.reason] }
  }
  const windows: Array<[string, CodexWindow | null]> = [['primary_window', read.primary], ['secondary_window', read.secondary]]
  const rate_limit = Object.fromEntries(windows.filter((entry): entry is [string, CodexWindow] => entry[1] !== null).map(([name, w]) => [name, {
    used_percent: w.usedPercent,
    limit_window_seconds: w.windowDurationMins === null ? null : w.windowDurationMins * 60,
    reset_at: w.resetsAt,
  }]))
  return { provider: 'codex', account: read.accountId ? accountKey('codex', read.accountId) : null, outcome: 'answered', httpStatus: 200, source: 'cli', body: { rate_limit } }
}

/** Explicit inline compatibility uses the same port and validators as the worker. */
export function startUsageInCore(core: CoreApi, ports: CorePorts): ServiceRequests {
  const reader = createAgentUsage(join(core.dataDir, 'agent-token-usage'))
  ports.usage = { read: target => reader.read({ target }), stop: reader.stop }
  return startUsage(core)
}
