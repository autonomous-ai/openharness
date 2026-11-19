/**
 * The name the person gave this computer, sent as a new machine's label.
 *
 * The hostname is not that name on a Mac: a reinstall after `~/.harness` was removed made a new machine named
 * `MacBook-Pro.local`, not as the person had named the Mac. macOS keeps the name the person chose
 * as its ComputerName, so that is asked first; elsewhere, or when macOS gives no name, the hostname is the name.
 *
 * Never loaded by the core's process: its own uses of the hostname are display only.
 */
import { execFile } from 'node:child_process'
import { hostname } from 'node:os'

export interface ComputerNameSources {
  platform: NodeJS.Platform
  /** `/usr/sbin/scutil --get ComputerName`'s stdout. Rejects on a failure or past its deadline. */
  scutil(): Promise<string>
  hostname(): string
}

// tmuxOnPath.ts learned 2 s is too short for a child process on a loaded Mac.
export const COMPUTER_NAME_DEADLINE_MS = 5_000
export const COMPUTER_NAME_MAX = 80

// eslint-disable-next-line no-control-regex -- control characters are what it removes
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g

/** This computer's own. */
export const SYSTEM_COMPUTER_NAME_SOURCES: ComputerNameSources = {
  platform: process.platform,
  // By its full path: a process started from a shell whose PATH lacks /usr/sbin still finds it.
  // Asynchronous: the gateway and the devices process carry other traffic while it runs. Its complaint is
  // captured, so it stays out of the terminal.
  scutil: () => new Promise((resolve, reject) => {
    execFile('/usr/sbin/scutil', ['--get', 'ComputerName'], {
      encoding: 'utf8',
      timeout: COMPUTER_NAME_DEADLINE_MS,
    }, (error, stdout) => { if (error) reject(error); else resolve(stdout) })
  }),
  hostname: () => hostname(),
}

/** At most COMPUTER_NAME_MAX UTF-16 units, as the backend counts, and never half of a surrogate pair. */
function cut(name: string): string {
  const pairSplit = /[\uD800-\uDBFF]/.test(name.charAt(COMPUTER_NAME_MAX - 1))
  return name.slice(0, pairSplit ? COMPUTER_NAME_MAX - 1 : COMPUTER_NAME_MAX)
}

async function readComputerName(sources: ComputerNameSources): Promise<string> {
  if (sources.platform === 'darwin') {
    try {
      const name = (await sources.scutil()).replace(CONTROL, '').trim()
      if (name) return cut(name)
    } catch { /* scutil failed or ran past its deadline: the hostname, below */ }
  }
  return cut(sources.hostname())
}

/** A reader that asks once and keeps its answer, whichever it was; asks made while it is out share it. */
export function computerNameReader(sources: ComputerNameSources): () => Promise<string> {
  let name: Promise<string> | undefined
  return () => (name ??= readComputerName(sources))
}

/** The name the person gave this computer: macOS's ComputerName, else the hostname. Asked once per process. */
export const computerName = computerNameReader(SYSTEM_COMPUTER_NAME_SOURCES)
