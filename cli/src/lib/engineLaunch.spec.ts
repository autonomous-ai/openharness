import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { constants, tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from '../config/env.js'
import {
  AGENT_NAME_RE,
  BYPASS_PERMISSION_FLAGS,
  FIRST_PROMPT_ARGS,
  FirstPromptUnsupportedError,
  LAUNCH_RESUME_FLAG,
  NAMED_AGENT_ARGS,
  NamedAgentUnsupportedError,
  HARNESS_WORDMARK_LINES,
  MAX_FIRST_PROMPT_CHARS,
  PERMISSION_MODES,
  terminalHintLines,
  buildEngineCommandArgv,
  buildEngineLaunchArgv,
  shellAgentArgv,
  buildTerminalLaunchArgv,
  interactiveEngineShell,
  isPosixShell,
  commandAvailableInInteractiveShell,
  commandSupportsFlagInInteractiveShell,
  dropPermissionFlagIfUnsupported,
  permissionFlagToVerify,
  permissionModeFlags,
  refusePermissionFlagIfUnsupported,
  resetCommandFlagSupportCache,
  engineFallbackPrelude,
  ENGINE_INPUT_DRAIN_SH,
  firstPromptArgs,
  gridPanePrelude,
  harnessNodePrelude,
  namedAgentArgs,
  supportsFirstPrompt,
  supportsNamedAgent,
  unreadableCwdGuard,
  ZSH_GUARD_ZSHENV,
  zshNewUserGuard,
} from './engineLaunch.js'
import { ENGINES, type AgentEngine } from '../engines/types.js'
import { engineBin } from './engineBin.js'
import { engineInstallRecipe, type EngineInstallRecipe } from './engineInstall.js'
import { MIN_OPEN_FILES, RAISE_OPEN_FILES_SH } from './openFiles.js'
import { DSH_SESSION_ENV, harnessEnvToClear } from '../dsh/launch.js'
import { launchScriptOf } from '../testing/launchScript.js'
import { buildGridEngineLaunch, gridConflictingEnvToClear } from './gridLaunch.js'
import { TmuxBackend } from './tmuxBackend.js'

// What these cases test is what real shells make of the scripts this module writes: sh, dash, bash and
// zsh run each one, and nothing here could be faked without faking the subject. Each run carries its own
// bound (a probe's 5 s in engineLaunch.ts, the 10 s of the runs below), and vitest's 5 s default sat under
// them: a slow shell timed the case out instead of answering as its bound says. Under a full run at load
// 36 (six workers), 11 cases here hit it, one of them on a single probe; under 8 busy and 8 spawning loops
// the four-probe case took 4.9 s. Room for four probes at their limit, and a margin.
vi.setConfig({ testTimeout: 30_000 })

// The launch script names the `grid` the daemon resolved, and a developer's own HARNESS_GRID_BIN
// would resolve to THEIR grid. The suite's runtime dir is already a throwaway (vitest.setup.ts), so
// with the override gone every case below resolves to the bare name.
const developersOwnGridBin = process.env.HARNESS_GRID_BIN
beforeEach(() => { delete process.env.HARNESS_GRID_BIN })
afterAll(() => { if (developersOwnGridBin !== undefined) process.env.HARNESS_GRID_BIN = developersOwnGridBin })

// A zsh user as most are: with a startup file of their own, so the zsh launches below are the plain
// ones. vitest.setup.ts points ZDOTDIR at an empty folder, which is the new-user case `zshNewUserGuard`
// handles; that case has its own tests at the end of this file.
const suiteZdotdir = process.env.ZDOTDIR
const zshUserHome = mkdtempSync(join(tmpdir(), 'launch-zdotdir-'))
writeFileSync(join(zshUserHome, '.zshrc'), '')
beforeEach(() => { process.env.ZDOTDIR = zshUserHome })
afterAll(() => {
  if (suiteZdotdir === undefined) delete process.env.ZDOTDIR
  else process.env.ZDOTDIR = suiteZdotdir
  rmSync(zshUserHome, { recursive: true, force: true })
})

/** The prelude every case below gets by default: no managed grid on this machine, so PATH is left
 *  alone and only grid's update check is turned off. */
const GRID_PRELUDE = gridPanePrelude('grid')
/** The engine-in-a-shell wrapper every launch carries, for the shell each case names — see
 *  `engineFallbackPrelude`. `null` tmux: the suite must not depend on what this machine has. */
const FALLBACK = (engine: AgentEngine, shell: string) => engineFallbackPrelude(engine, shell, null)
const NO_TMUX = null
/** How a plain launch ends: job control on, the binary its command names run at the script's top
 *  level, where a stop is resumed, then the exit handling (`engineRunScript`). */
const RUN = 'if [ -n "${ZSH_VERSION:-}" ]; then setopt monitor 2>/dev/null || :; else set -m 2>/dev/null || :; fi\n'
  + 'trap : INT QUIT\n'
  + 'harness_engine_bin=$1\nshift\nharness_status=0\n"$harness_engine_bin" "$@" || harness_status=$?\nharness_resume\nharness_after'
/** The engine's own run, in every launch. */
const RUN_LINE = '"$harness_engine_bin" "$@" || harness_status=$?'
/** What a POSIX login shell's `-c` is: its launch script, sourced from a one-time file. */
const SOURCED = /^\. '.+\.sh'$/

describe('buildEngineLaunchArgv', () => {
  it('runs the exact native command in the current shell environment after a missing-agent install', () => {
    const dir = mkdtempSync(join(tmpdir(),'hn-shell-install-'))
    const binary = join(dir,'fake-agent'), source = join(dir,'template'), marker = join(dir,'installed')
    try {
      writeFileSync(source,'#!/bin/sh\nprintf "%s\\n" "$@"\nexit 17\n',{mode:0o700})
      const recipe: EngineInstallRecipe = {command:`cp '${source}' '${binary}'; touch '${marker}'`,source:'test fixture',executable:{names:[binary]}}
      const argv = shellAgentArgv(binary,['task; $(literal)','--model','mine'],recipe,'/missing-node')
      try { execFileSync(argv[0],argv.slice(1),{encoding:'utf8'}); throw new Error('expected native exit 17') }
      catch (error) {
        expect((error as {status:number}).status).toBe(17)
        expect(String((error as {stdout:string}).stdout)).toContain('task; $(literal)\n--model\nmine\n')
      }
      expect(existsSync(marker)).toBe(true)
      rmSync(marker)
      try { execFileSync(argv[0],argv.slice(1),{encoding:'utf8'}) } catch (error) { expect((error as {status:number}).status).toBe(17) }
      expect(existsSync(marker)).toBe(false)
    } finally { rmSync(dir,{recursive:true,force:true}) }
  })
  it.each(['claude', 'terminal'] as const)('clears inherited harness context before a plain %s session runs', (engine) => {
    const argv = buildEngineLaunchArgv(engine, { clearEnv: harnessEnvToClear() }, '/bin/sh', undefined, undefined, NO_TMUX)
    const probe = 'for name in HARNESS_DSH HARNESS_DSH_DIR HARNESS_WORKSPACE HARNESS_CONTEXT_FILE HARNESS_SKILLS_DIR HARNESS_PRIVATE_GRID; do printenv "$name" && exit 9; done; printf "%s" "$KEEP_ME"'
    const args = engine === 'terminal' ? ['harness-terminal', ''] : ['harness-engine']
    const out = execFileSync(argv[0], [argv[1], argv[2], ...args, '/bin/sh', '-c', probe], {
      encoding: 'utf8',
      env: { ...process.env, ...Object.fromEntries(DSH_SESSION_ENV.map((name) => [name, 'stale-harness'])), KEEP_ME: 'retained' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(out).toBe('retained')
  })

  it('wraps zsh in its interactive login form and execs the resolved binary', () => {
    const argv = buildEngineLaunchArgv('claude', {}, '/bin/zsh', undefined, undefined, NO_TMUX)
    expect(argv).toEqual([
      '/usr/bin/env', 'DISABLE_AUTO_UPDATE=true', '/bin/zsh', '-lic', expect.stringMatching(SOURCED), 'harness-engine', engineBin('claude'),
    ])
    expect(launchScriptOf(argv)).toBe(`${RAISE_OPEN_FILES_SH}${FALLBACK('claude', '/bin/zsh')}${GRID_PRELUDE}${RUN}`)
  })

  it('uses Ubuntu bash interactive startup files without making it a login shell', () => {
    const argv = buildEngineLaunchArgv('claude', {}, '/bin/bash', undefined, undefined, NO_TMUX)
    expect(argv).toEqual(['/bin/bash', '-ic', expect.stringMatching(SOURCED), 'harness-engine', engineBin('claude')])
    expect(launchScriptOf(argv)).toBe(`${RAISE_OPEN_FILES_SH}${FALLBACK('claude', '/bin/bash')}${GRID_PRELUDE}${RUN}`)
  })

  it('hands the shell its script in a one-time file that removes itself, private to this user', () => {
    // On the command line the script was most of a launch, and tmux takes the launch as one command of
    // at most 16KiB: see `launchFile`.
    const argv = buildEngineLaunchArgv('claude', { cwd: '/work' }, '/bin/zsh', undefined, undefined, NO_TMUX)
    const file = SOURCED.test(argv[4]) ? argv[4].slice(3, -1) : ''
    expect(file.startsWith(join(env.ADAPTER_DATA_DIR, 'launch'))).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8').startsWith(`rm -f -- '${file}'\n`)).toBe(true)
    const run = execFileSync('/bin/sh', ['-c', argv[4], 'harness-engine', '/', '/bin/sh', '-c', 'printf "%s|" "$PWD" "$@"', 'engine', 'a b'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    expect(run).toBe('/|a b|')
    expect(existsSync(file)).toBe(false)
  })

  it('runs Codex under dash, where there is one, when no login shell resolves', () => {
    // macOS's /bin/sh is bash 3.2, which never sees the engine stop: the engine would wait, stopped, for
    // good (STOP_PROOF_FUNCTIONS). dash resumes it like the rest.
    const argv = buildEngineLaunchArgv('codex', {}, 'relative-shell', undefined, undefined, NO_TMUX)
    expect(argv.slice(0, 2)).toEqual([existsSync('/bin/dash') ? '/bin/dash' : '/bin/sh', '-c'])
    expect(argv[2]).toMatch(SOURCED)
    expect(launchScriptOf(argv)).toContain('harness_resume')
  })

  it('sweeps a launch file that never ran once it is an hour old, and only then', () => {
    const directory = join(env.ADAPTER_DATA_DIR, 'launch')
    mkdirSync(directory, { recursive: true })
    const stale = join(directory, 'never-ran.sh')
    const fresh = join(directory, 'about-to-run.sh')
    writeFileSync(stale, 'exit 0\n')
    writeFileSync(fresh, 'exit 0\n')
    utimesSync(stale, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000))
    buildEngineLaunchArgv('claude', {}, '/bin/zsh', undefined, undefined, NO_TMUX)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('puts the script on the command line when there is no data folder to write it in', () => {
    const saved = env.ADAPTER_DATA_DIR
    env.ADAPTER_DATA_DIR = '/dev/null/no-data-folder'
    try {
      const argv = buildEngineLaunchArgv('claude', {}, '/bin/zsh', undefined, undefined, NO_TMUX)
      expect(argv[4]).toBe(`${RAISE_OPEN_FILES_SH}${FALLBACK('claude', '/bin/zsh')}${GRID_PRELUDE}${RUN}`)
    } finally { env.ADAPTER_DATA_DIR = saved }
  })

  it('keeps the longest launch, as the whole tmux command, well inside what tmux takes', async () => {
    // `tmux new-session` takes a launch as one command, its environment and options included, and
    // refuses one over 16KiB with "command too long" (measured, tmux 3.7c). The longest a launch gets:
    // Codex or Claude Code on a grid with its web tools, looked for first, taking over a terminal's
    // conversation, resuming it, with Harness's Node, and the longest first prompt in three-byte
    // characters. With the script on the command line Codex's came to 17.9KB; it goes in a file now.
    const dir = mkdtempSync(join(tmpdir(), 'harness-launch-size-'))
    const savedPath = process.env.PATH
    try {
      writeFileSync(join(dir, 'tmux'), `#!/bin/sh\nfor arg in "$@"; do printf '%s\\000' "$arg"; done > "$(mktemp ${dir}/call.XXXXXX)"\nprintf '%%42\\n'\n`, { mode: 0o755 })
      process.env.PATH = `${dir}:${savedPath}`
      const grid = { networkId: 'grid-3378218621364f16', networkName: 'autonomous.ai', baseUrl: 'https://grid.autonomous.ai/grid-3378218621364f16/relay/v1', apiKey: 'gridkey-abc123', model: 'GLM-4.7-Flash', mcpUrl: 'https://api-grid.autonomous.ai/v1/grid/web-mcp/' }
      for (const engine of ['claude', 'codex'] as const) {
        for (const call of readdirSync(dir).filter((name) => name.startsWith('call.'))) rmSync(join(dir, call))
        const built = buildGridEngineLaunch(engine, grid, { hermesSystemManaged: false })
        if (!built.ok) throw new Error(built.detail)
        const cwd = '/Users/demo/projects/a project with a fairly long name'
        const command = buildEngineLaunchArgv(engine, {
          cwd, firstPrompt: '漢'.repeat(MAX_FIRST_PROMPT_CHARS), resumeSessionId: '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b',
          installIfMissing: engineInstallRecipe(engine), waitForPid: { pid: 4242, name: 'Codex' }, bypassPermission: true,
          extraArgs: built.launch.args, clearEnv: gridConflictingEnvToClear(built.launch), harnessNode: true,
        }, '/bin/zsh', '/opt/harness/runtime/node/bin/node', '/opt/harness/runtime/grid/grid', '/opt/homebrew/bin/tmux')
        const created = await new TmuxBackend(undefined, () => 'daemon-0000').create({ cwd, label: `harness-${engine}-1791200000000`, env: built.launch.env, command })
        expect(created.state, engine).toBe('succeeded')
        const sizes = readdirSync(dir).filter((name) => name.startsWith('call.')).map((name) => statSync(join(dir, name)).size)
        expect(Math.max(...sizes), engine).toBeLessThan(15 * 1024)
      }
    } finally {
      process.env.PATH = savedPath
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enters the workspace only after interactive startup has completed', () => {
    const argv = buildEngineLaunchArgv('claude', { cwd: '/work/project' }, '/bin/zsh', undefined, undefined, NO_TMUX)
    expect(argv).toEqual([
      '/usr/bin/env', 'DISABLE_AUTO_UPDATE=true', '/bin/zsh', '-lic', expect.stringMatching(SOURCED),
      'harness-engine', '/work/project', engineBin('claude'),
    ])
    expect(launchScriptOf(argv)).toBe(
      `${RAISE_OPEN_FILES_SH}${FALLBACK('claude', '/bin/zsh')}${GRID_PRELUDE}if ! cd -- "$1"; then printf '%s\\n' 'harness: the selected working directory is unavailable.' >&2; exit 1; fi\n${unreadableCwdGuard(process.platform)}shift\n${RUN}`,
    )
  })

  describe('the engine runs INSIDE the pane shell (`engineRunScript`), never exec\'d over it', () => {
    const run = (argv: string[]) => {
      try {
        return { status: 0, out: execFileSync(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] }).toString() }
      } catch (error) {
        const failed = error as { status: number | null; stdout: Buffer; stderr: Buffer }
        return { status: failed.status, out: `${failed.stdout}${failed.stderr}` }
      }
    }
    it('hands the engine its argv untouched, and without a terminal on stdin reports its exit status', () => {
      const argv = buildEngineLaunchArgv('claude', {}, '/bin/sh', undefined, undefined, NO_TMUX)
      // The launcher's own argv, then the "engine": `sh -c 'echo …; exit 3'` stands in for one.
      const script = [argv[0], argv[1], argv[2], 'harness-engine', '/bin/sh', '-c', 'printf "%s\\n" "args:$*"; exit 3', 'engine', 'a b', '--flag']
      const result = run(script)
      expect(result.out).toContain('args:a b --flag')
      expect(result.status).toBe(3)
      // No shell was handed over and no "this pane is a shell now" line was printed: no tty.
      expect(result.out).not.toContain('This pane is a shell now')
    })
    it('a take-over that waits says so, and starts the engine only once the other process is gone', () => {
      const folder = mkdtempSync(join(tmpdir(), 'harness-wait-engine-'))
      const binary = join(folder, 'codex')
      // /bin/sh --help succeeds on macOS but fails with Ubuntu's dash. A
      // simulated CLI needs its own help contract for the real startup probe.
      writeFileSync(binary, '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "fixture CLI"; exit 0; fi\necho "engine ran"\n', { mode: 0o755 })
      // Not a child of this process, as the terminal's is not: an unreaped child never looks gone.
      const pid = Number(execFileSync('/bin/sh', ['-c', 'sleep 1 >/dev/null 2>&1 & echo $!']).toString().trim())
      try {
        const argv = buildEngineLaunchArgv('codex', { waitForPid: { pid, name: 'Codex' } }, '/bin/sh', undefined, undefined, NO_TMUX)
        const started = Date.now()
        const result = run([argv[0], argv[1], argv[2], 'harness-engine', binary])
        expect(Date.now() - started).toBeGreaterThanOrEqual(800)
        expect(result.out).toContain('Waiting for the Codex in your terminal to finish its turn.')
        expect(result.out.indexOf('Waiting for')).toBeLessThan(result.out.indexOf('engine ran'))
        expect(result.status).toBe(0)
        // Nothing to wait for: it starts at once.
        const immediate = buildEngineLaunchArgv('codex', { waitForPid: { pid: 2 ** 22 + 7, name: 'Codex' } }, '/bin/sh', undefined, undefined, NO_TMUX)
        const immediateStarted = Date.now()
        expect(run([immediate[0], immediate[1], immediate[2], 'harness-engine', binary]).out).toContain('engine ran')
        expect(Date.now() - immediateStarted).toBeLessThan(800)
      } finally {
        try { process.kill(pid) } catch { /* gone */ }
        rmSync(folder, { recursive: true, force: true })
      }
    })
    it('a command that does not exist still ends the pane with 127, so "not installed" stays a launch failure', () => {
      const argv = buildEngineLaunchArgv('claude', {}, '/bin/sh', undefined, undefined, NO_TMUX)
      expect(run([argv[0], argv[1], argv[2], 'harness-engine', '/nowhere/claude-that-is-not-here']).status).toBe(127)
    })
    it.each([
      ['with pane options (3.0 and later)', '', 'set-option -p -t %5 @harness_engine_exit 3'],
      // tmux 2.x answers `-p` with its usage text: the mark goes on the pane's window instead.
      ['before pane options (tmux 2.x)', 'if [ "$2" = -p ]; then echo "set-option: illegal option -- p" >&2; exit 1; fi\n',
        'set-option -w -t %5 @harness_engine_exit 3'],
    ])('marks the pane with the engine\'s exit status on a tmux %s', (_tmux, refuse, mark) => {
      const folder = mkdtempSync(join(tmpdir(), 'harness-exit-mark-'))
      try {
        const tmux = join(folder, 'tmux')
        const calls = join(folder, 'calls')
        writeFileSync(tmux, `#!/bin/sh\n${refuse}printf '%s\\n' "$*" >> '${calls}'\n`, { mode: 0o755 })
        const argv = buildEngineLaunchArgv('claude', {}, '/bin/sh', undefined, undefined, tmux)
        execFileSync(argv[0], [argv[1], argv[2], 'harness-engine', '/bin/sh', '-c', 'exit 3'], {
          stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMUX_PANE: '%5' },
        }).toString()
      } catch (error) {
        expect((error as { status: number }).status).toBe(3)
      } finally {
        expect(readFileSync(join(folder, 'calls'), 'utf8').trim()).toBe(mark)
        rmSync(folder, { recursive: true, force: true })
      }
    })
    it('marks the pane with the exit status through the daemon\'s own tmux, and only then hands over a shell', () => {
      const prelude = engineFallbackPrelude('codex', '/bin/bash', '/opt/homebrew/bin/tmux')
      expect(prelude).toContain(`[ -n "\${TMUX_PANE:-}" ] && { '/opt/homebrew/bin/tmux' set-option -p -t "$TMUX_PANE" @harness_engine_exit "$harness_status"`)
      expect(prelude.indexOf('set-option')).toBeLessThan(prelude.indexOf("exec '/bin/bash'"))
      // What reached the terminal for the engine is dropped after the mark and before any shell reads it.
      expect(prelude.indexOf('set-option')).toBeLessThan(prelude.indexOf(ENGINE_INPUT_DRAIN_SH))
      expect(prelude.indexOf(ENGINE_INPUT_DRAIN_SH)).toBeLessThan(prelude.indexOf("exec '/bin/bash'"))
      expect(prelude).toContain('if [ "$harness_status" -eq 127 ]; then exit 127; fi')
      // zsh is a login shell; bash keeps its interactive rc (same rule as a terminal).
      expect(engineFallbackPrelude('codex', '/bin/zsh', null)).toContain("exec '/bin/zsh' -l\n")
      expect(engineFallbackPrelude('codex', '/bin/bash', null)).toContain("exec '/bin/bash'\n")
      expect(engineFallbackPrelude('codex', '/bin/bash', null)).not.toContain('set-option')
    })
  })

  describe('a stop is not an exit: a stopped engine is continued, never left behind', () => {
    const SHELLS = ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/dash'].filter(existsSync)
    const npmRecipe: EngineInstallRecipe = { command: 'npm install -g fixture', source: 'test fixture', executable: { names: ['fixture'], npmGlobal: true } }
    const launches: Array<[string, () => string[]]> = [
      ['claude', () => buildEngineLaunchArgv('claude', { cwd: '/work' }, '/bin/zsh', undefined, undefined, '/opt/homebrew/bin/tmux')],
      ['codex, run again after a failed startup', () => buildEngineLaunchArgv('codex', { cwd: '/work' }, '/bin/bash', undefined, undefined, '/opt/homebrew/bin/tmux')],
      ['codex without tmux', () => buildEngineLaunchArgv('codex', {}, '/bin/zsh', undefined, undefined, NO_TMUX)],
      ['an engine installed when missing', () => buildEngineLaunchArgv('claude', { installIfMissing: npmRecipe }, '/bin/zsh', undefined, undefined, '/opt/homebrew/bin/tmux')],
      ['codex installed when missing, after a take-over', () => buildEngineLaunchArgv('codex', { installIfMissing: { ...npmRecipe, executable: { names: ['codex'] } }, waitForPid: { pid: 2 ** 22 + 7, name: 'Codex' } }, '/bin/zsh', undefined, undefined, '/opt/homebrew/bin/tmux')],
      ['an engine installed first', () => buildEngineLaunchArgv('opencode', { installFirst: "curl -fsSL 'https://example.invalid/install' | bash" }, '/bin/bash', undefined, undefined, NO_TMUX)],
    ]
    const scriptOf = launchScriptOf

    it.each(launches)('%s: parses in every POSIX shell a pane may run it in', (_name, launch) => {
      const script = scriptOf(launch())
      for (const shell of SHELLS) expect(() => execFileSync(shell, ['-n', '-c', script], { stdio: ['ignore', 'pipe', 'pipe'] }), shell).not.toThrow()
    })

    it.each(launches)('%s: runs the engine, and an install, only at the top level of the script', (name, launch) => {
      // zsh gives up the whole script when a job stops inside a function, an `if`, a loop or an
      // `eval`, and bash leaves every loop around one: only a top-level run can be resumed. Every
      // block in these scripts indents its body, so a run in one would not start the line.
      const lines = scriptOf(launch()).split('\n')
      const runs = lines.filter((line) => /"\$harness_engine_bin"(?: \$\{harness_codex_no_daemon:\+--no-daemon\})? "\$@" \|\| harness_status=\$\?$/.test(line.trim()))
      expect(runs.length).toBe(name.startsWith('codex, run again') || name.startsWith('codex installed') ? 4 : 1)
      for (const run of runs) expect(run).toMatch(/^(?:\[ "\$harness_codex_go" != 1 \] \|\| )?"\$harness_engine_bin"/)
      for (const install of lines.filter((line) => line.includes('eval '))) expect(install).toMatch(/^(?:\[ -n "\$harness_engine_bin" \] \|\| )?\((?:export npm_config_prefix=.*; )?eval /)
      // What follows each run is the resume, at the top level too.
      for (const run of runs) expect(lines[lines.indexOf(run) + 1]).toBe('harness_resume')
    })

    // The stop signals' numbers differ between macOS and Linux; dash's `kill -l` takes no names, so
    // these come from Node's table for this platform.
    const tstp = constants.signals.SIGTSTP
    const stop = constants.signals.SIGSTOP
    // `fg` and `jobs` need a terminal; these stand-ins count the stops and report each like the
    // shell's own would: 128 + TSTP while the engine keeps stopping, then its exit status.
    const ttou = constants.signals.SIGTTOU
    const resume = (shell: string, status: number, stops: number, job = true, { again = tstp, before = '' } = {}) => execFileSync(shell, ['-c', `${engineFallbackPrelude('claude', shell, null)}
stops=${stops}; resumed=0
jobs() { ${job ? 'return 0' : 'return 1'}; }
fg() { resumed=$((resumed + 1)); stops=$((stops - 1)); if [ "$stops" -gt 0 ]; then return ${128 + again}; fi; return 7; }
${before}
harness_status=${status}
harness_resume
printf '%s %s' "$harness_status" "$resumed"`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

    it.each(SHELLS)('%s: continues a stopped engine as often as it stops, and keeps its real exit status', (shell) => {
      expect(resume(shell, 128 + tstp, 1)).toBe('7 1')
      expect(resume(shell, 128 + tstp, 3)).toBe('7 3')
      expect(resume(shell, 128 + stop, 2)).toBe('7 2')
    })

    it.each(SHELLS)('%s: leaves an engine that exited alone, and a job it did not start', (shell) => {
      expect(resume(shell, 0, 1)).toBe('0 0')
      expect(resume(shell, 3, 1)).toBe('3 0')
      // An engine killed by a signal, or one that exits with a stop's number: not a stop.
      expect(resume(shell, 128 + 15, 1)).toBe(`${128 + 15} 0`)
      expect(resume(shell, tstp, 1)).toBe(`${tstp} 0`)
      // A stop's status with no job to continue (a rc file's job is not the engine): nothing to resume.
      expect(resume(shell, 128 + tstp, 1, false)).toBe(`${128 + tstp} 0`)
    })

    it.each(SHELLS)('%s: lets an engine that stops again at once wait a second between resumes, so nothing spins', (shell) => {
      // Six stops, each within a second of its resume: three resumed at once, the rest after a pause.
      const started = Date.now()
      expect(resume(shell, 128 + tstp, 6)).toBe('7 6')
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_000)
    }, 20_000)

    it.each(SHELLS)('%s: ends an engine that cannot keep the terminal after five quick tries', (shell) => {
      // TTOU over and over: the job is never let have the terminal (as when `fg` could not hand it over).
      expect(resume(shell, 128 + ttou, 50, true, { again: ttou })).toBe('137 5')
    }, 20_000)

    it.each(SHELLS)('%s: ends an engine at its thousandth stop where the resume calls itself, and only there', (shell) => {
      // bash and dash recurse once a stop, and overflow some ten thousand deep; zsh loops.
      const atTheEnd = { before: 'harness_resumes=998' }
      expect(resume(shell, 128 + tstp, 5, true, atTheEnd)).toBe(shell === '/bin/zsh' ? '7 5' : '137 1')
    })
  })

  describe('Codex writer ownership', () => {
    it.each(['supported', 'older', 'failed'] as const)('probes %s startup options without changing prompt arguments', mode => {
      const folder = mkdtempSync(join(tmpdir(), 'harness-codex-launch-'))
      try {
        const binary = join(folder, 'codex fixture')
        writeFileSync(binary, '#!/bin/sh\nif [ "$1" = "--help" ]; then\n'
          + (mode === 'failed' ? 'exit 2\n' : `printf '%s\\n' '${mode === 'supported' ? '  --no-daemon  Run locally' : '  --model  Choose a model'}'\nexit 0\n`)
          + 'fi\nprintf "<%s>\\n" "$@"\n', { mode: 0o755 })
        const script = buildEngineLaunchArgv('codex', {}, '/bin/sh', undefined, undefined, NO_TMUX)[2]
        const args = ['-c', script, 'harness-engine', binary, 'resume', 'same-conversation', 'literal $(nothing) `nothing` and spaces']
        if (mode === 'failed') {
          try { execFileSync('/bin/sh', args, { stdio: ['ignore', 'pipe', 'pipe'] }); expect.fail('launch must refuse an unknown startup mode') }
          catch (error) {
            expect((error as any).status).toBe(1)
            expect(String((error as any).stderr)).toContain('could not verify Codex startup options')
            expect(String((error as any).stdout)).not.toContain('same-conversation')
          }
        } else {
          const output = execFileSync('/bin/sh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
          expect(output).toBe(`${mode === 'supported' ? '<--no-daemon>\n' : ''}<resume>\n<same-conversation>\n<literal $(nothing) \`nothing\` and spaces>\n`)
        }
      } finally { rmSync(folder, { recursive: true, force: true }) }
    })
  })

  describe('a terminal (engine `terminal`)', () => {
    it('is the login shell itself behind a non-interactive wrapper that only raises the limit and enters the folder', () => {
      expect(buildEngineLaunchArgv('terminal', { cwd: '/work/project' }, '/bin/zsh')).toEqual([
        '/bin/zsh', '-c',
        `${RAISE_OPEN_FILES_SH}if ! cd -- "$1"; then printf '%s\\n' 'harness: the selected working directory is unavailable.' >&2; fi\nshift\nexec "$@"`,
        'harness-terminal', '/work/project', '/bin/zsh', '-l',
      ])
    })

    it('gives bash no login flag (its rc file is where Ubuntu keeps PATH edits), and no folder means no cd', () => {
      expect(buildEngineLaunchArgv('terminal', {}, '/bin/bash')).toEqual([
        '/bin/bash', '-c', `${RAISE_OPEN_FILES_SH}shift\nexec "$@"`, 'harness-terminal', '', '/bin/bash',
      ])
    })

    it('falls back to /bin/sh rather than to an engine command when no shell resolves', () => {
      expect(buildEngineLaunchArgv('terminal', {}, 'relative-shell')).toEqual([
        '/bin/sh', '-c', `${RAISE_OPEN_FILES_SH}shift\nexec "$@"`, 'harness-terminal', '', '/bin/sh',
      ])
    })

    it('ignores every engine option: nothing to bypass, resume, prompt or install', () => {
      const argv = buildEngineLaunchArgv('terminal', {
        cwd: '/w', bypassPermission: true, resumeSessionId: 'abc', firstPrompt: 'hi', extraArgs: ['--x'],
      }, '/bin/zsh')
      expect(argv.slice(-2)).toEqual(['/bin/zsh', '-l'])
      expect(argv.join(' ')).not.toContain('abc')
      expect(argv.join(' ')).not.toContain('--x')
    })

    it('is a script a real shell accepts and that keeps a cd failure from ending the terminal', () => {
      const script = buildEngineLaunchArgv('terminal', { cwd: '/nowhere/at/all' }, '/bin/sh')[2]
      expect(() => execFileSync('/bin/sh', ['-n', '-c', script])).not.toThrow()
      // The wrapper's `exec "$@"` runs the shell handed in argv; `true` in its place proves the
      // wrapper reaches the exec even when the cd failed (the terminal still opens, at $HOME).
      const out = execFileSync('/bin/sh', ['-c', script, 'harness-terminal', '/nowhere/at/all', '/bin/sh', '-c', 'echo reached'], { stdio: ['ignore', 'pipe', 'pipe'] })
      expect(out.toString()).toContain('reached')
    })

    it('greets every new tile with the banner — wordmark, where it is, agents, `harness remote` — before its prompt', () => {
      const argv = buildEngineLaunchArgv('terminal', { terminalHint: { machineName: 'MacbookPro.local' } }, '/bin/sh')
      expect(argv.slice(3)).toEqual(['harness-terminal', '', '/bin/sh'])
      expect(() => execFileSync('/bin/sh', ['-n', '-c', argv[2]])).not.toThrow()
      const run = (): string => execFileSync('/bin/sh', ['-c', argv[2], 'harness-terminal', '', '/bin/sh', '-c', 'echo prompt'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
      // Every time, not once per machine: a new tile is a new person at a new prompt.
      for (const out of [run(), run()]) {
        // Every line as drawn — the wordmark's backslashes and backtick included.
        expect(out).toContain(terminalHintLines('MacbookPro.local').join('\n'))
        expect(out).toContain('  Terminal on MacbookPro.local')
        expect(out).toContain('harness remote')
        expect(out.trim().endsWith('prompt')).toBe(true)
      }
    })

    it('opens OS terminals directly at the shell prompt', () => {
      vi.stubEnv('HARNESS_OS', '1')
      try {
        const argv = buildEngineLaunchArgv('terminal', { terminalHint: { machineName: 'programmer-os' } }, '/bin/sh')
        const out = execFileSync('/bin/sh', ['-c', argv[2], 'harness-terminal', '', '/bin/sh', '-c', 'echo prompt']).toString()
        expect(out).toBe('prompt\n')
      } finally { vi.unstubAllEnvs() }
    })

    it('the banner names the machine, falls back to "this machine", and fits an 80-column pane unwrapped', () => {
      expect(terminalHintLines('  ')).toContain('  Terminal on this machine')
      for (const line of terminalHintLines('office-imac')) expect(line.length).toBeLessThanOrEqual(78)
      // A hostname longer than the line has room for is cut, never wrapped.
      const long = terminalHintLines('a'.repeat(120))
      for (const line of long) expect(line.length).toBeLessThanOrEqual(78)
      expect(long.find((line) => line.startsWith('  Terminal on'))).toMatch(/^  Terminal on a{61}…$/)
      // A blank line first and last: the wordmark does not sit on the pane's top edge, nor the prompt on the guide.
      const lines = terminalHintLines('office-imac')
      expect([lines[0], lines[lines.length - 1]]).toEqual(['', ''])
    })

    it('the wordmark is the one the installer prints, line for line', () => {
      // install.sh's print_logo, run for real: what a person sees at the end of an install is what a
      // tile shows them next — two copies, held to one drawing.
      const installer = readFileSync(join(process.cwd(), 'scripts', 'install.sh'), 'utf8')
      const printLogo = installer.slice(installer.indexOf('print_logo() {'), installer.indexOf('\n}\n', installer.indexOf('print_logo() {')) + 3)
      const printed = execFileSync('/bin/sh', ['-c', `${printLogo}\nprint_logo`], { encoding: 'utf8' }).split('\n').filter((line) => line.trim() !== '')
      expect(printed).toEqual([...HARNESS_WORDMARK_LINES])
    })

    it('with no guide asked for (restore, restart, a test) the pane says nothing before its prompt', () => {
      const script = buildEngineLaunchArgv('terminal', {}, '/bin/sh')[2]
      expect(script).not.toContain('harness remote')
      expect(script).not.toContain('Terminal on')
    })
  })

  it('hands the engine a soft open-files limit fit for it, however low the pane started', async () => {
    // A tmux server started by the desktop app passes launchd's 256 to every pane; Claude Code will
    // not start under that. The pane's own shell lifts it before exec, so the server never has to.
    const [shell, flag, paneScript] = buildEngineLaunchArgv('claude', {}, '/bin/sh')
    const { execFile } = await import('node:child_process')
    const seenByEngine = await new Promise<string>((resolve, reject) => {
      execFile(
        '/bin/sh',
        ['-c', 'ulimit -S -n 256 || exit 99; exec "$@"', 'pane', shell, flag, paneScript, 'harness-engine', '/bin/sh', '-c', 'ulimit -S -n'],
        { timeout: 10_000 },
        (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout.trim())),
      )
    })
    expect(seenByEngine).not.toBe('256')
    expect(seenByEngine === 'unlimited' || Number(seenByEngine) >= Math.min(MIN_OPEN_FILES, 4096)).toBe(true)
  })

  describe('an unreadable workspace', () => {
    // Under /bin/sh, with the engine replaced by printf so its run leaves a marker.
    async function launchInto(dir: string): Promise<{ code: number; stdout: string; stderr: string }> {
      const [, , paneScript] = buildEngineLaunchArgv('claude', { cwd: dir }, '/bin/sh')
      const { execFile } = await import('node:child_process')
      return await new Promise((resolve) => {
        execFile(
          '/bin/sh',
          ['-c', paneScript, 'harness-engine', dir, '/usr/bin/printf', 'ENGINE_RAN\n'],
          { timeout: 10_000 },
          (error, stdout, stderr) => {
            const code = error && typeof (error as { code?: unknown }).code === 'number'
              ? (error as unknown as { code: number }).code
              : 0
            resolve({ code, stdout, stderr })
          },
        )
      })
    }

    // root reads everything, so the guard has nothing to catch there.
    const notRoot = process.getuid?.() !== 0

    it.skipIf(!notRoot)('says why and stops instead of letting the engine fail on its first read', async () => {
      // Enterable but not readable: what macOS privacy settings (TCC) produce for a folder the
      // responsible app was not granted — `cd` works, the first readdir does not.
      const dir = mkdtempSync(join(tmpdir(), 'harness-unreadable-'))
      try {
        chmodSync(dir, 0o300)
        const result = await launchInto(dir)
        expect(result.code).toBe(1)
        expect(result.stdout).not.toContain('ENGINE_RAN')
        expect(result.stderr).toContain(`harness: cannot read ${dir}`)
      } finally {
        chmodSync(dir, 0o700)
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('launches the engine when the workspace is readable', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'harness-readable-'))
      try {
        const result = await launchInto(dir)
        expect(result.code).toBe(0)
        expect(result.stdout).toContain('ENGINE_RAN')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    // Both hints are pushed through a real /bin/sh, whatever platform runs the suite: the quoting
    // of the macOS text (a backtick-free command, `›`, `—`) is what a Linux runner would otherwise
    // never exercise.
    async function guardOutput(platform: NodeJS.Platform, dir: string): Promise<string> {
      const { execFile } = await import('node:child_process')
      return await new Promise((resolve) => {
        execFile(
          '/bin/sh',
          ['-c', `cd -- "$1" || exit 9\n${unreadableCwdGuard(platform)}echo ENGINE_RAN`, 'guard', dir],
          { timeout: 10_000 },
          (_error, stdout, stderr) => resolve(stdout + stderr),
        )
      })
    }

    it.skipIf(!notRoot)('points at the privacy settings on macOS and at permissions elsewhere', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'harness-unreadable-hint-'))
      try {
        chmodSync(dir, 0o300)
        const darwin = await guardOutput('darwin', dir)
        expect(darwin).toContain('Full Disk Access')
        expect(darwin).toContain('tmux kill-server')
        expect(darwin).toContain('Privacy & Security')
        expect(darwin).not.toContain('ENGINE_RAN')
        const linux = await guardOutput('linux', dir)
        expect(linux).toContain('permissions')
        expect(linux).not.toContain('Privacy & Security')
        expect(linux).not.toContain('ENGINE_RAN')
      } finally {
        chmodSync(dir, 0o700)
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('keeps the action inside what a relayed pane summary can show', () => {
      // First hint line: what to do. It has to survive next to a folder path in a ~180-char summary.
      const firstHint = unreadableCwdGuard('darwin').match(/'(harness: on macOS[^']*)'/)?.[1] ?? ''
      expect(firstHint.length).toBeGreaterThan(0)
      expect(firstHint.length).toBeLessThanOrEqual(120)
    })
  })

  it('a DSH agent gets Harness\'s Node at the end of a PATH that has none; a plain launch is unchanged', () => {
    const argv = buildEngineLaunchArgv('claude', { harnessNode: true }, '/bin/zsh', '/opt/harness runtime/bin/node', undefined, NO_TMUX)
    // On this branch every pane script opens with the open-files raise, the engine-in-a-shell
    // wrapper and the grid prelude; the Node line lands after them, and a launch without
    // `harnessNode` is exactly the baseline above.
    expect(launchScriptOf(argv)).toBe(`${RAISE_OPEN_FILES_SH}${FALLBACK('claude', '/bin/zsh')}${GRID_PRELUDE}${harnessNodePrelude('/opt/harness runtime/bin/node')}${RUN}`)
    expect(harnessNodePrelude('/opt/harness runtime/bin/node')).toBe(
      'if ! command -v node >/dev/null 2>&1; then PATH="${PATH:+$PATH:}"\'/opt/harness runtime/bin\'; export PATH; fi\n')
    expect(launchScriptOf(buildEngineLaunchArgv('claude', { harnessNode: false }, '/bin/zsh', undefined, undefined, NO_TMUX))).toBe(`${RAISE_OPEN_FILES_SH}${FALLBACK('claude', '/bin/zsh')}${GRID_PRELUDE}${RUN}`)
  })

  it('the DSH prelude, run by a real shell, reaches the engine\'s PATH only when node is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'harness-node-prelude-'))
    try {
      const runtimeBin = join(home, 'runtime', 'bin')
      mkdirSync(runtimeBin, { recursive: true })
      writeFileSync(join(runtimeBin, 'node'), '#!/bin/sh\n', { mode: 0o755 })
      const run = (path: string) => {
        const argv = buildEngineLaunchArgv('claude', { harnessNode: true }, '/bin/sh', join(runtimeBin, 'node'))
        const script = argv[2]
        return execFileSync('/bin/sh', ['-c', script, 'harness-engine', '/bin/sh', '-c', 'echo "$PATH"; command -v node'], {
          env: { HOME: home, PATH: path }, encoding: 'utf8',
        }).trim().split('\n')
      }
      expect(run('/usr/bin:/bin')).toEqual([`/usr/bin:/bin:${runtimeBin}`, join(runtimeBin, 'node')])
      const own = join(home, 'own')
      mkdirSync(own)
      writeFileSync(join(own, 'node'), '#!/bin/sh\n', { mode: 0o755 })
      expect(run(`${own}:/usr/bin:/bin`)).toEqual([`${own}:/usr/bin:/bin`, join(own, 'node')])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('falls back to direct execution when no absolute shell is available', () => {
    expect(buildEngineLaunchArgv('claude', {}, '')).toEqual([engineBin('claude')])
    expect(buildEngineLaunchArgv('claude', {}, 'zsh')).toEqual([engineBin('claude')])
  })

  it('appends the confirmed flag for engines with a known bypass flag', () => {
    expect(buildEngineCommandArgv('claude', { bypassPermission: true }))
      .toEqual([engineBin('claude'), '--permission-mode', 'auto'])
    expect(buildEngineCommandArgv('codex', { bypassPermission: true }))
      .toEqual([engineBin('codex'), '--approve-for-me'])
    expect(buildEngineCommandArgv('cursor', { bypassPermission: true }))
      .toEqual([engineBin('cursor'), '--force'])
    expect(buildEngineCommandArgv('opencode', { bypassPermission: true }))
      .toEqual([engineBin('opencode'), '--auto'])
  })

  it('launches each permission mode with its own flags, and a mode outranks bypassPermission', () => {
    expect(buildEngineCommandArgv('claude', { permissionMode: 'plan' }))
      .toEqual([engineBin('claude'), '--permission-mode', 'plan'])
    expect(buildEngineCommandArgv('claude', { permissionMode: 'acceptEdits', bypassPermission: true }))
      .toEqual([engineBin('claude'), '--permission-mode', 'acceptEdits'])
    expect(buildEngineCommandArgv('claude', { permissionMode: 'ask', bypassPermission: true }))
      .toEqual([engineBin('claude')])
    expect(buildEngineCommandArgv('claude', { permissionMode: 'full' }))
      .toEqual([engineBin('claude'), '--dangerously-skip-permissions'])
    expect(buildEngineCommandArgv('codex', { permissionMode: 'readOnly' }))
      .toEqual([engineBin('codex'), '--sandbox', 'read-only'])
    expect(buildEngineCommandArgv('codex', { permissionMode: 'full' }))
      .toEqual([engineBin('codex'), '--dangerously-bypass-approvals-and-sandbox'])
    // A mode the engine lacks falls back to the yes/no.
    expect(buildEngineCommandArgv('opencode', { permissionMode: 'plan', bypassPermission: true }))
      .toEqual([engineBin('opencode'), '--auto'])
    expect(buildEngineCommandArgv('pi', { permissionMode: 'auto' })).toEqual([engineBin('pi')])
  })

  it('makes auto the same flags as bypassPermission, for every engine with modes', () => {
    for (const [engine, modes] of Object.entries(PERMISSION_MODES)) {
      expect(modes?.auto, engine).toEqual(BYPASS_PERMISSION_FLAGS[engine as keyof typeof BYPASS_PERMISSION_FLAGS])
      expect(modes?.ask, engine).toEqual([])
    }
  })

  it('is a no-op for engines with no confirmed flag, even when bypass is requested', () => {
    expect(buildEngineCommandArgv('pi', { bypassPermission: true })).toEqual([engineBin('pi')])
    expect(buildEngineCommandArgv('hermes', { bypassPermission: true })).toEqual([engineBin('hermes')])
  })

  it('has an entry (possibly null) for every known engine — no engine silently falls through', () => {
    for (const engine of ENGINES) {
      expect(Object.prototype.hasOwnProperty.call(BYPASS_PERMISSION_FLAGS, engine)).toBe(true)
    }
  })

  it('appends a flag-style resume argument after the binary', () => {
    expect(buildEngineCommandArgv('claude', { resumeSessionId: 'abc-123' }))
      .toEqual([engineBin('claude'), '--resume', 'abc-123'])
    expect(buildEngineCommandArgv('opencode', { resumeSessionId: 'ses_1' }))
      .toEqual([engineBin('opencode'), '--session', 'ses_1'])
  })

  it('puts a subcommand-style resume FIRST, ahead of any other flag', () => {
    expect(buildEngineCommandArgv('codex', { resumeSessionId: 'abc-123' }))
      .toEqual([engineBin('codex'), 'resume', 'abc-123'])
    expect(buildEngineCommandArgv('codex', { resumeSessionId: 'abc-123', bypassPermission: true }))
      .toEqual([engineBin('codex'), 'resume', 'abc-123', '--approve-for-me'])
    expect(buildEngineCommandArgv('amp', { resumeSessionId: 'T-1' }))
      .toEqual([engineBin('amp'), 'threads', 'continue', 'T-1'])
  })

  it('still applies bypassPermission with no resume requested (regression)', () => {
    expect(buildEngineCommandArgv('claude', { bypassPermission: true }))
      .toEqual([engineBin('claude'), '--permission-mode', 'auto'])
  })

  it('resumes devin by its session slug (docs.devin.ai/cli, since 2026.4.17)', () => {
    expect(buildEngineCommandArgv('devin', { resumeSessionId: 'brisk-otter' })).toEqual([engineBin('devin'), '--resume', 'brisk-otter'])
  })

  it('has a launch resume flag for every engine RESUME_ARGS also covers, plus claude/codex', () => {
    for (const engine of ['claude', 'codex', 'cursor', 'opencode', 'kilo', 'pi', 'hermes', 'commandcode',
      'muse', 'amp', 'grok', 'agy', 'copilot', 'devin'] as const) {
      expect(LAUNCH_RESUME_FLAG[engine]?.length).toBeGreaterThan(0)
    }
  })
})

describe('a login shell that is not POSIX', () => {
  let dataDir = ''
  let savedDataDir = ''
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'launch-shell-')); savedDataDir = env.ADAPTER_DATA_DIR; env.ADAPTER_DATA_DIR = dataDir })
  afterEach(() => { env.ADAPTER_DATA_DIR = savedDataDir; rmSync(dataDir, { recursive: true, force: true }) })

  it('tells the POSIX shells from the rest by name', () => {
    for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh', '/usr/bin/dash', '/bin/ksh', '/usr/local/bin/mksh', '/bin/ash', '/usr/bin/yash']) expect(isPosixShell(shell), shell).toBe(true)
    for (const shell of ['/usr/local/bin/fish', '/bin/tcsh', '/bin/csh', '/opt/homebrew/bin/nu', '/usr/bin/xonsh', '/usr/bin/elvish']) expect(isPosixShell(shell), shell).toBe(false)
  })

  it('asks each its own way for the person\'s interactive startup files', () => {
    expect(interactiveEngineShell('/bin/zsh')?.args).toEqual(['-lic'])
    expect(interactiveEngineShell('/bin/bash')?.args).toEqual(['-ic'])
    expect(interactiveEngineShell('/usr/bin/dash')?.args).toEqual(['-ic'])
    expect(interactiveEngineShell('/usr/local/bin/fish')).toMatchObject({ args: ['-i', '-c'], label: 'fish shell' })
    expect(interactiveEngineShell('/bin/tcsh')?.args).toEqual(['-i', '-c'])
    expect(interactiveEngineShell('/opt/homebrew/bin/nu')?.args).toEqual(['-c'])
  })

  it('launches an engine through the shell, which hands a one-time POSIX script to dash, or else /bin/sh', () => {
    const argv = buildEngineLaunchArgv('claude', { cwd: "/work/it's here" }, '/usr/local/bin/fish', '/opt/node/bin/node', '/opt/grid/bin/grid', '/usr/bin/tmux')
    expect(argv.slice(0, 3)).toEqual(['/usr/local/bin/fish', '-i', '-c'])
    expect(argv).toHaveLength(4)
    // dash, where there is one: run like this it still resumes an engine that stopped (bash as sh does not).
    expect(argv[3].startsWith(`exec ${existsSync('/bin/dash') ? '/bin/dash' : '/bin/sh'} '`)).toBe(true)
    const file = /^exec \/bin\/(?:da)?sh '(.+)'$/.exec(argv[3])?.[1]
    expect(file && file.startsWith(join(dataDir, 'launch'))).toBe(true)
    const script = readFileSync(file!, 'utf8')
    // It removes itself first, then takes the arguments a POSIX shell would have been given.
    expect(script.startsWith(`rm -f -- '${file}'\nset -- '/work/it'"'"'s here' '${engineBin('claude')}'`)).toBe(true)
    expect(script).toContain(RUN_LINE)
    // zsh runs its own: it sources the file itself, with the arguments on its command line.
    const zsh = buildEngineLaunchArgv('claude', { cwd: '/work' }, '/bin/zsh', '/opt/node/bin/node', '/opt/grid/bin/grid', '/usr/bin/tmux')
    expect(zsh.slice(0, 4)).toEqual(['/usr/bin/env', 'DISABLE_AUTO_UPDATE=true', '/bin/zsh', '-lic'])
    expect(zsh[4]).toMatch(SOURCED)
  })

  it.skipIf(!existsSync('/bin/tcsh'))('runs that script for real under tcsh, with its arguments intact and the file gone', () => {
    const argv = buildEngineLaunchArgv('claude', { cwd: dataDir, installFirst: undefined }, '/bin/tcsh', '/opt/node/bin/node', '/opt/grid/bin/grid', null)
    const file = /^exec \/bin\/(?:da)?sh '(.+)'$/.exec(argv[argv.length - 1])![1]
    // Run the file the way tcsh would hand it over, with the engine replaced by printf.
    writeFileSync(file, readFileSync(file, 'utf8').replace(RUN_LINE, 'printf "%s|" "$PWD" "$harness_engine_bin" "$@"'))
    const out = execFileSync('/bin/tcsh', ['-i', '-c', argv[argv.length - 1]], { encoding: 'utf8', env: { ...process.env, HOME: dataDir }, stdio: ['ignore', 'pipe', 'ignore'] })
    expect(out).toContain(`${dataDir}|${engineBin('claude')}|`)
    expect(existsSync(file)).toBe(false)
  })

  it('opens a terminal tile with /bin/sh entering the folder, then the person\'s own shell', () => {
    expect(buildTerminalLaunchArgv({ cwd: '/work' }, '/usr/local/bin/fish')).toEqual(['/bin/sh', '-c', expect.stringContaining('exec "$@"'), 'harness-terminal', '/work', '/usr/local/bin/fish'])
    expect(buildTerminalLaunchArgv({ cwd: '/work' }, '/bin/zsh').slice(0, 2)).toEqual(['/bin/zsh', '-c'])
  })
})

describe('a first prompt on launch', () => {
  const PROMPT = 'Start a local model on this machine'

  it('hands opencode the text through its TUI flag', () => {
    expect(buildEngineCommandArgv('opencode', { firstPrompt: PROMPT }))
      .toEqual([engineBin('opencode'), '--prompt', PROMPT])
  })

  it('hands claude and codex the text positionally', () => {
    expect(buildEngineCommandArgv('claude', { firstPrompt: PROMPT })).toEqual([engineBin('claude'), PROMPT])
    expect(buildEngineCommandArgv('codex', { firstPrompt: PROMPT })).toEqual([engineBin('codex'), PROMPT])
  })

  it('hands hermes the text as the first turn of an interactive chat, after a resume', () => {
    // `hermes chat -q` on a TTY seeds the session and keeps the TUI open (measured on a live pane).
    expect(buildEngineCommandArgv('hermes', { firstPrompt: PROMPT }))
      .toEqual([engineBin('hermes'), 'chat', '-q', PROMPT])
    // Global flags stay ahead of the subcommand, where hermes's parser reads them.
    expect(buildEngineCommandArgv('hermes', { resumeSessionId: 'abc', firstPrompt: PROMPT }))
      .toEqual([engineBin('hermes'), '--resume', 'abc', 'chat', '-q', PROMPT])
  })

  it('puts the text LAST, after every flag, so a positional is never read as an option value', () => {
    expect(buildEngineCommandArgv('claude', { firstPrompt: PROMPT, bypassPermission: true, extraArgs: ['--allowedTools=WebSearch'] }))
      .toEqual([engineBin('claude'), '--permission-mode', 'auto', '--allowedTools=WebSearch', PROMPT])
    expect(buildEngineCommandArgv('opencode', { firstPrompt: PROMPT, bypassPermission: true, extraArgs: ['-m', 'local/qwen'] }))
      .toEqual([engineBin('opencode'), '--auto', '-m', 'local/qwen', '--prompt', PROMPT])
  })

  it('refuses an engine with no documented mechanism, naming the engine, rather than dropping the text', () => {
    expect(supportsFirstPrompt('cursor')).toBe(false)
    expect(() => firstPromptArgs('cursor', PROMPT)).toThrow(FirstPromptUnsupportedError)
    let refusal: unknown
    try { buildEngineCommandArgv('cursor', { firstPrompt: PROMPT }) } catch (error) { refusal = error }
    expect(refusal).toBeInstanceOf(FirstPromptUnsupportedError)
    expect((refusal as FirstPromptUnsupportedError).code).toBe('PROMPT_UNSUPPORTED')
    expect((refusal as FirstPromptUnsupportedError).message).toContain('cursor')
  })

  it('leaves the argv unchanged with no prompt, or an empty one', () => {
    expect(buildEngineCommandArgv('opencode', {})).toEqual([engineBin('opencode')])
    expect(buildEngineCommandArgv('opencode', { firstPrompt: '' })).toEqual([engineBin('opencode')])
    expect(buildEngineCommandArgv('cursor', { firstPrompt: '' })).toEqual([engineBin('cursor')])
  })

  it('reaches the engine as ONE positional argument through the pane shell, however it is spelled', async () => {
    // The pane script execs "$@": the prompt must arrive as a single argv entry, spaces, quotes and
    // all, rather than being re-split by the shell.
    const spelled = `Start a local model on "this" machine; it's $HOME`
    const [, , paneScript, marker, ...command] = buildEngineLaunchArgv('claude', { firstPrompt: spelled }, '/bin/sh')
    expect(marker).toBe('harness-engine')
    expect(command).toEqual([engineBin('claude'), spelled])
    const { execFile } = await import('node:child_process')
    const seen = await new Promise<string>((resolve, reject) => {
      execFile('/bin/sh', ['-c', paneScript, 'harness-engine', '/bin/sh', '-c', 'printf "%s" "$1"', 'engine', spelled],
        { timeout: 10_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
    })
    expect(seen).toBe(spelled)
  })

  it('has an entry (possibly null) for every known engine — no engine silently falls through', () => {
    for (const engine of ENGINES) {
      expect(Object.prototype.hasOwnProperty.call(FIRST_PROMPT_ARGS, engine)).toBe(true)
    }
    expect(supportsFirstPrompt('opencode')).toBe(true)
    expect(supportsFirstPrompt('claude')).toBe(true)
    expect(supportsFirstPrompt('codex')).toBe(true)
  })
})

describe('opening as a named agent', () => {
  it('hands opencode the name through --agent, in the extraArgs slot a relaunch also uses', () => {
    expect(namedAgentArgs('opencode', 'harness-compute')).toEqual(['--agent', 'harness-compute'])
    expect(buildEngineCommandArgv('opencode', { bypassPermission: true, extraArgs: ['-m', 'local/qwen', ...namedAgentArgs('opencode', 'harness-compute')] }))
      .toEqual([engineBin('opencode'), '--auto', '-m', 'local/qwen', '--agent', 'harness-compute'])
    // Resume keeps it too — the flag rides `extraArgs`, which every relaunch rebuilds from the row.
    expect(buildEngineCommandArgv('opencode', { resumeSessionId: 'ses_1', extraArgs: namedAgentArgs('opencode', 'harness-compute') }))
      .toEqual([engineBin('opencode'), '--session', 'ses_1', '--agent', 'harness-compute'])
  })

  it('refuses opencode v2, whose TUI has no --agent (only `opencode run` does)', () => {
    expect(supportsNamedAgent('opencode', 2)).toBe(false)
    expect(() => namedAgentArgs('opencode', 'harness-compute', 2)).toThrow(NamedAgentUnsupportedError)
    // v1, or a version not read, keeps the flag it always had.
    expect(supportsNamedAgent('opencode', 1)).toBe(true)
    expect(supportsNamedAgent('opencode', null)).toBe(true)
  })

  it('refuses every other engine, naming it, rather than dropping the name', () => {
    for (const engine of ENGINES) {
      if (engine === 'opencode') continue
      expect(supportsNamedAgent(engine)).toBe(false)
      let refusal: unknown
      try { namedAgentArgs(engine, 'harness-compute') } catch (error) { refusal = error }
      expect(refusal).toBeInstanceOf(NamedAgentUnsupportedError)
      expect((refusal as NamedAgentUnsupportedError).code).toBe('AGENT_UNSUPPORTED')
      expect((refusal as NamedAgentUnsupportedError).message).toContain(engine)
    }
  })

  it('has an entry (possibly null) for every known engine — no engine silently falls through', () => {
    for (const engine of ENGINES) {
      expect(Object.prototype.hasOwnProperty.call(NAMED_AGENT_ARGS, engine)).toBe(true)
    }
    expect(supportsNamedAgent('opencode')).toBe(true)
  })

  it('accepts an identifier and nothing that could be a path or prose', () => {
    for (const ok of ['harness-compute', 'build', 'A_b-1', 'x'.repeat(64)]) expect(AGENT_NAME_RE.test(ok)).toBe(true)
    for (const bad of ['', ' harness-compute', 'local model', '../etc', 'a/b', 'name.md', 'x'.repeat(65), 'nämn']) {
      expect(AGENT_NAME_RE.test(bad)).toBe(false)
    }
  })
})

const dirs: string[] = []
const originalProbePath = process.env.HARNESS_ENGINE_TEST_PATH

afterEach(() => {
  if (originalProbePath === undefined) delete process.env.HARNESS_ENGINE_TEST_PATH
  else process.env.HARNESS_ENGINE_TEST_PATH = originalProbePath
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function executable(dir: string, name: string): string {
  const path = join(dir, name)
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o700)
  return path
}

function bashProbeShell(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-engine-shell-'))
  dirs.push(dir)
  const shell = join(dir, 'bash')
  writeFileSync(shell, `#!/bin/sh
[ "$1" = '-ic' ] || exit 97
shift
script="$1"
shift
PATH="$HARNESS_ENGINE_TEST_PATH"
export PATH
exec /bin/sh -c "$script" "$@"
`)
  chmodSync(shell, 0o700)
  return shell
}

/** The real zsh, if this machine has one. macOS always does; a Linux CI box may not. */
const ZSH = ['/bin/zsh', '/usr/bin/zsh'].find((path) => existsSync(path)) ?? null

/**
 * A probe shell that hands the script to the REAL zsh. `bashProbeShell` runs everything through
 * `/bin/sh` and so cannot see a zsh-only parse rule — and zsh is what macOS defaults $SHELL to,
 * i.e. the shell the capability probe actually runs under for most users. Plain `-c` rather than
 * zsh's interactive form keeps the case hermetic: no developer's rc file gets a say in the result.
 */
function zshProbeShell(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-engine-zsh-shell-'))
  dirs.push(dir)
  // Named `zsh` so interactiveEngineShell hands it zsh's own `-lic`, exactly as it would $SHELL.
  const shell = join(dir, 'zsh')
  writeFileSync(shell, `#!/bin/sh
[ "$1" = '-lic' ] || exit 97
shift
script="$1"
shift
PATH="$HARNESS_ENGINE_TEST_PATH"
export PATH
exec ${ZSH} -c "$script" "$@"
`)
  chmodSync(shell, 0o700)
  return shell
}

describe('commandAvailableInInteractiveShell', () => {
  it('uses the same bash interactive PATH that launches a new engine', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'harness-engine-bin-'))
    dirs.push(binDir)
    executable(binDir, 'kilo')
    process.env.HARNESS_ENGINE_TEST_PATH = binDir

    await expect(commandAvailableInInteractiveShell('kilo', bashProbeShell())).resolves.toBe(true)
    await expect(commandAvailableInInteractiveShell('missing-engine', bashProbeShell())).resolves.toBe(false)
  })

  it('recognizes an installed vendor path before the shell profile has it on PATH', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'harness-engine-vendor-bin-'))
    dirs.push(binDir)
    const installed = executable(binDir, 'cursor-agent')
    process.env.HARNESS_ENGINE_TEST_PATH = '/usr/bin:/bin'
    const recipe: EngineInstallRecipe = {
      command: 'false',
      source: 'test fixture',
      executable: { names: ['cursor-agent'], absolutePaths: [installed] },
    }

    await expect(
      commandAvailableInInteractiveShell('cursor-agent', bashProbeShell(), recipe),
    ).resolves.toBe(true)
  })
})

/** A fake engine whose `--help` prints exactly `help`, and nothing else. */
function fakeEngine(dir: string, name: string, help: string): void {
  writeFileSync(join(dir, name), `#!/bin/sh\nif [ "$1" = "--help" ]; then printf "%s\\n" '${help}'; exit 0; fi\nexit 2\n`)
  chmodSync(join(dir, name), 0o700)
}

describe('the permission gates', () => {
  /** A fake opencode on the probe shell's PATH, and the shell that will find it. */
  function withFakeOpencode(help: string): string {
    const binDir = mkdtempSync(join(tmpdir(), 'harness-engine-gate-'))
    dirs.push(binDir)
    process.env.HARNESS_ENGINE_TEST_PATH = binDir
    fakeEngine(binDir, 'opencode', help)
    return bashProbeShell()
  }

  it('refuses a create whose engine does not take the flag, naming the engine and the flag', async () => {
    const shell = withFakeOpencode('--auto-update')
    const refusal = await refusePermissionFlagIfUnsupported('opencode', { permissionMode: 'auto' }, shell)
    expect(refusal?.error).toBe('CODEX_CLI_TOO_OLD')
    expect(refusal?.detail).toContain('opencode')
    expect(refusal?.detail).toContain('--auto')
  })

  it('lets a create through when the flag is there, and when there is no flag to check', async () => {
    const shell = withFakeOpencode('--auto')
    await expect(refusePermissionFlagIfUnsupported('opencode', { permissionMode: 'auto' }, shell)).resolves.toBeNull()
    await expect(refusePermissionFlagIfUnsupported('opencode', { permissionMode: 'ask' }, shell)).resolves.toBeNull()
  })

  it('drops the flag for a relaunch instead of refusing it, leaving the launch in Ask', async () => {
    const shell = withFakeOpencode('--auto-update')
    const dropped = await dropPermissionFlagIfUnsupported('opencode', { permissionMode: 'auto', bypassPermission: true }, shell)
    expect(dropped).toEqual({ choice: { permissionMode: 'ask', bypassPermission: false }, droppedFlag: '--auto' })
  })

  it('leaves a relaunch alone when the flag is supported', async () => {
    const shell = withFakeOpencode('--auto')
    const kept = await dropPermissionFlagIfUnsupported('opencode', { permissionMode: 'auto', bypassPermission: true }, shell)
    expect(kept).toEqual({ choice: { permissionMode: 'auto', bypassPermission: true }, droppedFlag: null })
  })
})

describe('permissionFlagToVerify', () => {
  it('names the single token a mode adds', () => {
    expect(permissionFlagToVerify('opencode', { permissionMode: 'auto' })).toBe('--auto')
    expect(permissionFlagToVerify('cursor', { permissionMode: 'auto' })).toBe('--force')
    expect(permissionFlagToVerify('codex', { permissionMode: 'auto' })).toBe('--approve-for-me')
  })

  it('reads the bypass table when no mode was recorded', () => {
    expect(permissionFlagToVerify('opencode', { bypassPermission: true })).toBe('--auto')
    expect(permissionFlagToVerify('opencode', { bypassPermission: false })).toBeNull()
  })

  // The documented limit: help never prints the pair, so only the token can be asked about, and a
  // build that lists `--permission-mode` while having dropped the `auto` VALUE is not caught here.
  it('takes the flag token of a pair, never its value', () => {
    expect(permissionModeFlags('claude', 'auto')).toEqual(['--permission-mode', 'auto'])
    expect(permissionFlagToVerify('claude', { permissionMode: 'auto' })).toBe('--permission-mode')
    expect(permissionFlagToVerify('codex', { permissionMode: 'readOnly' })).toBe('--sandbox')
  })

  it('has nothing to verify for Ask, an engine with no table, or a terminal', () => {
    expect(permissionFlagToVerify('claude', { permissionMode: 'ask' })).toBeNull()
    expect(permissionFlagToVerify('muse', { bypassPermission: true })).toBeNull()
    expect(permissionFlagToVerify('terminal', { bypassPermission: true })).toBeNull()
  })
})

describe('commandSupportsFlagInInteractiveShell', () => {
  it('distinguishes an older CLI help surface from a supported flag', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'harness-engine-capability-'))
    dirs.push(binDir)
    const codex = join(binDir, 'codex')
    writeFileSync(
      codex,
      '#!/bin/sh\nif [ "$1" = "--help" ]; then printf "%s\\n" "--sandbox"; exit 0; fi\nexit 2\n',
    )
    chmodSync(codex, 0o700)
    process.env.HARNESS_ENGINE_TEST_PATH = binDir

    await expect(
      commandSupportsFlagInInteractiveShell('codex', '--approve-for-me', bashProbeShell()),
    ).resolves.toBe('unsupported')

    writeFileSync(
      codex,
      '#!/bin/sh\nif [ "$1" = "--help" ]; then printf "%s\\n" "--approve-for-me"; exit 0; fi\nexit 2\n',
    )
    await expect(
      commandSupportsFlagInInteractiveShell('codex', '--approve-for-me', bashProbeShell()),
    ).resolves.toBe('supported')
  })

  // openharness#285: opencode 1.14.51 has no `--auto`, prints its help and exits, and the wrapper
  // hands the pane to a shell. A substring match reads `--auto-update` in a newer help as support
  // for `--auto` and launches that very pane.
  it('does not read a longer flag as the one it was asked about', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'harness-engine-boundary-'))
    dirs.push(binDir)
    process.env.HARNESS_ENGINE_TEST_PATH = binDir

    fakeEngine(binDir, 'opencode', '--auto-update   keep opencode current')
    await expect(commandSupportsFlagInInteractiveShell('opencode', '--auto', bashProbeShell()))
      .resolves.toBe('unsupported')

    fakeEngine(binDir, 'opencode', '--auto   approve automatically')
    await expect(commandSupportsFlagInInteractiveShell('opencode', '--auto', bashProbeShell()))
      .resolves.toBe('supported')
  })

  it('answers a flag that ends the help text', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'harness-engine-tail-'))
    dirs.push(binDir)
    process.env.HARNESS_ENGINE_TEST_PATH = binDir
    fakeEngine(binDir, 'cursor-agent', '--force')
    await expect(commandSupportsFlagInInteractiveShell('cursor-agent', '--force', bashProbeShell()))
      .resolves.toBe('supported')
  })

  // Every relaunch asks, and a restore asks once per agent. Only the working answer is remembered:
  // the cure for the other two is to change the engine on disk, and a remembered refusal would
  // outlive the upgrade that fixed it — which is how openharness#285's reporter resolved theirs.
  it('remembers that a flag IS supported, and keeps asking when it is not', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'harness-engine-cache-'))
    dirs.push(binDir)
    process.env.HARNESS_ENGINE_TEST_PATH = binDir
    const shell = bashProbeShell()

    fakeEngine(binDir, 'opencode', '--auto')
    await expect(commandSupportsFlagInInteractiveShell('opencode', '--auto', shell)).resolves.toBe('supported')
    // Downgraded underneath us where the daemon cannot see the file (only the probe shell's PATH has
    // it): remembered by name alone, the yes stands until the cache is reset.
    fakeEngine(binDir, 'opencode', '--auto-update')
    await expect(commandSupportsFlagInInteractiveShell('opencode', '--auto', shell)).resolves.toBe('supported')
    resetCommandFlagSupportCache()
    await expect(commandSupportsFlagInInteractiveShell('opencode', '--auto', shell)).resolves.toBe('unsupported')
    // A refusal is never remembered, so the upgrade is seen at once.
    fakeEngine(binDir, 'opencode', '--auto')
    await expect(commandSupportsFlagInInteractiveShell('opencode', '--auto', shell)).resolves.toBe('supported')
  })

  // e2e/updates.e2e.ts: remembered by name alone, a yes outlived the update that dropped the flag,
  // and the engine was launched with a flag it refused at once. A yes is kept for the file it was read from.
  it('answers an unchanged engine from memory, and asks again once an update has changed its file', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'harness-engine-update-'))
    dirs.push(binDir)
    process.env.HARNESS_ENGINE_TEST_PATH = binDir
    const savedPath = process.env.PATH
    process.env.PATH = `${binDir}:${savedPath ?? ''}`
    try {
      const shell = bashProbeShell()
      const runs = join(binDir, 'runs')
      const build = (path: string, help: string) => {
        writeFileSync(path, `#!/bin/sh\necho run >> '${runs}'\nif [ "$1" = "--help" ]; then printf "%s\\n" '${help}'; exit 0; fi\nexit 2\n`)
        chmodSync(path, 0o700)
      }
      const asked = () => existsSync(runs) ? readFileSync(runs, 'utf8').split('\n').filter(Boolean).length : 0
      const opencode = join(binDir, 'opencode')

      build(opencode, '--auto')
      await expect(commandSupportsFlagInInteractiveShell('opencode', '--auto', shell)).resolves.toBe('supported')
      await expect(commandSupportsFlagInInteractiveShell('opencode', '--auto', shell)).resolves.toBe('supported')
      expect(asked()).toBe(1)
      // Rewritten in place by an update that dropped the flag: asked again, and refused.
      build(opencode, '--auto-update')
      await expect(commandSupportsFlagInInteractiveShell('opencode', '--auto', shell)).resolves.toBe('unsupported')
      expect(asked()).toBe(2)

      // Installed as versions and linked, the way Homebrew and native installs update: the same size,
      // and only the link moves.
      mkdirSync(join(binDir, 'v1')); mkdirSync(join(binDir, 'v2'))
      build(join(binDir, 'v1', 'opencode'), '--auto')
      build(join(binDir, 'v2', 'opencode'), '--nope')
      rmSync(opencode)
      symlinkSync(join(binDir, 'v1', 'opencode'), opencode)
      await expect(commandSupportsFlagInInteractiveShell('opencode', '--auto', shell)).resolves.toBe('supported')
      await expect(commandSupportsFlagInInteractiveShell('opencode', '--auto', shell)).resolves.toBe('supported')
      expect(asked()).toBe(3)
      rmSync(opencode)
      symlinkSync(join(binDir, 'v2', 'opencode'), opencode)
      await expect(commandSupportsFlagInInteractiveShell('opencode', '--auto', shell)).resolves.toBe('unsupported')
      expect(asked()).toBe(4)
    } finally {
      process.env.PATH = savedPath
    }
  })

  // A shell's own failure exits 1 — as zsh's read-only `status` did — and must not read as a missing
  // flag: only the probe's own "not in the help" exit refuses an engine.
  it('does not read a shell failure as a missing flag', async () => {
    const shellDir = mkdtempSync(join(tmpdir(), 'harness-engine-shell-'))
    dirs.push(shellDir)
    const shell = join(shellDir, 'bash')
    writeFileSync(shell, '#!/bin/sh\nexit 1\n')
    chmodSync(shell, 0o700)

    await expect(
      commandSupportsFlagInInteractiveShell('codex', '--approve-for-me', shell),
    ).resolves.toBe('unknown')
  })

  it('does not reject a CLI when its help command cannot be inspected', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'harness-engine-capability-'))
    dirs.push(binDir)
    const codex = join(binDir, 'codex')
    writeFileSync(codex, '#!/bin/sh\nexit 2\n')
    chmodSync(codex, 0o700)
    process.env.HARNESS_ENGINE_TEST_PATH = binDir

    await expect(
      commandSupportsFlagInInteractiveShell('codex', '--approve-for-me', bashProbeShell()),
    ).resolves.toBe('unknown')
  })

  // zsh makes `status` a read-only alias of `$?`, so a bare `status=$?` in the probe script is a
  // fatal error there: the shell dies with exit 1, which this function reads as `unsupported`.
  // macOS defaults $SHELL to zsh, so that one name turned every Codex Auto launch on a Mac into
  // "your installed Codex CLI does not support --approve-for-me" whatever version was installed.
  it.skipIf(!ZSH)('answers from zsh too, where `status` is a read-only parameter', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'harness-engine-capability-zsh-'))
    dirs.push(binDir)
    const codex = join(binDir, 'codex')
    writeFileSync(
      codex,
      '#!/bin/sh\nif [ "$1" = "--help" ]; then printf "%s\\n" "--approve-for-me"; exit 0; fi\nexit 2\n',
    )
    chmodSync(codex, 0o700)
    process.env.HARNESS_ENGINE_TEST_PATH = binDir

    await expect(
      commandSupportsFlagInInteractiveShell('codex', '--approve-for-me', zshProbeShell()),
    ).resolves.toBe('supported')

    writeFileSync(
      codex,
      '#!/bin/sh\nif [ "$1" = "--help" ]; then printf "%s\\n" "--sandbox"; exit 0; fi\nexit 2\n',
    )
    await expect(
      commandSupportsFlagInInteractiveShell('codex', '--approve-for-me', zshProbeShell()),
    ).resolves.toBe('unsupported')
  })
})

describe('buildEngineLaunchArgv — the grid the pane finds', () => {
  /** A runnable `grid` at `dir/grid`. Which one the pane's shell resolves is the assertion. */
  function gridAt(dir: string): string {
    mkdirSync(dir, { recursive: true })
    return executable(dir, 'grid')
  }

  it('puts the resolved grid first on PATH and turns its update check off, before the engine', () => {
    const managed = '/opt/harness/runtime/grid-0.3.47-darwin-arm64/grid'
    const script = launchScriptOf(buildEngineLaunchArgv('claude', {}, '/bin/zsh', undefined, managed))

    expect(script).toContain(`PATH='/opt/harness/runtime/grid-0.3.47-darwin-arm64'"\${PATH:+:$PATH}"\nexport PATH\n`)
    expect(script).toContain('GRID_NO_UPDATE_CHECK=1\nexport GRID_NO_UPDATE_CHECK\n')
    expect(script.indexOf('export GRID_NO_UPDATE_CHECK')).toBeLessThan(script.indexOf(RUN_LINE))
  })

  it('leaves PATH alone when grid is only a name on it, but still turns the update check off', () => {
    const script = launchScriptOf(buildEngineLaunchArgv('claude', {}, '/bin/zsh', undefined, 'grid'))

    expect(script).not.toContain('export PATH')
    expect(script).toContain('GRID_NO_UPDATE_CHECK=1')
  })

  /** What the engine's own `command -v grid` answers, and what it sees in GRID_NO_UPDATE_CHECK.
   *
   *  The pane is the user's login shell, and a `.zshrc` that puts `~/.local/bin` first is ordinary —
   *  which is where grid's own installer (uv, on a Mac) leaves a `grid`. The prelude runs AFTER the
   *  startup files, so that one cannot get ahead of the grid the daemon resolved. `bashProbeShell()`
   *  plays the startup file: it resets PATH to HARNESS_ENGINE_TEST_PATH before the script runs. */
  async function gridSeenByEngine(gridBinary: string): Promise<{ which: string; updateCheck: string }> {
    const [shell, flag, script] = buildEngineLaunchArgv('claude', {}, bashProbeShell(), undefined, gridBinary)
    const { execFile } = await import('node:child_process')
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        shell,
        [flag, script, 'harness-engine', '/bin/sh', '-c', 'command -v grid; printf "%s" "$GRID_NO_UPDATE_CHECK"'],
        { timeout: 10_000 },
        (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)),
      )
    })
    const [which, updateCheck] = out.split('\n')
    return { which, updateCheck }
  }

  it('wins over a grid the shell\'s own startup files put first on PATH', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-pane-grid-'))
    dirs.push(root)
    gridAt(join(root, 'users-own'))
    const managed = gridAt(join(root, 'runtime', 'grid-0.3.47-darwin-arm64'))
    process.env.HARNESS_ENGINE_TEST_PATH = `${join(root, 'users-own')}:/usr/bin:/bin`

    await expect(gridSeenByEngine(managed)).resolves.toEqual({ which: managed, updateCheck: '1' })
  })

  it('leaves the user\'s own grid in charge when the daemon resolved nothing better', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-pane-grid-'))
    dirs.push(root)
    const own = gridAt(join(root, 'users-own'))
    process.env.HARNESS_ENGINE_TEST_PATH = `${join(root, 'users-own')}:/usr/bin:/bin`

    await expect(gridSeenByEngine('grid')).resolves.toEqual({ which: own, updateCheck: '1' })
  })
})

describe('buildEngineLaunchArgv with installFirst', () => {
  // Everything here is about ONE rule: the engine must not be exec'd after an install that failed.
  // Doing so reproduces the `command not found` this feature exists to replace, with a screenful of
  // installer output above it to bury the cause.
  const script = (install: string): string =>
    buildEngineLaunchArgv('opencode', { installFirst: install }, '/bin/zsh')[4]

  it('leaves the plain launch alone when nothing has to be installed', () => {
    expect(launchScriptOf(buildEngineLaunchArgv('opencode', {}, '/bin/zsh', undefined, undefined, NO_TMUX))).toBe(`${RAISE_OPEN_FILES_SH}${FALLBACK('opencode', '/bin/zsh')}${GRID_PRELUDE}${RUN}`)
  })

  it('keeps the engine argv positional, so the shell never re-parses a path or a flag', () => {
    const argv = buildEngineLaunchArgv('opencode', {
      installFirst: 'npm install -g opencode-ai',
      bypassPermission: true,
    }, '/bin/zsh')
    expect(argv.slice(0, 4)).toEqual(['/usr/bin/env', 'DISABLE_AUTO_UPDATE=true', '/bin/zsh', '-lic'])
    expect(argv.slice(5)).toEqual(['harness-engine', ...buildEngineCommandArgv('opencode', { bypassPermission: true })])
    expect(launchScriptOf(argv)).toContain(RUN_LINE)
  })

  it('runs the engine only when the install succeeded', async () => {
    await expect(runPaneScript(script('true'))).resolves.toMatchObject({ code: 0, ranEngine: true })
  })

  it('does not run the engine when the install returns a failure', async () => {
    const result = await runPaneScript(script('false'))
    expect(result.ranEngine).toBe(false)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('the install failed')
  })

  it('does not run the engine when the install command is not there at all', async () => {
    const result = await runPaneScript(script('harness-no-such-installer --please'))
    expect(result.ranEngine).toBe(false)
    expect(result.code).toBe(1)
  })

  it('prints the command before running it, so a long install is not a hung pane', () => {
    expect(launchScriptOf(['-c', script('npm install -g opencode-ai')])).toContain('npm install -g opencode-ai')
  })

  it("survives an install line carrying a quote, rather than ending the shell's string", async () => {
    // `curl … | bash` is already in the table; a quoted argument is the next shape to arrive, and an
    // install line is a constant in our own source — so the failure mode is a broken pane, not an
    // injection. It still must not break.
    const result = await runPaneScript(script(`sh -c 'exit 3'`))
    expect(result.ranEngine).toBe(false)
    expect(result.code).toBe(1)
  })
})

describe('buildEngineLaunchArgv with installIfMissing', () => {
  const recipe = (
    command: string,
    executable: EngineInstallRecipe['executable'] = { names: ['harness-no-such-engine'] },
  ): EngineInstallRecipe => ({ command, source: 'test fixture', executable })
  const script = (install: EngineInstallRecipe, runtimeNode?: string): string =>
    buildEngineLaunchArgv('opencode', { installIfMissing: install }, '/bin/zsh', runtimeNode)[4]

  it('execs an installed engine without running the installer', async () => {
    await expect(runPaneScript(script(recipe('false')))).resolves.toMatchObject({ code: 0, ranEngine: true })
  })

  it('runs the installer inside the pane when the engine is absent', async () => {
    const result = await runPaneScript(script(recipe('false')), 'harness-no-such-engine')
    expect(result.ranEngine).toBe(false)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('engine is missing')
  })

  it('execs a vendor path after install even when the current PATH did not reload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-engine-installed-'))
    dirs.push(dir)
    const source = join(dir, 'source-engine')
    const installed = join(dir, 'new-engine')
    writeFileSync(source, '#!/bin/sh\n/usr/bin/printf "%s" "$1"\n')
    chmodSync(source, 0o700)
    const install = `cp ${JSON.stringify(source)} ${JSON.stringify(installed)}`
    const result = await runPaneScript(
      script(recipe(install, { names: ['harness-no-such-engine'], absolutePaths: [installed] })),
      'harness-no-such-engine',
    )
    expect(result).toMatchObject({ code: 0, ranEngine: true })
  })

  it('reports a successful install that did not provide an executable', async () => {
    const result = await runPaneScript(script(recipe('true')), 'harness-no-such-engine')
    expect(result).toMatchObject({ code: 1, ranEngine: false })
    expect(result.stdout).toContain('install completed, but its executable could not be found')
  })

  it('enables npm from the managed Node runtime when the pane PATH has no npm', async () => {
    const runtimeBin = mkdtempSync(join(tmpdir(), 'harness-managed-node-bin-'))
    const emptyPath = mkdtempSync(join(tmpdir(), 'harness-empty-path-'))
    dirs.push(runtimeBin, emptyPath)
    const runtimeNode = executable(runtimeBin, 'node')
    const engineSource = join(runtimeBin, 'engine-source')
    writeFileSync(engineSource, '#!/bin/sh\n/usr/bin/printf "HARNESS-TEST-ENGINE-RAN\\n"\n')
    chmodSync(engineSource, 0o700)
    const installed = join(runtimeBin, 'installed-engine')
    const npm = join(runtimeBin, 'npm')
    writeFileSync(npm, `#!/bin/sh
if [ "$1" = prefix ]; then exit 0; fi
/bin/cp ${JSON.stringify(engineSource)} ${JSON.stringify(installed)}
/bin/chmod 700 ${JSON.stringify(installed)}
`)
    chmodSync(npm, 0o700)

    const result = await runPaneScript(
      script(recipe('npm install -g fixture', {
        names: ['harness-no-such-engine'],
        absolutePaths: [installed],
        npmGlobal: true,
      }), runtimeNode),
      'harness-no-such-engine',
      { PATH: emptyPath },
    )

    expect(result).toMatchObject({ code: 0, ranEngine: true })
    expect(result.stdout).toContain('installing for this user')
  })

  it('does not add the npm bootstrap to non-npm installers', () => {
    expect(launchScriptOf(['-c', script(recipe('true'))])).toContain('engine is missing')
    expect(launchScriptOf(['-c', script(recipe('true'))])).not.toContain('managed Node.js/npm')
  })
})

/** Run one generated pane script under /bin/sh and report what it did. */
async function runPaneScript(
  paneScript: string,
  command = '/usr/bin/printf',
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; stdout: string; ranEngine: boolean }> {
  const { execFile } = await import('node:child_process')
  const marker = 'HARNESS-TEST-ENGINE-RAN'
  return await new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', paneScript, 'harness-engine', command, `${marker}\n`],
      { timeout: 10_000, env },
      (error, stdout) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as unknown as { code: number }).code
          : 0
        resolve({ code, stdout, ranEngine: stdout.includes(marker) })
      },
    )
  })
}

describe('zsh\'s new-user menu, kept out of an agent\'s pane', () => {
  // Debian, Ubuntu, Fedora and Arch build zsh with its zsh/newuser module: on a terminal, for a person
  // with no .zshenv, .zprofile, .zshrc or .zlogin, it runs a full-screen setup menu before anything else.
  // On the end-to-end suite's first Linux run every zsh agent's pane showed it, and no engine started.
  let root = ''
  let savedDataDir = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'launch-newuser-'))
    savedDataDir = env.ADAPTER_DATA_DIR
    env.ADAPTER_DATA_DIR = join(root, 'data')
  })
  afterEach(() => {
    env.ADAPTER_DATA_DIR = savedDataDir
    rmSync(root, { recursive: true, force: true })
  })
  const folder = () => join(root, 'data', 'zsh-startup')

  it('points a person with no zsh startup files at a .zshenv of Harness\'s that puts their ZDOTDIR back', () => {
    const home = join(root, 'home')
    mkdirSync(home)
    expect(zshNewUserGuard({ HOME: home })).toEqual([`ZDOTDIR=${folder()}`])
    expect(zshNewUserGuard({ HOME: home, ZDOTDIR: home })).toEqual([`ZDOTDIR=${folder()}`, `HARNESS_ZDOTDIR=${home}`])
    expect(readFileSync(join(folder(), '.zshenv'), 'utf8')).toBe(ZSH_GUARD_ZSHENV)
    expect(statSync(join(folder(), '.zshenv')).mode & 0o777).toBe(0o600)
    // In the launch itself, before the shell and its flags.
    process.env.ZDOTDIR = home
    expect(buildEngineLaunchArgv('claude', {}, '/bin/zsh', undefined, undefined, NO_TMUX).slice(0, 6)).toEqual([
      '/usr/bin/env', 'DISABLE_AUTO_UPDATE=true', `ZDOTDIR=${folder()}`, `HARNESS_ZDOTDIR=${home}`, '/bin/zsh', '-lic',
    ])
  })

  it.each(['.zshenv', '.zprofile', '.zshrc', '.zlogin'])('leaves anyone with a %s exactly as they were', (name) => {
    const home = join(root, 'home')
    mkdirSync(home)
    writeFileSync(join(home, name), '')
    expect(zshNewUserGuard({ HOME: home })).toEqual([])
    expect(zshNewUserGuard({ HOME: join(root, 'elsewhere'), ZDOTDIR: home })).toEqual([])
    expect(existsSync(folder())).toBe(false)
  })

  it('launches as before when it cannot write its .zshenv, or there is no home to look in', () => {
    writeFileSync(join(root, 'data'), 'a file where the data folder should be')
    expect(zshNewUserGuard({ HOME: root })).toEqual([])
    expect(zshNewUserGuard({})).toEqual([])
  })

  // What the .zshenv does, in a real zsh: a person's ZDOTDIR, set or unset, is theirs again before any
  // of their own files is read, and a startup file of theirs that appears later is read from it.
  it.skipIf(!existsSync('/bin/zsh'))('gives a real zsh back the person\'s ZDOTDIR, set or unset, and reads their files from it', () => {
    const home = join(root, 'home')
    mkdirSync(home)
    const run = (environment: NodeJS.ProcessEnv) => {
      const guard = zshNewUserGuard(environment)
      expect(guard).not.toEqual([])
      const out = execFileSync('/usr/bin/env', [...guard, '/bin/zsh', '-lic', 'print -r -- "${ZDOTDIR-unset}|${+HARNESS_ZDOTDIR}|${HARNESS_PROFILE-}"'], {
        encoding: 'utf8', env: { PATH: process.env.PATH, ...environment }, stdio: ['ignore', 'pipe', 'ignore'],
      })
      return out.trim().split('\n').at(-1)
    }
    expect(run({ HOME: home })).toBe('unset|0|')
    expect(run({ HOME: join(root, 'not-here'), ZDOTDIR: home })).toBe(`${home}|0|`)
    // A .zshenv only at the guard's decision: one written after it is still the person's to run.
    const later = join(root, 'later')
    mkdirSync(later)
    const guard = zshNewUserGuard({ HOME: later })
    writeFileSync(join(later, '.zshenv'), 'export HARNESS_PROFILE=theirs\n')
    const out = execFileSync('/usr/bin/env', [...guard, '/bin/zsh', '-lic', 'print -r -- "${ZDOTDIR-unset}|${HARNESS_PROFILE-}"'], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: later }, stdio: ['ignore', 'pipe', 'ignore'],
    })
    expect(out.trim().split('\n').at(-1)).toBe('unset|theirs')
  })

  // The menu itself needs zsh's newuser script (not on macOS) and a terminal, which a pseudo-terminal
  // from python's pty module provides. Without the guard the menu waits for a key and the marker never
  // comes; with it the shell runs the command at once.
  const newuserScript = ['/usr/share/zsh', '/usr/local/share/zsh'].flatMap((base) => {
    try { return readdirSync(base).map((version) => join(base, version, 'scripts', 'newuser')) } catch { return [] }
  }).find((file) => existsSync(file))
  it.skipIf(!existsSync('/bin/zsh') || !newuserScript || !existsSync('/usr/bin/python3'))('runs a new user\'s pane straight to its command, with no setup menu', () => {
    const home = join(root, 'home')
    mkdirSync(home)
    const argv = ['/usr/bin/env', ...zshNewUserGuard({ HOME: home }), '/bin/zsh', '-lic', 'print HARNESS-MARKER; exit']
    const pty = `import os, pty, sys, select, time\npid, fd = pty.fork()\nif pid == 0:\n    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)\nout = b''\nend = time.time() + 8\nwhile time.time() < end and b'HARNESS-MARKER' not in out:\n    r, _, _ = select.select([fd], [], [], 0.2)\n    if r:\n        try: out += os.read(fd, 4096)\n        except OSError: break\nos.kill(pid, 9)\nsys.stdout.write(out.decode('utf8', 'replace'))\n`
    const out = execFileSync('/usr/bin/python3', ['-c', pty, ...argv], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, TERM: 'xterm', LINES: '40', COLUMNS: '120' }, timeout: 20_000,
    })
    expect(out).not.toContain('zsh-newuser-install')
    expect(out).toContain('HARNESS-MARKER')
  })
})

