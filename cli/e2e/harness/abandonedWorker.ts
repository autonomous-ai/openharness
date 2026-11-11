/**
 * A test worker that starts a daemon and goes without closing it (e2e/leftBehind.e2e.ts): `exits` ends by itself when a
 * line comes on stdin, as a worker does after a file whose teardown never ran; otherwise it waits to be killed or
 * interrupted. It prints the daemon's root, master, core and tmux socket once the daemon, its edge service (the one
 * that ran lsof forever) and its tmux server are up.
 */
import { IsolatedDaemon, until } from './daemon.js'

const daemon = await IsolatedDaemon.create()
await daemon.start()
await until('the edge service', () => /\[harnessd\] service edge started/.test(daemon.log()) || null, 60_000, 100)
// Its tmux server, which an agent's pane would have started.
await daemon.tmux.run('new-session', '-d', '-s', 'left-behind')
process.stdout.write(`${JSON.stringify({ root: daemon.root, master: daemon.pid, core: daemon.corePid(), socket: daemon.tmux.socket })}\n`)
// Told to go on stdin once the test has seen everything the daemon runs.
if (process.argv[2] === 'exits') process.stdin.once('data', () => process.exit(0))
else setInterval(() => {}, 1 << 30)
