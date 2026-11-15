/**
 * What a daemon under test takes from the shell that runs the tests: what it needs to run, and nothing that says
 * where the developer keeps something or who they are to a service. Everything else is dropped, known or not. The
 * audit of 2026-11-15 found two dozen names the daemon's code reads that named the developer's own state: their
 * HARNESS_CONNECTIONS_DIR gave every daemon under test their connected services' tokens, and their XDG_DATA_HOME had
 * their Harness OS tokens copied into the test's root. A list of names to drop would miss the next one, and
 * SSH_AUTH_SOCK, AWS_* and NPM_TOKEN, which no code here reads but what a daemon runs can use. The lists this replaced
 * are covered by it: the host supervisor's HARNESSD_*, an agent session's variables, a GitHub login, the host app's
 * hints.
 *
 * A name an end-to-end file turns out to need is added here, with its reason. Never a list of names to drop again.
 * What the harness sets, and what a test sets, are `own` and always win: for a daemon under test (e2e/harness/daemon.ts)
 * and for a tmux server a test starts itself (isolatedTmux.ts).
 *
 * In capitals: Windows reads a name whatever its capitals, and its shells spell them differently (cmd hands a child
 * SystemRoot and Path, Git Bash SYSTEMROOT and PATH).
 */
const INHERITED: ReadonlySet<string> = new Set([
  // The tools the tests run: node, tmux, git, zsh. The harness puts its own bin folder first.
  'PATH',
  // UTF-8 in tmux and in the panes, with every LC_* (below). CI sets LANG to C.UTF-8.
  'LANG', 'LC_ALL',
  // The terminal tmux and the panes draw for, and the login shell a pane opens. SHELL is still inherited for a tmux
  // server a test starts itself, whose tmux would fall back to the account's shell anyway; a daemon's is pinned
  // (e2e/harness/daemon.ts).
  'TERM', 'SHELL',
  // Who the process is. No state.
  'USER', 'LOGNAME',
  // Times in logs and transcripts, and whether this is a CI run.
  'TZ', 'CI',
  // Windows: Node cannot start a child without these.
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR',
])
const needed = (key: string) => { const name = key.toUpperCase(); return INHERITED.has(name) || name.startsWith('LC_') }
export function daemonEnvironment(inherited: NodeJS.ProcessEnv, own: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(inherited).filter(([key]) => needed(key)))
  return { ...kept, ...own }
}
