/**
 * A test worker that starts a daemon and goes without closing it (e2e/leftBehind.e2e.ts): `exits` ends by itself when a
 * line comes on stdin, as a worker does after a file whose teardown never ran; otherwise it waits to be killed or
 * interrupted. It prints the daemon's root, master, core and tmux socket once the daemon, its edge service (the one
 * that ran lsof forever) and its tmux server are up. With them, `escaped`: a hung Codex rate-limit read and its child,
 * out of the daemon's process groups (e2e/harness/hungCodex.ts); and `readOnly`: a read-only folder in the root, as the
 * managed grid's install leaves its bin/ (lib/runtimeInstall.ts).
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IsolatedDaemon, until } from './daemon.js'
import { hungRateLimitRead, writeHungCodex } from './hungCodex.js'

const daemon = await IsolatedDaemon.create()
writeHungCodex(daemon)
await daemon.start()
await until('the edge service', () => /\[harnessd\] service edge started/.test(daemon.log()) || null, 60_000, 100)
// Its tmux server, which an agent's pane would have started.
await daemon.tmux.run('new-session', '-d', '-s', 'left-behind')
const escaped = (await hungRateLimitRead(daemon)).map((row) => row.pid)
// With a file in it: a recursive removal cannot unlink it, and an empty one it would remove.
const readOnly = join(daemon.root, 'read-only')
mkdirSync(readOnly)
writeFileSync(join(readOnly, 'kept'), '')
chmodSync(readOnly, 0o555)
process.stdout.write(`${JSON.stringify({ root: daemon.root, master: daemon.pid, core: daemon.corePid(), socket: daemon.tmux.socket, escaped, readOnly })}\n`)
// Told to go on stdin once the test has seen everything the daemon runs.
if (process.argv[2] === 'exits') process.stdin.once('data', () => process.exit(0))
else setInterval(() => {}, 1 << 30)
