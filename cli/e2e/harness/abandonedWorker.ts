/**
 * A test worker that starts a daemon and goes without closing it (e2e/leftBehind.e2e.ts): `exits` ends by itself when a
 * line comes on stdin, as a worker does after a file whose teardown never ran; otherwise it waits to be killed or
 * interrupted. It prints the daemon's root, master, core and tmux socket once the daemon, its edge service (the one
 * that ran lsof forever) and its tmux server are up. With them, `escaped`: a hung Codex rate-limit read, its tie's
 * watcher and its child, out of the daemon's process groups (e2e/harness/hungCodex.ts); `left`: what its tmux pane left
 * running, as a real engine left in a tile, in no process group the worker registered and naming nothing of the root,
 * its working folder in it;
 * and `readOnly`: a read-only folder in the root, as the managed grid's install leaves its bin/ (lib/runtimeInstall.ts).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IsolatedDaemon, until } from './daemon.js'
import { hungRateLimitRead, writeHungCodex } from './hungCodex.js'

const daemon = await IsolatedDaemon.create()
writeHungCodex(daemon)
await daemon.start()
await until('the edge service', () => /\[harnessd\] service edge started/.test(daemon.log()) || null, 60_000, 100)
// Its tmux server, which an agent's pane would have started. And in it what a tile leaves behind: a `sleep` deaf to
// the hangup its pane's end sends, its command line naming nothing of the root, its working folder inside it.
const leftFile = join(daemon.root, 'left.pid')
await daemon.tmux.run('new-session', '-d', '-s', 'left-behind', '-c', daemon.projectsDir,
  '/bin/sh', '-c', 'nohup sleep 600 >/dev/null 2>&1 & echo $! > "$0.tmp" && mv "$0.tmp" "$0"; exec sleep 600', leftFile)
const left = await until('what its pane left', () => existsSync(leftFile) ? Number(readFileSync(leftFile, 'utf8')) : null, 10_000, 50)
const escaped = (await hungRateLimitRead(daemon)).map((row) => row.pid)
// With a file in it: a recursive removal cannot unlink it, and an empty one it would remove.
const readOnly = join(daemon.root, 'read-only')
mkdirSync(readOnly)
writeFileSync(join(readOnly, 'kept'), '')
chmodSync(readOnly, 0o555)
process.stdout.write(`${JSON.stringify({ root: daemon.root, master: daemon.pid, core: daemon.corePid(), socket: daemon.tmux.socket, escaped, left, readOnly })}\n`)
// Told to go on stdin once the test has seen everything the daemon runs.
if (process.argv[2] === 'exits') process.stdin.once('data', () => process.exit(0))
else setInterval(() => {}, 1 << 30)
