/**
 * What an engine's declared startup (facets/launch.ts `StartupContract`) adds to its pane's launch script:
 * the probe for the owned-process flag, and the runs again after a startup that never opened the
 * conversation. The script is lib/engineLaunch.ts's; this writes the engine's part of it from its declaration,
 * with the engine's id naming its functions and variables (`harness_codex_probe`). Moved from
 * lib/engineLaunch.ts and lib/codexStartupRetry.ts, whose every byte it reproduces
 * (engines/launchArgv.golden.spec.ts).
 *
 * Every helper the script waits on runs in a command substitution, out of a Ctrl+Z's reach, and the engine's
 * own runs stay at the script's top level (lib/engineLaunch.ts `STOP_PROOF_FUNCTIONS`).
 */
import { isAbsolute } from 'node:path'
import type { EngineLaunch, StartupRetry } from '../facets/launch.js'
import { shellSingleQuote } from '../../lib/shellQuote.js'

type Launch = Pick<EngineLaunch, 'startup' | 'sharedServer'> | undefined

/** The flag the probe asks the engine's help about, when the contract declares the probe. */
function probedFlag(launch: Launch): string | null {
  return launch?.startup?.ownedFlag && launch.sharedServer ? launch.sharedServer.ownedFlag : null
}

/** The variable that carries the probe's answer to each run, named after the flag (`harness_codex_no_daemon`). */
const flagVariable = (engine: string, flag: string): string => `harness_${engine}_${flag.replace(/^-+/, '').replace(/[^A-Za-z0-9]/g, '_')}`

/** Whether the engine needs the launch script even where the daemon has no login shell to run it in: its
 *  startup runs there. Without it, a Codex with no shell to probe in would put its work on the shared server. */
export function startupNeedsScript(launch: Launch): boolean {
  return !!launch?.startup
}

/** The engine is run again after a failed startup only where the pane can be read: through the daemon's tmux. */
export function startupRetries(launch: Launch, tmuxBinary: string | null): StartupRetry | null {
  const retry = launch?.startup?.retry
  return retry && tmuxBinary && isAbsolute(tmuxBinary) ? retry : null
}

/**
 * The script's functions for the engine's startup, after the wrapper's own (`harness_after`). `node` is the
 * daemon's Node, which every probe runs under: the pane's shell may have none.
 */
export function startupFunctions(engine: string, launch: Launch, tmuxBinary: string | null, node: string): string {
  const flag = probedFlag(launch)
  const retry = startupRetries(launch, tmuxBinary)
  return (flag ? ownedFlagProbe(engine, flag, launch!.startup!.ownedFlag!.unverified, node) : '')
    + (retry ? retryFunctions(engine, retry, !!flag, tmuxBinary!, node) : '')
}

/**
 * The engine's runs, at the script's top level, then `harness_after`. `$harness_engine_bin` is the engine
 * and `"$@"` its arguments. A run that may be repeated is written out once per run, since no loop or
 * function may hold the engine.
 *
 * `... || harness_status=$?` rather than `...; harness_status=$?`: a rc file that turned on `set -e` would
 * end the script on the engine's non-zero exit before the fallback ran.
 */
export function startupRuns(engine: string, launch: Launch, tmuxBinary: string | null): string {
  const flag = probedFlag(launch)
  const run = `"$harness_engine_bin"${flag ? ` \${${flagVariable(engine, flag)}:+${flag}}` : ''} "$@"`
  const retry = startupRetries(launch, tmuxBinary)
  if (!retry) {
    return [
      ...(flag ? [`harness_${engine}_probe "$harness_engine_bin"`] : []),
      'harness_status=0',
      `${run} || harness_status=$?`,
      'harness_resume',
      'harness_after',
    ].join('\n')
  }
  const ns = `harness_${engine}`
  const attempt = [
    `${ns}_start "$harness_engine_bin"`,
    `[ "$${ns}_go" != 1 ] || ${run} || harness_status=$?`,
    'harness_resume',
    `${ns}_next`,
  ]
  // The first run, one more after a startup update, and the transient failure's retries.
  const runs = 1 + 1 + (retry.transient.attempts - 1)
  return [
    `${ns}_attempt=1`,
    `${ns}_updated=0`,
    `${ns}_go=1`,
    ...Array.from({ length: runs }, () => attempt).flat(),
    'harness_after',
  ].join('\n')
}

/**
 * Asks the binary's own help whether it takes `flag`, a whole option rather than the start of a longer one.
 * It sets the flag's variable for the run rather than rewriting "$@", so each run probes its binary afresh
 * (an update may have replaced it) without adding the flag to the saved arguments again.
 */
function ownedFlagProbe(engine: string, flag: string, unverified: string, node: string): string {
  const pattern = flag.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const probe = `const {execFileSync}=require('node:child_process');try { const h=execFileSync(process.argv[1],['--help'],{timeout:5000,maxBuffer:1048576,encoding:'utf8',stdio:['ignore','pipe','pipe']});process.exit(/${pattern}(?:[^A-Za-z0-9-]|$)/.test(h)?0:64); } catch { process.exit(2); }`
  const ns = `harness_${engine}`
  return `${ns}_probe() {\n`
    + `  ${ns}_mode=0\n`
    + `  ${ns}_seen=$(${shellSingleQuote(node)} -e ${shellSingleQuote(probe)} "$1") || ${ns}_mode=$?\n`
    + `  case "$${ns}_mode" in\n`
    + `    0) ${flagVariable(engine, flag)}=1 ;;\n`
    + `    64) ${flagVariable(engine, flag)}= ;;\n`
    + `    *) printf '%s\\n' ${shellSingleQuote(`harness: ${unverified}`)} >&2; exit 1 ;;\n`
    + '  esac\n'
    + '}\n'
}

/** A JavaScript string literal in single quotes. */
const jsQuoted = (text: string): string => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`

/**
 * The evidence the retry reads, run with the daemon's Node inside the pane's shell, before and after a run.
 *
 * Inspect tmux AFTER exit so stdin, stdout and stderr stay real terminals (no tee, pipe or second PTY). The
 * baseline rejects old output left in the pane: a transient failure must be the new, final line within its
 * window; an update's restart request has no time limit, since the person may leave the update prompt open
 * before accepting. Normal exits, cancellation, auth/config errors, session failures and unavailable
 * terminal evidence fail closed. The baseline stores no terminal text or prompt.
 */
export function startupProbe(retry: StartupRetry): string {
  return String.raw`
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
    const error = ${jsQuoted(retry.transient.line)};
    const fresh = Number.isFinite(elapsed) && elapsed >= 0 && /^[a-f0-9]{64}$/.test(before.hash) && before.hash !== hash;
    const matches = mode === 'after-update'
      ? /${retry.updated.line}/.test(last)
      : mode === 'after' && elapsed <= ${retry.transient.withinMs} && last === error;
    process.exit(fresh && matches ? 0 : 1);
  }
} catch { process.exit(1); }
`.trim()
}

/**
 * Keeps a successful startup update or a transient failure in the original launch. Only the final exit
 * gets the pane's engine-exit marker. The short backoff also keeps discovery from archiving the row between
 * attempts. Never reparse "$@": it includes the original prompt, images, model, permissions and resume/fork
 * arguments. An updater runs before the conversation opens, so the exact launch is replayed once, without
 * choosing an unrelated conversation (`resume --last`).
 *
 * `_start` readies a run and `_next` decides whether another follows. The probe is written once, as
 * `_check`: tmux refuses a command longer than 16KiB, and the launch, first prompt and all, goes to it as one
 * (`tmux new-session`).
 */
function retryFunctions(engine: string, retry: StartupRetry, probesFlag: boolean, tmuxBinary: string, node: string): string {
  const ns = `harness_${engine}`
  const check = `${ns}_check`
  const tmux = shellSingleQuote(tmuxBinary)
  const { updated, transient } = retry
  // In double quotes, so the attempt and the delay are the shell's own: anything else in it is taken as written.
  const waiting = `harness: ${transient.message}`.replace(/[\\"$`]/g, '\\$&')
    .split('{attempt}').join(`$${ns}_attempt`)
    .split('{attempts}').join(String(transient.attempts))
    .split('{delay}').join(`\${${ns}_delay}`)
  return `${check}() {\n`
    + `  ${shellSingleQuote(node)} -e ${shellSingleQuote(startupProbe(retry))} "$@"\n`
    + '}\n'
    + `${ns}_start() {\n`
    + `  [ "$${ns}_go" = 1 ] || return 0\n`
    + `  ${ns}_before=\n`
    + `  if [ -n "\${TMUX_PANE:-}" ]; then ${ns}_before=$(${check} before ${tmux} "$TMUX_PANE") || ${ns}_before=; fi\n`
    + (probesFlag ? `  ${ns}_probe "$1"\n` : '')
    + '  harness_status=0\n'
    + '}\n'
    + `${ns}_next() {\n`
    + `  [ "$${ns}_go" = 1 ] || return 0\n`
    + `  ${ns}_go=0\n`
    + `  if [ "$harness_status" -eq ${updated.status} ] && [ "$${ns}_updated" -eq 0 ] && [ -n "$${ns}_before" ] &&\n`
    + `    ${ns}_seen=$(${check} after-update ${tmux} "$TMUX_PANE" "$${ns}_before"); then\n`
    + `    ${ns}_updated=1\n`
    + `    printf '\\n%s\\n' ${shellSingleQuote(`harness: ${updated.message}`)}\n`
    + `    ${ns}_go=1\n`
    + '    return 0\n'
    + '  fi\n'
    + `  [ "$harness_status" -eq ${transient.status} ] && [ "$${ns}_attempt" -lt ${transient.attempts} ] && [ -n "$${ns}_before" ] || return 0\n`
    + `  ${ns}_seen=$(${check} after ${tmux} "$TMUX_PANE" "$${ns}_before") || return 0\n`
    + `  ${ns}_delay=$((${ns}_attempt * ${transient.backoffSeconds}))\n`
    + `  ${ns}_attempt=$((${ns}_attempt + 1))\n`
    + `  ${ns}_cancelled=0\n`
    + `  trap '${ns}_cancelled=1' INT\n`
    + `  printf '\\n%s\\n' "${waiting}"\n`
    + `  ${ns}_seen=$(sleep "$${ns}_delay") || ${ns}_cancelled=1\n`
    + '  trap : INT\n'
    + `  if [ "$${ns}_cancelled" -eq 1 ]; then harness_status=130; return 0; fi\n`
    + `  ${ns}_go=1\n`
    + '}\n'
}
