/**
 * `harness device claude inbox <session id>`'s words and wiring: the follower (inbox.ts) on this process's data folder,
 * daemon port and stdout. A module of its own, importing only what the follower needs, so the bundle's entry (entry.ts)
 * starts it without the whole CLI: the follower runs as long as its Claude Code session, and on Windows it held about
 * 103 MB of working set evaluating all of cli.ts to poll one route. Measured from the release bundle on macOS, Node
 * 22.23.5, held in its retry wait 8 s after start (2026-11-27): 158 MB resident and a 48 MB heap through cli.ts, 143 MB
 * and 40 MB from here. What is left is the parse of the whole cli.js: the bundle's lightest branch, the retired shell
 * guard, holds 136 MB, and bare Node 39 MB, so a release also carries the follower as a file of its own, inbox.mjs
 * (inboxEntry.ts: 57 MB; docs/plans/2026-11-27-windows-follower-ram-design.md). runDeviceCommand (command.ts) runs it
 * from here too, for a run from the sources, which starts at cli.ts.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { env } from '../config/env.js'
import { readRemoved } from '../devices/dialSkillFiles.js'
import { daemonPort } from '../lib/daemonState.js'
import { CALLER_LIVENESS, createDaemonProof, followInbox } from './inbox.js'
import { claudePluginOn, claudeSettingsPath } from './plugin.js'

/** What the follower runs on: DeviceDeps' own, which command.ts hands on. */
export interface InboxCommandDeps {
  dataDir: string
  port: number
  platform: NodeJS.Platform
  /** One line and a newline on stdout, false once a write failed or stdout errored: the follower ends on it. */
  write(line: string): Promise<boolean>
}

/** The session [argv], the words after `device`, follows: '' for a missing id, which is answered as a refused one, off;
 *  null when the words are another command's. Words that start with `-` are dropped, as runDeviceCommand drops them. */
export function inboxSessionOf(argv: string[]): string | null {
  const words = argv.filter((arg) => !arg.startsWith('-'))
  return words.length <= 3 && words[0] === 'claude' && words[1] === 'inbox' ? words[2] ?? '' : null
}

export function runInbox(sessionId: string, deps: InboxCommandDeps): Promise<number> {
  return followInbox(sessionId, {
    dataDir: deps.dataDir, port: deps.port, platform: deps.platform, acts: () => pluginActs(deps.dataDir),
    proof: createDaemonProof(), write: deps.write,
    // The caller's end cuts the wait short: the abort is the only way it rejects.
    wait: (ms, signal) => sleep(ms, undefined, { signal }).catch(() => {}),
    pid: process.pid, ppid: process.ppid, liveness: CALLER_LIVENESS, now: Date.now,
  })
}

/** This process's own data folder, daemon port, platform and stdout, as cli.ts hands them to runDeviceCommand. */
export function processInboxDeps(): InboxCommandDeps {
  return { dataDir: env.ADAPTER_DATA_DIR, port: daemonPort(), platform: process.platform, write: writeStdoutLine }
}

/**
 * Whether the plugin's hook and mod act: its entry on in this command's Claude Code settings, and `disable` has not
 * removed Claude Code. The devices service installs the plugin into the daemon's Claude Code home, which may not be the
 * one a `disable` ran with: the plugin stays on there, and the removal alone keeps the dial off it.
 */
export function pluginActs(dataDir: string): boolean {
  return claudePluginOn(claudeSettingsPath()) && readRemoved(dataDir).claude !== true
}

/** [line] and a newline on stdout: false once the write failed or stdout errored, as when the reader closed its end. */
export function writeStdoutLine(line: string): Promise<boolean> {
  return new Promise((resolve) => {
    // A failed write's 'error' follows its callback, and unheard it would end the process with a trace on stderr:
    // the listener stays for it, and goes once a write succeeds.
    const failed = (): void => resolve(false)
    process.stdout.once('error', failed)
    process.stdout.write(`${line}\n`, (error) => {
      if (!error) process.stdout.off('error', failed)
      resolve(!error)
    })
  })
}
