/**
 * A command that ends when this process ends, however it ends. The agent browser starts every Podman command this way.
 *
 * Why: each crash of the agent browser's process (an uncaught error, SIGKILL, the OOM killer) left a `podman events`
 * running on the person's computer, one more per restart. Nobody ends a dead service's children, and `podman events`
 * reads no stdin, so it never noticed its parent was gone.
 *
 * On macOS and Linux the child is `/bin/sh -c TIED file args…` with a fourth pipe, fd 3, from this process:
 * - A watcher in the background holds fd 3. When this process ends, in any way, the OS closes this end, the watcher
 *   reads end-of-file and sends SIGTERM to the command.
 * - `exec` turns the shell into the command, so the child's pid, stdio, exit code and signals are the command's own:
 *   `child.kill` reaches it directly, and `$$`, the pid the watcher signals, is the command. The command does not
 *   inherit fd 3, and the watcher holds none of its stdio. The file and its arguments are `$0` and `$@`, never read by
 *   the shell; a file that is not there is the shell's exit 127 (126 from macOS's sh), not a spawn error.
 * - When the command exits by itself, a newline on fd 3 lets the watcher go without a signal: no watcher outlives its
 *   command. It is written only while fd 3 is open, and an error on fd 3 (a watcher already gone) is heard and
 *   dropped: unheard, it would crash this process.
 * Measured on macOS (bash 3.2 and dash): a tied command was gone 1 to 3 ms after its parent's SIGKILL, where a plain
 * one was still alive after 2 s. A tied start costs 2 to 3.5 ms more (`/usr/bin/true` to `close`: 1.25 ms plain,
 * 4.6 ms on bash, 2.9 ms on dash).
 *
 * Accepted: a command that ignores SIGTERM outlives this process, as it outlives `stop()`. If this process dies between
 * reaping its command and writing the newline, the watcher signals a pid that may be free again. Under a PID 1 that
 * does not reap, each command leaves a zombie watcher; Harness never runs as PID 1 (launchd, systemd, a Windows task).
 *
 * On Windows it is a plain spawn: Node puts every child it starts without `detached` in a Job Object that ends it with
 * this process (lib/windows/noWindow.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { Writable } from 'node:stream'

// fd 3 is closed on its own line: bash (macOS's sh) keeps a saved copy of a redirected fd across `exec cmd 3<&-`.
const TIED = '{ read -r _ <&3 || kill $$; } </dev/null >/dev/null 2>&1 & exec 3<&-; exec "$0" "$@"'

export function spawnTied(
  file: string,
  args: readonly string[],
  { platform = process.platform, ...options }: { env: NodeJS.ProcessEnv; detached?: boolean; windowsHide?: boolean; platform?: NodeJS.Platform },
): ChildProcess {
  if (platform === 'win32') return spawn(file, args, { ...options, stdio: 'pipe' })
  const child = spawn('/bin/sh', ['-c', TIED, file, ...args], { ...options, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
  const tie = child.stdio[3] as Writable
  tie.on('error', () => {})
  child.once('exit', () => { if (tie.writable) tie.write('\n') })
  return child
}
