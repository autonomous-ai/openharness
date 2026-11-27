import { expect, it } from 'vitest'
import { claudeBackgroundCommands } from './backgroundCommands.js'

// Claude Code 2.1.322, macOS, zsh 5.9: `ps -axo pid=,ppid=,args=` under one engine, 2026-11-12 (home and command replaced).
const SHELL = "/bin/zsh -c source '/Users/u/Library/Application Support/claude/shell-snapshots/snapshot-zsh-1794472199641-2xja85.sh' 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \\builtin unalias -- 'which'; \\builtin unset -f -- 'which'; } >/dev/null 2>&1 || true && eval 'sleep 40' < /dev/null && pwd -P >| /tmp/claude-9e33-cwd"
const MCP = '/Users/u/.codegraph/versions/v1.6.2/node --liftoff-only --disable-warning=ExperimentalWarning /Users/u/.codegraph/versions/v1.6.2/lib/dist/bin/codegraph.js serve --mcp'
const CAFFEINATE = 'caffeinate -i -t 300'
const rows = (...args: string[]) => args.map((a) => ({ args: a }))

it('counts the shells its Bash tool runs, and none of its helpers', () => {
  expect(claudeBackgroundCommands(rows(SHELL, MCP, CAFFEINATE, SHELL))).toBe(2)
  expect(claudeBackgroundCommands(rows(MCP, CAFFEINATE))).toBe(0)
  expect(claudeBackgroundCommands([])).toBe(0)
})

// Not recorded: the rule reads only the shell's name, `-c` and the snapshot's path, so bash on Linux reads the same.
it('takes the same wrapper under another shell', () => {
  expect(claudeBackgroundCommands(rows("/bin/bash -c source '/home/u/.claude/shell-snapshots/snapshot-bash-1794472199641-ab12cd.sh' 2>/dev/null || true && eval 'npm test' < /dev/null && pwd -P >| /tmp/claude-1a2b-cwd"))).toBe(1)
})

// Not recorded: the shape @anthropic-ai/sandbox-runtime 0.0.82 builds and Claude Code 2.1.322 runs as `/bin/sh -c <bwrap …>`
// on Linux with the sandbox on. sh execs bwrap, which stays the engine's child, and the snapshot shell runs below it.
const BWRAP = "bwrap --new-session --die-with-parent --unshare-net --ro-bind / / --bind /home/u/p /home/u/p --dev /dev --unshare-pid --proc /proc -- /usr/bin/bash -c exec 9<&- || exit 126; source '/home/u/.claude/shell-snapshots/snapshot-bash-1794472199641-ab12cd.sh' 2>/dev/null || true && eval 'npm test' < /dev/null && pwd -P >| /tmp/claude-1a2b-cwd"
const SOCAT = 'socat UNIX-LISTEN:/tmp/claude-http-0a1b2c3d4e5f6a7b.sock,fork,reuseaddr TCP:localhost:41231,keepalive,keepidle=10,keepintvl=5,keepcnt=3'

it('counts a sandboxed command by the bwrap that runs its shell, and none of the sandbox\'s helpers', () => {
  expect(claudeBackgroundCommands(rows(BWRAP, SOCAT, SOCAT))).toBe(1)
  expect(claudeBackgroundCommands(rows(BWRAP.replace(/^bwrap/, '/usr/bin/bwrap'), BWRAP))).toBe(2)
  expect(claudeBackgroundCommands(rows(SOCAT, 'bwrap --new-session --ro-bind / / -- /bin/sh -c /home/u/.claude/hooks/x.sh'))).toBe(0)
})

it('leaves out a shell that is not its Bash tool\'s, and a program that only names a snapshot', () => {
  expect(claudeBackgroundCommands(rows(
    '/bin/sh -c /Users/u/.harness/hook/notify.sh',                                  // a hook: a shell, no snapshot
    "/bin/zsh -lic . '/Users/u/.harness/cli/data/launch/x.sh' harness-engine",      // no -c of its own
    'cat /Users/u/.claude/shell-snapshots/snapshot-zsh-1794472199641-2xja85.sh',    // names one, is no shell
    'node /opt/tool/shell-snapshots/snapshot-reader.js -c x',
  ))).toBe(0)
})
