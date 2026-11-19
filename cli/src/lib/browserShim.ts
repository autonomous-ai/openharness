/**
 * The `BROWSER` of every harness's pane: a program there that opens a page (Claude Code's `/login`, `gh auth
 * login`) runs this script with the page's address. It asks the daemon that owns the pane first (`harness
 * open-url`): when the person is typing on a phone, the page opens on that phone (core/terminals/browser.ts).
 * Otherwise it opens here, in the browser the person had (`BROWSER` before Harness set it), else the system's.
 *
 * Checked by Claude Code 2.1: it runs `$BROWSER <url>` and, should that fail, prints the address to open by hand,
 * so a daemon that cannot be asked costs nothing a pane without this did not already have.
 */
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { env } from '../config/env.js'
import { atomicWriteFile } from './secureState.js'
import { shellSingleQuote } from './shellQuote.js'

/** Where the daemon writes the script: beside its data, which outlives a restart of either. */
export function browserShimPath(dataDir: string = env.ADAPTER_DATA_DIR): string {
  return join(dataDir, 'bin', 'harness-browser')
}

/** The script, for [command]: the daemon's CLI as an agent's shell runs it (lib/daemonCommand.ts). */
export function browserShimScript(command: string): string {
  return [
    '#!/bin/sh',
    '# Harness: opens a page a program in a harness pane asked for — on the phone typing there, else here.',
    '# Written by the Harness daemon (cli/src/lib/browserShim.ts); rewritten each time it starts.',
    '[ -n "$1" ] || exit 1',
    `${command} open-url "$1" >/dev/null 2>&1 && exit 0`,
    // The person's own browser command may carry arguments of its own, so it is not quoted. Never this script.
    'if [ -n "${HARNESS_PREVIOUS_BROWSER:-}" ] && [ "$HARNESS_PREVIOUS_BROWSER" != "$0" ]; then exec $HARNESS_PREVIOUS_BROWSER "$1"; fi',
    'if [ "$(uname -s)" = Darwin ]; then exec /usr/bin/open "$1"; fi',
    'exec xdg-open "$1"',
    '',
  ].join('\n')
}

/** Writes the script for [command] when it is missing or different. Never throws: a pane then keeps its browser. */
export function writeBrowserShim(command: string, path: string = browserShimPath()): boolean {
  const script = browserShimScript(command)
  try {
    let current = ''
    try { current = readFileSync(path, 'utf8') } catch { /* not written yet */ }
    if (current !== script) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      // Flushed: every pane's BROWSER runs it, and one a power cut emptied opens nothing.
      atomicWriteFile(path, script, 'cache', { mode: 0o700, durable: true })
    }
    chmodSync(path, 0o700)
    return true
  } catch {
    return false
  }
}

/**
 * The lines a pane's launch script runs: `BROWSER` is the script, when it is there, and the person's own is kept
 * for it to fall back on. A pane started before the daemon ever wrote it keeps its browser.
 */
export function browserPrelude(path: string = browserShimPath()): string {
  const quoted = shellSingleQuote(path)
  return `if [ -x ${quoted} ]; then if [ "\${BROWSER:-}" != ${quoted} ]; then HARNESS_PREVIOUS_BROWSER="\${BROWSER:-}"; export HARNESS_PREVIOUS_BROWSER; fi; BROWSER=${quoted}; export BROWSER; fi\n`
}
