/**
 * Soft open-files limit a process Harness starts should have at minimum.
 *
 * macOS starts everything launchd launches — the desktop app, and through it the daemon, the tmux
 * server and every pane that server opens — at a soft limit of 256 descriptors (`launchctl limit
 * maxfiles` → `256 unlimited`). Claude Code refuses to start under that: "An unknown error occurred,
 * possibly due to low max file descriptors · Current limit: 256". An engine with a dozen MCP servers
 * (three pipes each) and a transcript watcher needs hundreds before its first turn. 65,536 is well
 * under macOS's per-process ceiling (`kern.maxfilesperproc`, 122,880 by default) and Linux's usual
 * hard limit of 1,048,576.
 *
 * The daemon needs none of this: Node raises its own soft limit to the hard one at startup (measured:
 * a `sh -c 'ulimit -S -n 256; exec node …'` reports 1,048,575 from inside). A tmux server does not,
 * and neither does an engine shipped as a native binary — which is why a pane inherits the 256 and
 * the engine, not the daemon, is what fails.
 */
export const MIN_OPEN_FILES = 65_536

/**
 * POSIX shell prelude that raises the soft open-files limit to MIN_OPEN_FILES when it is lower.
 *
 * A process may lift its own soft limit anywhere up to the hard one without privileges, and the hard
 * limit is `unlimited` on macOS — so the raise costs nothing and needs no `sudo launchctl`. It never
 * lowers: a shell that already has more keeps it. Where the hard limit is below the target (some
 * Linux distributions cap it at 4,096), the soft limit becomes the hard one instead. `-S` is spelled
 * out because zsh's bare `ulimit -n N` sets the HARD limit as well, and a hard limit of 65,536 is a
 * ceiling the engine could no longer raise past. Any failure is silent, so the process starts with
 * what it has — as it always did.
 *
 * Runs under /bin/sh, bash and zsh alike (`[ ]`, `$( )`, `2>/dev/null`); the pane script is already
 * POSIX-only for the same reason.
 */
export const RAISE_OPEN_FILES_SH =
  // Every statement ends in a branch that succeeds: the pane's shell has already run the user's rc
  // files, and one that turned on `set -e` would otherwise end the script here — before the engine —
  // the day a query or a raise fails. (A failed query reads as `unlimited`, which is "leave it".)
  `harness_nofile=$(ulimit -S -n 2>/dev/null) || harness_nofile=unlimited; ` +
  `if [ "$harness_nofile" != unlimited ] && [ "$harness_nofile" -lt ${MIN_OPEN_FILES} ] 2>/dev/null; ` +
  `then ulimit -S -n ${MIN_OPEN_FILES} 2>/dev/null || ulimit -S -n "$(ulimit -H -n)" 2>/dev/null || true; fi; ` +
  `unset harness_nofile\n`
