import type { DiscoveryContract } from '../facets/discovery.js'

/**
 * Claude Code's discovery, declared: data only, which core applies with the kit (engines/discoveries.ts).
 * Copied from the former tables of lib/tmux.ts, its claudeNativeInstallPath, and lib/claudeProject.ts.
 */
export const discovery: DiscoveryContract = {
  process: {
    basenames: [/^claude$/],
    entrypoints: [/@anthropic-ai[\/\\]claude-code[\/\\]cli\.js$/],
    // The native installer exposes `~/.local/bin/claude` as a symlink to a binary named only by its version
    // (`~/.local/share/claude/versions/2.1.246`). During early startup both `comm` and argv[0] can still
    // name that target, before Claude rewrites either one to `claude`.
    versionedInstall: '.local/share/claude/versions',
  },
  // `--fork-session` writes a NEW session, so that argv names the PARENT and must not bind.
  resumeArgs: { flags: ['--resume', '-r'], id: /^[0-9a-f-]{16,}$/i, unless: ['--fork-session'] },
  /**
   * Claude writes `<projects>/<mangled launch dir>/<sessionId>.jsonl` and never moves the file: a session
   * resumed or forked from elsewhere still lives, and keeps writing, under the folder it was first started
   * in. A line's `cwd` follows every Bash `cd`, so it is the folder only when it maps to the file's own
   * directory name. The mangling is lossy, but exact in one direction. The scan cap is for the
   * pathological file, since this can run while an engine is blocked on its startup hook.
   */
  projectFolder: { mangle: /[^A-Za-z0-9]/g, with: '-', marker: '-', field: 'cwd', scanBytes: 2 * 1024 * 1024 },
}
