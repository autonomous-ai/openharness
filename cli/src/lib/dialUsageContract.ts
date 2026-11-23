/** The dial's usage counts: fixed names only, never an id, serial, account, title, path or text
 * (docs/plans/2026-11-23-dial-usage-counts-design.md). No import, so the backend's copy is the same bytes;
 * the core's process never loads it. */

/** ENGINES of engines/types.ts, then `other`. */
export const DIAL_USAGE_ENGINES = ['claude', 'codex', 'cursor', 'opencode', 'pi', 'omp', 'hermes',
  'commandcode', 'devin', 'muse', 'amp', 'kilo', 'grok', 'agy', 'copilot', 'openclaw', 'terminal', 'other'] as const
/** The dial's hosts (APP_IDS of cable/hosts/hostDetect.ts): `-` read as `_`, the unknown app (`terminal`) as `other`. */
export const DIAL_USAGE_HOSTS = ['harness', 'orca', 'herdr', 'rex', 'zellij', 'tmux', 'kitty', 'wezterm', 'iterm',
  'terminal_app', 'ghostty', 'cmux', 'vscode', 'cursor', 'warp', 'claude', 'codex', 'opencode', 'other'] as const
/** The apps behind the Other page, by product name only: a raw bundle id or TERM_PROGRAM stops at `unlisted`. */
export const DIAL_OTHER_APPS = ['zed', 'alacritty', 'hyper', 'tabby', 'jetbrains', 'rio', 'wave', 'nova', 'windsurf',
  'unlisted', 'unknown'] as const
/** How the dial shows a hooked agent, best first. */
export const DIAL_RECOGNITION = ['placed', 'held', 'other', 'not_shown'] as const
export const DIAL_VOICE_OUTCOMES = ['delivered', 'failed', 'held', 'cancelled'] as const
export const DIAL_VOICE_FAILURES = ['no_speech', 'transcribe_failed', 'route_failed', 'no_agent', 'window_busy',
  'refused', 'send_failed', 'no_turn', 'unlisted'] as const
export const DIAL_OPEN_FAILURES = ['not_opened', 'desktop_not_started', 'desktop_no_window', 'unknown_agent',
  'unlisted'] as const
export const DIAL_FIRST_AGENT_BUCKETS = ['under_1m', '1m_to_3m', '3m_to_10m', 'over_10m', 'none_1h'] as const
export const DIAL_WAIT_BUCKETS = ['under_30s', '30s_to_2m', '2m_to_10m', 'over_10m'] as const

export const DIAL_USAGE_FILE = 'dial-usage.json'
export const DIAL_USAGE_FILE_VERSION = 1
export const DIAL_USAGE_DAYS = 35
export const DIAL_USAGE_FILE_MAX_BYTES = 128 * 1024
export const DIAL_USAGE_MAX_COUNT = 100_000
export const DIAL_USAGE_AGENTS_MAX = 16
/** Decision 4: only the devices' upload sends it, so the backend counts the dial's voice apart. One fixed value, never
 * an id; anything else is the rest. */
export const DIAL_VOICE_SURFACE_HEADER = 'x-harness-voice-surface'
export const DIAL_VOICE_SURFACE = 'dial'

export type DialUsageEngine = typeof DIAL_USAGE_ENGINES[number]
export type DialUsageHost = typeof DIAL_USAGE_HOSTS[number]
export type DialOtherApp = typeof DIAL_OTHER_APPS[number]
export type DialRecognition = typeof DIAL_RECOGNITION[number]
export type DialVoiceFailure = typeof DIAL_VOICE_FAILURES[number]
export type DialOpenFailure = typeof DIAL_OPEN_FAILURES[number]

/** What the devices count; the gateway sends them as they come. */
export const DIAL_DEVICE_METRICS = [
  'dial_connected_installation_days', 'dial_used_installation_days', 'dial_first_use_installations',
  ...DIAL_FIRST_AGENT_BUCKETS.flatMap(b => [`dial_first_agent_first_${b}_installations`,
    `dial_first_agent_day_${b}_installations`] as const),
  ...DIAL_USAGE_ENGINES.flatMap(e => [`dial_engine_${e}_installation_days`, `dial_engine_${e}_agents`] as const),
  ...DIAL_USAGE_HOSTS.flatMap(h => [`dial_host_${h}_installation_days`, `dial_host_${h}_agents`] as const),
  ...DIAL_USAGE_ENGINES.flatMap(e => [`dial_hooked_${e}_installation_days`,
    ...DIAL_RECOGNITION.map(r => `dial_hooked_${e}_${r}` as const)] as const),
  ...DIAL_OTHER_APPS.flatMap(a => [`dial_other_app_${a}_installation_days`, `dial_other_app_${a}_agents`] as const),
  'dial_voice_installation_days',
  ...DIAL_VOICE_OUTCOMES.map(o => `dial_voice_${o}` as const),
  ...DIAL_VOICE_FAILURES.map(f => `dial_voice_failed_${f}` as const),
  ...DIAL_USAGE_HOSTS.flatMap(h => [`dial_voice_host_${h}_installation_days`,
    ...DIAL_VOICE_OUTCOMES.map(o => `dial_voice_host_${h}_${o}` as const)] as const),
  'dial_voice_redirected_30s', 'dial_voice_interrupted_10s',
  ...DIAL_USAGE_HOSTS.flatMap(h => [`dial_voice_host_${h}_redirected_30s`,
    `dial_voice_host_${h}_interrupted_10s`] as const),
  'dial_open_installation_days', 'dial_open_ok', 'dial_open_failed',
  ...DIAL_OPEN_FAILURES.map(f => `dial_open_failed_${f}` as const),
  ...DIAL_USAGE_HOSTS.flatMap(h => [`dial_open_host_${h}_installation_days`, `dial_open_host_${h}_ok`,
    `dial_open_host_${h}_failed`] as const),
] as const

/** In the file only, never sent: the gateway turns them into the used-day and unused-day waits as a day closes. */
export const DIAL_WAIT_RAW_METRICS = [
  ...DIAL_WAIT_BUCKETS.map(b => `dial_wait_dial_${b}` as const),
  ...DIAL_WAIT_BUCKETS.map(b => `dial_wait_elsewhere_${b}` as const),
  'dial_wait_none',
] as const

const RETURN_DAYS = [1, 7, 28] as const

/** What only the gateway knows, added as a day closes, never in the file. The period flags count distinct computers
 * over 7 and 28 days (Decision 3); first use needs none, as it fires once ever per computer. */
export const DIAL_DERIVED_METRICS = [
  'dial_connected_outside_app_installation_days', 'dial_used_outside_app_installation_days',
  'dial_first_use_outside_app_installations',
  ...RETURN_DAYS.flatMap(d => [`dial_d${d}_returning_installations`,
    `dial_d${d}_returning_outside_app_installations`] as const),
  'dial_used_week_installations', 'dial_used_28d_installations',
  'dial_used_outside_app_week_installations', 'dial_used_outside_app_28d_installations',
  'dial_wait_used_day_installation_days',
  ...DIAL_WAIT_BUCKETS.map(b => `dial_wait_used_day_dial_${b}` as const),
  ...DIAL_WAIT_BUCKETS.map(b => `dial_wait_used_day_elsewhere_${b}` as const),
  'dial_wait_used_day_none',
  'dial_wait_unused_day_installation_days',
  ...DIAL_WAIT_BUCKETS.map(b => `dial_wait_unused_day_elsewhere_${b}` as const),
  'dial_wait_unused_day_none',
  'dial_file_unreadable_installation_days',
] as const

export const DIAL_FILE_METRICS = [...DIAL_DEVICE_METRICS, ...DIAL_WAIT_RAW_METRICS] as const
/** What the backend takes. */
export const DIAL_USAGE_METRICS = [...DIAL_DEVICE_METRICS, ...DIAL_DERIVED_METRICS] as const
export type DialFileMetric = typeof DIAL_FILE_METRICS[number]
export type DialUsageMetric = typeof DIAL_USAGE_METRICS[number]

/** A flag is a computer count: at most 1 a computer a day, told by its name. */
export const DIAL_FLAG_METRICS: readonly (DialFileMetric | DialUsageMetric)[] =
  [...new Set([...DIAL_FILE_METRICS, ...DIAL_USAGE_METRICS])].filter(m => /_installation(s|_days)$/.test(m))
/** The flags that get the release and platform margins. */
export const DIAL_USAGE_MARGIN_METRICS = ['dial_connected_installation_days', 'dial_used_installation_days',
  'dial_used_outside_app_installation_days'] as const satisfies readonly DialUsageMetric[]

export interface DialUsageSink {
  /** Adds [n] (1) to [metric] on today's UTC day: a flag stays at 1, a count stops at DIAL_USAGE_MAX_COUNT. */
  add(metric: DialFileMetric, n?: number): void
  /** True the first time this computer ever reaches [mark]; kept in the file past its 35 days. */
  firstEver(mark: 'connected' | 'used'): boolean
}
export type DialVoiceEnd =
  | { outcome: 'sent'; agentId: string }
  | { outcome: 'failed'; code: DialVoiceFailure; agentId?: string }
  | { outcome: 'cancelled'; agentId?: string }
  | { outcome: 'other' } // a draft, a form field, a search: use, not voice to an agent
export type DialOpenEnd = { outcome: 'ok' } | { outcome: 'failed'; code: DialOpenFailure }
