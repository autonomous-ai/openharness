/**
 * A Codex whose rate-limit read never ends, for the tests of what a daemon's close and the worker's reaper end.
 *
 * Why a hung one: the fake's own `codex app-server` ends with its stdin (fakeEngine.mjs), so it ends with its daemon. Only
 * a Codex that does not end shows what the close must do. The read runs `codex app-server` in a process group of its own
 * (lib/codexRateLimits.ts), out of reach of the daemon's groups: 14 such pairs outlived their runs on one Mac (the census
 * of 2026-11-14).
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { processTable, type ProcessRow } from '../../src/testing/spawnedRuns.js'
import { LocalClient } from './client.js'
import { fakeEngineShim, until, type IsolatedDaemon } from './daemon.js'

/** `codex app-server`, not its `proxy`: never ends, nor does its child, which names nothing of the root as the npm
 *  wrapper's child does. The shim runs as CommonJS, so its `return` ends it before the fake engine is loaded. */
const HANG = `if (process.argv[2] === 'app-server' && process.argv[3] !== 'proxy') {
  require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })
  setInterval(() => {}, 1 << 30)
  return
}`

/** Writes the hung Codex over [daemon]'s own, before the daemon starts. */
export function writeHungCodex(daemon: IsolatedDaemon): void {
  const [shebang, ...engine] = fakeEngineShim('codex', { ...daemon.engineConfig }).split('\n')
  writeFileSync(join(daemon.root, 'bin', 'codex'), [shebang, HANG, ...engine].join('\n'), { mode: 0o755 })
}

/** Asks [daemon] for its rate limits and returns the two rows of the read's process group, its leader first. The read is
 *  never answered: `usage_read` answers once the read settles, and this Codex never ends. */
export async function hungRateLimitRead(daemon: IsolatedDaemon): Promise<ProcessRow[]> {
  await until('the usage service to connect', () => daemon.log().includes('[services] usage connected') || null, 30_000, 100)
  const client = await LocalClient.connect(daemon)
  try {
    client.send('usage_read', { requestId: 'hung-read' })
    const command = `${join(daemon.root, 'bin', 'codex')} app-server`
    return await until('the rate-limit read\'s Codex and its child', () => {
      const table = processTable()
      const leader = table.find((row) => row.pid === row.pgid && row.command.includes(command))
      const group = leader ? table.filter((row) => row.pgid === leader.pgid) : []
      return group.length === 2 ? [leader!, ...group.filter((row) => row !== leader)] : null
    }, 60_000, 100)
  } finally {
    client.close()
  }
}
