/**
 * The owner's side of a guest host (docs/superpowers/specs/2026-11-05-windows-guests-design.md): point the existing
 * `PtyHostBackend` at the guest's host home, start `\Harness\Guests\<user>` (the task the setup task registered), and
 * reuse the exact pane backend the owner uses. No second pane implementation and no engine launched as the owner.
 *
 * The signed pty writes its discovery token and pipe with the owner's SID too (`HARNESS_PTY_SHARE_SID`, set by the guest
 * host task), so this process can read the token and connect. The host and every pane it makes run as the guest.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runGuestCommand, type GuestRunner } from '../guestAccounts.js'
import { PtyHostBackend } from '../ptyHostBackend.js'
import { reachPtyHost, readInstanceDiscovery } from '../ptyHost/launch.js'
import type { PtyHostDiscovery } from '../ptyHost/client.js'

export const guestHostHome = (user: string): string => `C:\\ProgramData\\HarnessGuests\\hosts\\${user}`
export const guestHostTask = (user: string): string => `\\Harness\\Guests\\${user}`

export interface GuestHostBackendOptions {
  user: string
  home?: string
  /** Starts the guest host task; a seam for tests. */
  startTask?: (task: string) => Promise<void>
  waitMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** The files in the host home's `run` folder; a seam for tests. */
  list?: (directory: string) => string[]
  runner?: GuestRunner
}

const DISCOVERY = /^pty-host-(.+)\.json$/

/** The newest discovery file the guest host published, or null within the window. */
export async function waitForGuestHost(home: string, options: GuestHostBackendOptions): Promise<PtyHostDiscovery | null> {
  const waitMs = options.waitMs ?? 15_000
  const pollMs = options.pollMs ?? 250
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const list = options.list ?? ((directory: string) => {
    try { return readdirSync(directory) } catch { return [] }
  })
  const deadline = now() + waitMs
  for (;;) {
    const found: PtyHostDiscovery[] = []
    for (const name of list(join(home, 'run'))) {
      const match = DISCOVERY.exec(name)
      if (!match) continue
      const discovery = readInstanceDiscovery(home, match[1]!)
      if (discovery) found.push(discovery)
    }
    if (found.length) {
      found.sort((a, b) => a.protocol - b.protocol || a.version.localeCompare(b.version) || a.instance.localeCompare(b.instance))
      return found.at(-1)!
    }
    if (now() >= deadline) return null
    await sleep(pollMs)
  }
}

/** A pty backend whose host home is the guest's and whose start is the guest's task, not a process this account spawns. */
export function createGuestHostBackend(options: GuestHostBackendOptions): PtyHostBackend {
  const home = options.home ?? guestHostHome(options.user)
  const startTask = options.startTask ?? (async (task: string) => {
    const result = await (options.runner ?? runGuestCommand)('schtasks.exe', ['/run', '/tn', task], { timeoutMs: 30_000 })
    if (result.code !== 0) throw new Error(result.stderr.trim() || `could not start ${task} (schtasks ${result.code})`)
  })
  return new PtyHostBackend({
    home,
    platform: 'win32',
    target: null,
    launch: async (hostHome: string) => {
      await startTask(guestHostTask(options.user))
      const discovery = await waitForGuestHost(hostHome, options)
      if (!discovery) return { incompatible: 'the guest host did not publish a discovery file' }
      return reachPtyHost(hostHome, discovery.instance)
    },
  })
}
