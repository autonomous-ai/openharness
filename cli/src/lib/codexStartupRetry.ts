/**
 * Run inside the pane's shell, before/after a Codex process, using the daemon's Node.
 *
 * Codex 0.159.3 exits 1 when account/read's workspace-routing discovery times out,
 * before thread/start or the first prompt. Retrying that exact bootstrap failure is
 * safe; retrying an arbitrary exit could replay work. Inspect tmux AFTER exit so
 * stdin, stdout and stderr stay real terminals (no tee, pipe or second PTY).
 *
 * The baseline rejects old output left in the pane. A bootstrap timeout must be
 * the new, final line within 30 seconds. A successful startup update instead ends
 * with Codex's explicit restart request (observed in codex-cli 0.160.0). That path
 * has no time limit: the person may leave the update prompt open before accepting.
 * Normal exits, cancellation, auth/config errors, session failures and unavailable
 * terminal evidence fail closed. The baseline stores no terminal text or prompt.
 */
export const CODEX_STARTUP_RETRY_PROBE = String.raw`
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const [mode, tmux, pane, baseline] = process.argv.slice(1);
try {
  if (!/^%\d+$/.test(pane)) process.exit(1);
  const screen = execFileSync(tmux, ['capture-pane', '-p', '-J', '-S', '-10', '-t', pane], {
    timeout: 2000, maxBuffer: 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const last = screen.trimEnd().split('\n').at(-1)?.trim() ?? '';
  const hash = createHash('sha256').update(last).digest('hex');
  if (mode === 'before') {
    process.stdout.write(JSON.stringify({ at: Date.now(), hash }));
  } else {
    const before = JSON.parse(baseline);
    const elapsed = Date.now() - before.at;
    const error = 'Error: account/read failed during TUI bootstrap: account/read failed: workspace routing discovery timed out (code -32603)';
    const fresh = Number.isFinite(elapsed) && elapsed >= 0 && /^[a-f0-9]{64}$/.test(before.hash) && before.hash !== hash;
    const matches = mode === 'after-update'
      ? /^(?:🎉\s*)?Update ran successfully! Please restart Codex\.$/.test(last)
      : mode === 'after' && elapsed <= 30000 && last === error;
    process.exit(fresh && matches ? 0 : 1);
  }
} catch { process.exit(1); }
`.trim()
