/** Installer programs belong to engineSetup and the invoking CLI, never the core's launch module. */
import { join } from 'node:path'
import type { AgentEngine } from '../types.js'
import { LAUNCH_LOCATION_VARIABLES } from './nativeLocations.js'
import { engineBin } from '../../lib/engineBin.js'
import { engineInstallPaths, npmEnginePrefix, type EngineInstallRecipe } from '../../lib/engineInstall.js'
import { engineLabel } from '../../lib/agentNames.js'
import { managedNodePath } from '../../lib/nodeRuntime.js'
import { RAISE_OPEN_FILES_SH } from '../../lib/openFiles.js'
import { shellSingleQuote } from '../../lib/shellQuote.js'
import { clearEnvPrelude, engineShellArgv, interactiveEngineShell, npmRuntimeBins, posixRunner, STOP_PROOF_FUNCTIONS } from '../../lib/engineLaunch.js'

export function npmRuntimePrelude(recipe: EngineInstallRecipe, runtimeNode: string): string {
  if (!recipe.executable.npmGlobal) return ''
  const bins = npmRuntimeBins(runtimeNode)
    .map(shellSingleQuote)
    .join(' ')
  return [
    'if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then',
    `  for harness_node_bin in ${bins}; do`,
    '    if [ -x "$harness_node_bin/node" ] && [ -x "$harness_node_bin/npm" ]; then',
    '      PATH="$harness_node_bin${PATH:+:$PATH}"',
    '      export PATH',
    '      hash -r 2>/dev/null || true',
    '      break',
    '    fi',
    '  done',
    'fi',
  ].join('\n')
}

/** Install if needed, then run an exact native argv from an existing interactive prompt.
 * The parent shell keeps its helpers and environment when the agent exits. */
export function shellAgentArgv(binary: string, args: string[], recipe: EngineInstallRecipe,
  runtimeNode: string = managedNodePath()): string[] {
  return ['/bin/sh', '-c', RAISE_OPEN_FILES_SH + STOP_PROOF_FUNCTIONS
    + installIfMissingScript(recipe, runtimeNode) + 'shift\nexec "$harness_engine_bin" "$@"\n',
    'harness-shell-agent', binary, ...args]
}

/**
 * Install-if-missing has to resolve twice: before installing, and again after it returns.
 *
 * A `curl | bash` installer cannot export PATH back into its parent shell. Several supported
 * vendors correctly put their binary under ~/.local/bin and update a profile for the NEXT shell,
 * which previously made this very pane print `command not found` after a successful install. The
 * source-owned candidate paths below bridge that one-shell gap without sourcing arbitrary profile
 * files a second time. npm installs also get their active global prefix as a fallback.
 */
function installIfMissingScript(recipe: EngineInstallRecipe, runtimeNode: string, home?: string, downloadEngine?: string): string {
  const install = recipe.command
  const label = downloadEngine ? (downloadEngine === 'claude' ? 'Claude Code' : engineLabel(downloadEngine)) : ''
  const names = recipe.executable.names.map(shellSingleQuote).join(' ')
  const paths = engineInstallPaths(recipe, home).map(shellSingleQuote).join(' ')
  const prefix = home ? join(home, '.local') : npmEnginePrefix()
  // Scope both npm env spellings to the installer subprocess. Do not rewrite .npmrc or install
  // into a different OS user's shared prefix, and do not tie the engine to a versioned Node folder.
  // Either way a subshell, run at the top level where a stop is resumed (STOP_PROOF_FUNCTIONS).
  const run = (line: string) => recipe.executable.npmGlobal
    ? `(export npm_config_prefix=${shellSingleQuote(prefix)} NPM_CONFIG_PREFIX=${shellSingleQuote(prefix)}; eval ${shellSingleQuote(line)})`
    : `(eval ${shellSingleQuote(line)})`
  const installCommand = run(install)
  const candidates = [names, paths].filter(Boolean).join(' ')
  // `curl … | bash` exits 0 when curl itself fails (bash ran an empty script), so the fallback is
  // decided by whether an executable exists afterwards, not by the first line's status.
  // Decided first, then run as a top-level command like the first install line: a Ctrl+Z inside a
  // compound `if` makes zsh drop the rest of it (STOP_PROOF_FUNCTIONS). An install the person ended
  // with Ctrl-C (130) is not followed by another one.
  const fallback = recipe.fallback ? [
    'harness_try_fallback=0',
    'if [ -z "$harness_engine_bin" ] && [ "$harness_status" -ne 130 ]; then',
    '  hash -r 2>/dev/null || true',
    '  if ! harness_find_engine "$1"; then',
    '    harness_try_fallback=1',
    '    harness_status=0',
    `    [ "$harness_quiet" -eq 1 ] || printf '\\n%s\\n' 'harness: that install did not finish; trying the npm package instead' 'harness: $ ${recipe.fallback.replace(/'/g, "'\\''")}' ''`,
    '  fi',
    'fi',
    `[ "$harness_try_fallback" -eq 0 ] || [ "$harness_quiet" -eq 1 ] || ${run(recipe.fallback)} || harness_status=$?`,
    'harness_resume',
  ] : []
  return [
    'resolve_engine() {',
    '  candidate="$1"',
    '  resolved=""',
    '  case "$candidate" in',
    '    */*) resolved="$candidate" ;;',
    '    *) resolved="$(command -v "$candidate" 2>/dev/null)" || true ;;',
    '  esac',
    '  [ -n "$resolved" ] && [ -f "$resolved" ] && [ -x "$resolved" ]',
    '}',
    // The first of these that is there becomes `harness_engine_bin`. Loops are fine here: nothing in
    // them can stop the way the engine can.
    'harness_find_engine() {',
    '  harness_engine_bin=',
    `  for candidate in "$1"${candidates ? ` ${candidates}` : ''}; do`,
    '    if resolve_engine "$candidate"; then harness_engine_bin="$resolved"; return 0; fi',
    '  done',
    ...(recipe.executable.npmGlobal ? [
      '  npm_prefix="$(npm prefix -g 2>/dev/null)" || true',
      '  if [ -n "$npm_prefix" ]; then',
      `    for bin in ${names}; do`,
      '      if resolve_engine "$npm_prefix/bin/$bin"; then harness_engine_bin="$resolved"; return 0; fi',
      '    done',
      '  fi',
    ] : []),
    '  return 1',
    '}',
    // A previously installed npm launcher also needs Node. Resolve the runtime before executing
    // it, not just before installing it; fresh users often have no system node on PATH.
    npmRuntimePrelude(recipe, runtimeNode),
    // Desktop Harness downloads OpenCode, Codex and Claude Code beside a fresh computer's setup and
    // names the downloading process in `~/.harness/run/downloading-<engine>`. A pane that opens
    // meanwhile waits for that download before starting a second
    // install into the folder it is writing (two npm installs into one prefix can break both). A
    // marker whose process is gone, or is not that download, is ignored. At most ten minutes.
    // The waiting runs in command substitutions, out of a Ctrl+Z's reach (STOP_PROOF_FUNCTIONS).
    // A wait ended early (Ctrl-C, the ten
    // minutes) while the download still runs ends the pane rather than starting a second install.
    ...(downloadEngine ? [
      'harness_wait_download() {',
      '  harness_dl_pid=$(cat "$HOME/.harness/run/downloading-$1" 2>/dev/null) || return 0',
      "  case \"$harness_dl_pid\" in ''|*[!0-9]*) return 0 ;; esac",
      '  kill -0 "$harness_dl_pid" 2>/dev/null || return 0',
      '  ps -p "$harness_dl_pid" -o command= 2>/dev/null | grep -q harness-download || return 0',
      `    printf '%s\\n' ${shellSingleQuote(`harness: ${label} is downloading in the background; waiting for it`)}`,
      '    harness_dl_i=0; while kill -0 "$harness_dl_pid" 2>/dev/null && [ "$harness_dl_i" -lt 1200 ]; do harness_dl_w=$(sleep 0.5) || :; harness_dl_i=$((harness_dl_i + 1)); done',
      `  if kill -0 "$harness_dl_pid" 2>/dev/null; then printf '\\n%s\\n' ${shellSingleQuote(`${label} is still downloading. Try again in a minute.`)}; exit 1; fi`,
      '  hash -r 2>/dev/null || true',
      '}',
    ] : []),
    'harness_quiet=0',
    ...(downloadEngine ? [`harness_find_engine "$1" || harness_wait_download ${shellSingleQuote(downloadEngine.replace(/[^a-z0-9-]/g, ''))}`] : []),
    'if ! harness_find_engine "$1"; then',
    ...(recipe.executable.npmGlobal ? [
      '  if ! command -v npm >/dev/null 2>&1; then',
      `    printf '%s\\n' 'harness: npm is unavailable and the managed Node.js/npm runtime could not be used.'`,
      '    exit 1',
      '  fi',
    ] : []),
    `  [ "$harness_quiet" -eq 1 ] || printf '%s\\n' 'harness: engine is missing — installing it in this terminal' 'harness: $ ${install.replace(/'/g, "'\\''")}' ''`,
    ...(recipe.executable.npmGlobal ? [`  [ "$harness_quiet" -eq 1 ] || printf '%s\\n' ${shellSingleQuote(`harness: installing for this user in ${npmEnginePrefix()}`)}`] : []),
    'fi',
    'harness_status=0',
    `[ -n "$harness_engine_bin" ] || [ "$harness_quiet" -eq 1 ] || ${installCommand} || harness_status=$?`,
    'harness_resume',
    ...fallback,
    'if [ -z "$harness_engine_bin" ]; then',
    `  if [ "$harness_status" -ne 0 ]; then printf '\\n%s\\n' 'harness: the install failed, so the agent was not started. The command is above; fix it and create the agent again.'; exit 1; fi`,
    '  hash -r 2>/dev/null || true',
    `  if ! harness_find_engine "$1"; then printf '\\n%s\\n' 'harness: the install completed, but its executable could not be found. Check the installer output and PATH above.'; exit 1; fi`,
    'fi',
    '',
  ].filter(Boolean).join('\n') + '\n'
}

/** An installation dependency only. Core must rebuild a launch after this exits;
 * no engine argv or first prompt is carried into the installer. */
export function buildEngineInstallationArgv(engine: AgentEngine, recipe: EngineInstallRecipe,
  environment: Record<string, string>, runtimeNode: string = managedNodePath()): string[] {
  // The installers are POSIX shell lines (`curl … | bash`, npm under a POSIX prelude): there is nothing to run them in.
  if (process.platform === 'win32') throw new Error(`The POSIX installer of ${engine} does not run on Windows (engines/kit/windowsInstall.ts does).`)
  const shell = interactiveEngineShell(environment.SHELL) ?? { path: posixRunner(), args: ['-c'], label: 'shell' }
  if (Object.keys(environment).some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) throw new Error('Invalid installation environment name')
  const locations = Object.entries(environment).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}\n`).join('')
  // A detached dependency has no foreground terminal job. Keep descendants in
  // its one process group so a deadline also ends stopped installer children.
  const body = RAISE_OPEN_FILES_SH + clearEnvPrelude(LAUNCH_LOCATION_VARIABLES.filter(key => !(key in environment))) + locations + 'set +m 2>/dev/null || :\n' + STOP_PROOF_FUNCTIONS
    + installIfMissingScript(recipe, runtimeNode, environment.HOME, engine) + 'exit 0\n'
  return engineShellArgv(shell, [body, 'harness-native-install', engineBin(engine)])
}
