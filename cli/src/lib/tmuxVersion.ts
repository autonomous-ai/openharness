/**
 * What this machine's tmux can do, for every feature newer than the oldest tmux Harness runs on.
 *
 * Harness runs on the tmux a distribution ships, and those are old: RHEL and Rocky 8 ship 2.7, Debian
 * 10 ships 2.8, Ubuntu 20.04 ships 3.0a, Debian 11 ships 3.1c. tmux checks a whole `;` command list
 * before it runs any of it, so one flag an older tmux does not know fails every command in the list:
 * the pane-owner tag (`set-option -p`, 3.0) chained into `new-session` made every agent create fail on
 * tmux 2.x (PR #789's review). And a flag it does not know in a one-off command is its usage text where
 * a result was expected — `new-session -e` once came back as `SPAWN_FAILED: usage: new-session ...`, a
 * dead end for anyone who did not already know the flag was new. So each feature is named here, with
 * the release that brought it, and every caller asks by name.
 */

import { execFile } from 'node:child_process'
import { patientExec } from './patientExec.js'

// A held event loop must not turn a timeout into a tmux that could not be asked (patientExec.ts).
const run = patientExec(execFile)

export interface TmuxVersion {
  major: number
  minor: number
}

/** The first release with each feature, from tmux's CHANGES; each measured against tmux 2.8 and 3.0a. */
export const TMUX_FEATURE_MIN = {
  /** `resize-window` (2.9). Before it a control client sizes its session with `refresh-client -C w,h`. */
  resizeWindow: { major: 2, minor: 9 },
  /** Pane options (3.0): `set-option -p`, and `window-style` and `remain-on-exit` kept per pane. */
  paneOptions: { major: 3, minor: 0 },
  /** `send-keys -H`, keys given as hex bytes (3.0). */
  sendKeysHex: { major: 3, minor: 0 },
  /** `respawn-pane -e` (3.0). */
  respawnEnv: { major: 3, minor: 0 },
  /** `capture-pane -N`, a row's trailing spaces kept (3.1). */
  captureTrailingSpaces: { major: 3, minor: 1 },
  /** Client flags (3.2): `attach-session -f ignore-size`. */
  clientFlags: { major: 3, minor: 2 },
  /** `new-session -e`, a session's own environment (3.2). */
  sessionEnv: { major: 3, minor: 2 },
} as const satisfies Record<string, TmuxVersion>

export type TmuxFeature = keyof typeof TMUX_FEATURE_MIN
export type TmuxFeatures = Readonly<Record<TmuxFeature, boolean>>

/** The first tmux that accepts `-e` on `new-session`. */
export const TMUX_SESSION_ENV_MIN = TMUX_FEATURE_MIN.sessionEnv

/**
 * `tmux 3.5a` / `tmux next-3.6` / `tmux openbsd-7.4` → the numeric part; `null` when there is none.
 *
 * `null` means "cannot tell", not "too old" — `tmux master` reports no number at all and is newer
 * than every release, so callers treat an unparsed version as capable and let tmux itself answer.
 */
export function parseTmuxVersion(output: string): TmuxVersion | null {
  const match = /(\d+)\.(\d+)/.exec(output)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]) }
}

/** Whether [version] is [min] or newer. Unknown is not old: see parseTmuxVersion. */
export function atLeast(version: TmuxVersion | null, min: TmuxVersion): boolean {
  if (!version) return true
  if (version.major !== min.major) return version.major > min.major
  return version.minor >= min.minor
}

export function supportsSessionEnv(version: TmuxVersion | null): boolean {
  return atLeast(version, TMUX_SESSION_ENV_MIN)
}

/** Every feature, answered for one version. */
export function tmuxFeaturesOf(version: TmuxVersion | null): TmuxFeatures {
  const features = {} as Record<TmuxFeature, boolean>
  for (const feature of Object.keys(TMUX_FEATURE_MIN) as TmuxFeature[]) {
    features[feature] = atLeast(version, TMUX_FEATURE_MIN[feature])
  }
  return features
}

let cached: Promise<TmuxVersion | null> | undefined

/**
 * This machine's tmux, probed once per process — tmux does not change under a running daemon (a new
 * tmux cannot even talk to the old server: it says "protocol version mismatch"), and this sits in front
 * of an interactive "create agent" click.
 *
 * Kept only once tmux has answered. A tmux that could not be asked (not on the daemon's PATH yet, a
 * timeout) reads as the newest for that one call, like a build that prints no number, and is asked
 * again at the next. Kept, one missed answer would stand for the life of the daemon, and on tmux 2.x
 * every agent create after it would chain a pane option and fail.
 */
export function tmuxVersion(): Promise<TmuxVersion | null> {
  if (cached) return cached
  const asked = new Promise<{ answered: boolean; version: TmuxVersion | null }>((resolve) => {
    run('tmux', ['-V'], { timeout: 2_000 }, (error, stdout) => {
      // A tmux that cannot be run at all is not this check's problem: the create path already
      // reports `TMUX_UNAVAILABLE` for it, and answering "too old" here would name the wrong cause.
      resolve({ answered: !error, version: error ? null : parseTmuxVersion(stdout) })
    })
  })
  const answer = asked.then(({ answered, version }) => {
    if (!answered && cached === answer) cached = undefined
    return version
  })
  cached = answer
  return answer
}

/** What this machine's tmux can do (see `TMUX_FEATURE_MIN`). */
export async function tmuxFeatures(): Promise<TmuxFeatures> {
  return tmuxFeaturesOf(await tmuxVersion())
}

/**
 * Can `TmuxBackend.create` be given an `env`? Probed once per process — tmux does not change under
 * a running daemon, and this sits in front of an interactive "create agent" click.
 */
export async function tmuxSupportsSessionEnv(): Promise<boolean> {
  return supportsSessionEnv(await tmuxVersion())
}

/** Test seam: forget the cached probe so a spec can install its own tmux. */
export function resetTmuxVersionCache(): void {
  cached = undefined
}

/** Test seam: answer as [version] without asking tmux (null: a tmux that prints no number). */
export function assumeTmuxVersion(version: TmuxVersion | null): void {
  cached = Promise.resolve(version)
}
