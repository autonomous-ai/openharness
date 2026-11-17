/**
 * The name the person gave this computer, sent as a new machine's label.
 *
 * The hostname is not that name on a Mac: a reinstall after `~/.harness` was removed made a new machine named
 * `MacBook-Pro.local`, not as the person had named the Mac. macOS keeps the name the person chose
 * as its ComputerName, so that is asked first; elsewhere, or when macOS gives no name, the hostname is the name.
 *
 * Never loaded by the core's process: its own uses of the hostname are display only.
 */
import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'

export interface ComputerNameSources {
  platform: NodeJS.Platform
  /** `/usr/sbin/scutil --get ComputerName`'s stdout. Throws on a failure or past its deadline. */
  scutil(): string
  hostname(): string
}

export const COMPUTER_NAME_DEADLINE_MS = 2_000
export const COMPUTER_NAME_MAX = 80

// eslint-disable-next-line no-control-regex -- control characters are what it removes
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g

/** This computer's own. */
export const SYSTEM_COMPUTER_NAME_SOURCES: ComputerNameSources = {
  platform: process.platform,
  // By its full path: a process started from a shell whose PATH lacks /usr/sbin still finds it.
  // Its complaint stays out of the terminal, as `lib/bootId.ts`'s sysctl's does.
  scutil: () => execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], {
    encoding: 'utf8',
    timeout: COMPUTER_NAME_DEADLINE_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  }),
  hostname: () => hostname(),
}

function readComputerName(sources: ComputerNameSources): string {
  if (sources.platform === 'darwin') {
    try {
      // By code point, so a character outside the BMP is never split into a lone surrogate.
      const name = Array.from(sources.scutil().replace(CONTROL, '').trim()).slice(0, COMPUTER_NAME_MAX).join('')
      if (name) return name
    } catch { /* scutil failed or ran past its deadline: the hostname, below */ }
  }
  return sources.hostname()
}

/** A reader that asks once and keeps its answer, whichever it was. */
export function computerNameReader(sources: ComputerNameSources): () => string {
  let name: string | undefined
  return () => (name ??= readComputerName(sources))
}

/** The name the person gave this computer: macOS's ComputerName, else the hostname. Asked once per process. */
export const computerName = computerNameReader(SYSTEM_COMPUTER_NAME_SOURCES)
