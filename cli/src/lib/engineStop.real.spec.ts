/**
 * A stopped engine, for real: the launch script in an isolated tmux server, under each shell a pane
 * may run it in, with a stand-in engine that stops the way Claude Code and Codex do. Ctrl+Z: it gives
 * the terminal back, stops its whole process group, and takes the terminal again only when continued
 * from that stop; a stop from outside it does not notice, and only repaints. Codex comes as npm
 * installs it, a Node wrapper with the engine as its child. Each time it must come back on its own and
 * take keys again, and in the end exit with its own status through the usual exit handling, the pane
 * turning into a shell; one that dies of a signal must too. A take-over that waits for the terminal's
 * engine keeps waiting through a Ctrl+Z, and an engine that cannot stay running is ended, not spun.
 *
 * Before, the pane's shell took the stop for the end of the engine and exited, hanging up the stopped
 * engine with the pane. Linux has no tcsh here: a stand-in named fish hands the launch to dash or, with
 * no dash (Fedora), to bash run as /bin/sh.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { env } from '../config/env.js'
import { isolatedTmux, type IsolatedTmux } from '../testing/isolatedTmux.js'
import { resolveBinaryOnPath } from './binaryOnPath.js'
import { buildEngineLaunchArgv } from './engineLaunch.js'
import type { EngineInstallRecipe } from './engineInstall.js'
import { ENGINE_EXIT_PANE_OPTION } from './tmux.js'

const tmuxBin = resolveBinaryOnPath('tmux')
const real = process.env.RUN_REAL_TMUX_DISCOVERY === '1' && tmuxBin ? describe : describe.skip

/** A login shell that is not POSIX, as far as the launch can tell (it goes by the name): `-i -c <it>`
 *  runs what it is given, and on its own it is an interactive shell, as the one exec'd after an exit. */
const standIn = realpathSync(mkdtempSync(join(tmpdir(), 'harness-not-posix-')))
const FISH = join(standIn, 'fish')
writeFileSync(FISH, '#!/bin/sh\n[ $# -eq 0 ] && exec /bin/sh -i\nwhile [ $# -gt 1 ]; do shift; done\nexec /bin/sh -c "$1"\n', { mode: 0o755 })

/** The login shells, as the launch is given them. tcsh where there is one, else the stand-in. */
const SHELLS = [...['/bin/zsh', '/bin/bash', '/bin/sh', '/bin/dash'].filter(existsSync), existsSync('/bin/tcsh') ? '/bin/tcsh' : FISH]
/** A login shell that hands the launch to a POSIX shell rather than running it. */
const handsOff = (shell: string): boolean => shell === FISH || shell.endsWith('/tcsh')
const isBash = (path: string): boolean => execFileSync(path, ['-c', 'printf %s "${BASH_VERSION:-}"'], { encoding: 'utf8' }) !== ''
/** Whether bash is the shell with the engine as its job: bash puts the terminal back in its own modes
 *  when the job stops and leaves them when it continues it (`STOP_PROOF_FUNCTIONS`), and run without
 *  a terminal of its own it reports a job killed by SIGINT as a success. The hand-off goes to dash
 *  where there is one, else to /bin/sh, which is bash on Fedora. */
const bashRuns = (shell: string): boolean => handsOff(shell)
  ? !existsSync('/bin/dash') && isBash('/bin/sh')
  : (shell === '/bin/bash' || shell === '/bin/sh') && isBash(shell)

const roots: string[] = [standIn]
const waitedFor: number[] = []
const stopped: number[] = []
let server: IsolatedTmux | undefined
const saved = { claude: env.CLAUDE_PATH, codex: process.env.CODEX_PATH, data: env.ADAPTER_DATA_DIR }

afterEach(async () => {
  // A stopped process left behind would outlive the test.
  for (const pid of stopped.splice(0)) { try { process.kill(pid, 'SIGCONT') } catch { /* gone */ } }
  await server?.close()
  server = undefined
  for (const pid of waitedFor.splice(0)) { try { process.kill(pid) } catch { /* gone */ } }
  env.CLAUDE_PATH = saved.claude
  if (saved.codex === undefined) delete process.env.CODEX_PATH
  else process.env.CODEX_PATH = saved.codex
  env.ADAPTER_DATA_DIR = saved.data
  for (const dir of roots.splice(1)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A raw-mode engine that logs what happens to it. Ctrl+Z: raw mode off, a one-time SIGCONT handler
 * that takes it again, and SIGTSTP to its whole process group. Any SIGCONT is logged, and that is all.
 * `q` exits 7; `t` starts it stopping again the moment it is continued, with SIGTTOU (`runaway=ttou`)
 * or SIGTSTP (`runaway=tstp`). With `wrapped`, it runs as the child of a Node wrapper, as npm's Codex
 * does: same group and terminal, INT, TERM and HUP forwarded, the child's end mirrored.
 */
function fixture(runaway: '' | 'ttou' | 'tstp' = '', wrapped = false) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-engine-stop-')))
  roots.push(dir)
  const log = join(dir, 'engine.log')
  writeFileSync(log, '')
  const engine = join(dir, 'engine')
  writeFileSync(engine, `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const log = (line) => fs.appendFileSync(${JSON.stringify(log)}, line + '\\n');
if (process.argv.includes('--help')) { console.log('  --no-daemon  Run in this process'); process.exit(0); }
if (${wrapped} && !process.env.FIXTURE_CHILD) {
  const child = spawn(process.execPath, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, FIXTURE_CHILD: '1' } });
  log('wrapper ' + process.pid);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { try { child.kill(signal); } catch {} });
  child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });
  return;
}
log('up ' + process.pid + ' ' + JSON.stringify(process.argv.slice(2)));
process.stdin.setRawMode(true);
process.stdout.write('ENGINE READY\\r\\n');
let runaway = false;
process.on('SIGCONT', () => {
  log('continued');
  process.stdout.write('ENGINE BACK\\r\\n');
  if (runaway) process.kill(0, ${JSON.stringify(runaway === 'ttou' ? 'SIGTTOU' : 'SIGTSTP')});
});
process.stdin.on('data', (data) => {
  const key = data.toString();
  if (key.includes('\\x1a')) {
    log('suspending');
    process.stdin.setRawMode(false);
    process.once('SIGCONT', () => { process.stdin.setRawMode(true); log('raw again'); });
    process.kill(0, 'SIGTSTP');
    return;
  }
  if (key.includes('t') && ${JSON.stringify(runaway)}) { runaway = true; process.kill(0, ${JSON.stringify(runaway === 'ttou' ? 'SIGTTOU' : 'SIGTSTP')}); return; }
  if (key.includes('q')) { log('quit'); process.exit(7); }
  log('key ' + JSON.stringify(key));
});
setInterval(() => {}, 1000);
`, { mode: 0o755 })
  const lines = () => readFileSync(log, 'utf8').split('\n').filter(Boolean)
  return { dir, engine, lines, count: (prefix: string) => lines().filter((line) => line.startsWith(prefix)).length }
}

async function until<T>(what: string, check: () => T | Promise<T>, ms = 8_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const state = (pid: number): string => {
  try { return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim() } catch { return '' }
}

/** A pane running the launch of `engine` under `shell`, from a throwaway home: no rc file of the
 *  developer's runs in it. */
async function open(shell: string, engine: 'claude' | 'codex', f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) {
  if (engine === 'claude') env.CLAUDE_PATH = f.engine
  else process.env.CODEX_PATH = f.engine
  env.ADAPTER_DATA_DIR = f.dir
  const argv = buildEngineLaunchArgv(engine, { cwd: f.dir, ...extra }, shell, undefined, 'grid', tmuxBin)
  server = await isolatedTmux()
  const pane = await server.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-x', '100', '-y', '30', '-s', 'stop',
    '-e', `HOME=${f.dir}`, '-e', `ZDOTDIR=${f.dir}`, '-e', 'ENV=', ...argv)
  await server.run('set-option', '-w', '-t', 'stop', 'remain-on-exit', 'on')
  const tmux = server
  const screen = () => tmux.run('capture-pane', '-p', '-t', pane)
  onTestFailed(async () => {
    let log = ''
    try { log = f.lines().join('\n') } catch { /* swept already */ }
    console.log(`---- ${shell} ${engine}\n${log}\n---- pane\n${await screen().catch(() => '')}`)
  })
  return {
    pane,
    screen,
    keys: (...keys: string[]) => tmux.run('send-keys', '-t', pane, ...keys),
    /** The terminal's line discipline: raw (`-icanon`) as an engine keeps it, or line mode. */
    lineMode: async () => / icanon /.test(` ${execFileSync('/bin/sh', ['-c', 'stty -a < "$0"', (await tmux.run('display-message', '-p', '-t', pane, '#{pane_tty}')).trim()], { encoding: 'utf8' }).replace(/\s+/g, ' ')} `),
    exitMark: async () => (await tmux.run('show-option', '-p', '-v', '-t', pane, ENGINE_EXIT_PANE_OPTION).catch(() => '')).trim(),
    dead: async () => (await tmux.run('display-message', '-p', '-t', pane, '#{pane_dead}')).trim(),
  }
}

/** Most launches look for the engine first and install it when it is missing; here it is there. */
const installIfMissing: EngineInstallRecipe = { command: 'false', source: 'test fixture', executable: { names: ['harness-no-such-engine'] } }
const LAUNCHES = [
  { engine: 'claude', label: 'claude' },
  { engine: 'claude', label: 'claude, looked for first', extra: { installIfMissing } },
  { engine: 'codex', label: 'codex, npm wrapper and all', wrapped: true },
] as const

real('a stopped engine in a real pane', () => {
  for (const shell of SHELLS) for (const launch of LAUNCHES) {
    const engine = launch.engine
    it(`${shell}, ${launch.label}: comes back after Ctrl+Z and after a SIGSTOP, and its own exit still turns the pane into a shell`, async () => {
      const f = fixture('', 'wrapped' in launch)
      const p = await open(shell, engine, f, 'extra' in launch ? launch.extra : {})
      const up = await until('the engine to start', () => f.lines().find((line) => line.startsWith('up ')))
      const pid = Number(up.split(' ')[1])
      // Codex is given its writer flag, then the arguments as they were.
      if (engine === 'codex') expect(JSON.parse(up.slice(up.indexOf('[')))).toEqual(['--no-daemon'])

      // Ctrl+Z: the whole group stops, the shell continues it, and the engine takes the terminal again.
      await p.keys('C-z')
      await until('the engine to take the terminal again after Ctrl+Z', () => f.count('raw again') === 1)
      await until('the engine to run again', () => !state(pid).startsWith('T'))
      await p.keys('-l', 'k')
      await until('a key to reach it', () => f.count('key "k"') === 1)
      expect(await p.lineMode()).toBe(false)

      // A SIGSTOP of the engine alone, from outside: continued too. It does not take the terminal
      // again (the real CLIs do not on a plain SIGCONT), so an interactive bash, which put back its own
      // modes when the job stopped, leaves it in line mode; zsh restores the job's, dash leaves them be.
      // npm's Codex is the shell's job through its wrapper, and that is the process stopped here: a
      // stop of the native child alone reaches no shell, as one below a pane's process reaches no tmux.
      const job = 'wrapped' in launch ? Number(f.lines().find((line) => line.startsWith('wrapper '))!.split(' ')[1]) : pid
      process.kill(job, 'SIGSTOP')
      stopped.push(job)
      await until('the engine to be continued after a SIGSTOP', () => f.count('continued') === 2)
      await until('the engine to run again', () => !state(pid).startsWith('T'))
      expect(await p.lineMode()).toBe(bashRuns(shell))
      await p.keys('-l', 'j')
      await p.keys('Enter')
      await until('a key to reach it again', () => f.lines().some((line) => line.startsWith('key "j')))
      // One engine all along: no second start.
      expect(f.count('up ')).toBe(1)

      await p.keys('-l', 'q')
      await p.keys('Enter')
      expect(await until('the exit to be marked on the pane', () => p.exitMark())).toBe('7')
      await until('the pane to say it is a shell now', async () => (await p.screen()).includes('This pane is a shell now') || null)
      expect(await p.dead()).toBe('0')
    }, 30_000)
  }

  for (const shell of SHELLS) {
    it(`${shell}: an engine that dies of SIGINT, or a Codex whose engine dies of SIGQUIT, still turns the pane into a shell`, async () => {
      // zsh gave up the script when its job was killed by INT or QUIT, and dash dropped to a prompt.
      // bash run as the hand-off's /bin/sh (Fedora) reports a job killed by INT as a success.
      for (const [engine, signal, status] of [['claude', 'SIGINT', handsOff(shell) && bashRuns(shell) ? '0' : '130'], ['codex', 'SIGQUIT', '131']] as const) {
        const f = fixture('', engine === 'codex')
        const p = await open(shell, engine, f)
        const up = await until('the engine to start', () => f.lines().find((line) => line.startsWith('up ')))
        // npm's Codex wrapper ends with the signal its child died of, unless it listens for it (INT).
        process.kill(Number(up.split(' ')[1]), signal)
        expect(await until(`the ${signal} death to be marked on the pane`, () => p.exitMark())).toBe(status)
        await until('the pane to say it is a shell now', async () => (await p.screen()).includes('This pane is a shell now') || null)
        expect(await p.dead()).toBe('0')
        await server?.close()
        server = undefined
      }
    }, 30_000)
  }

  for (const shell of SHELLS.filter((path) => !path.endsWith('tcsh') && path !== FISH)) {
    it(`${shell}: an engine that cannot keep the terminal is ended after a few tries, not resumed for ever`, async () => {
      const f = fixture('ttou')
      const p = await open(shell, 'claude', f)
      await until('the engine to start', () => f.count('up ') === 1)
      await p.keys('-l', 't')
      expect(await until('the engine to be ended', () => p.exitMark(), 20_000)).toBe('137')
      // Five continues at most, the last ones a second apart: no spinning.
      expect(f.count('continued')).toBeLessThanOrEqual(6)
      expect(await p.dead()).toBe('0')
    }, 30_000)

    it(`${shell}: an engine that stops again at once is resumed a second apart, not spun`, async () => {
      const f = fixture('tstp')
      const p = await open(shell, 'claude', f)
      await until('the engine to start', () => f.count('up ') === 1)
      await p.keys('-l', 't')
      await new Promise((resolve) => setTimeout(resolve, 6_000))
      // Three quick resumes, then about one a second; without the pause it would be hundreds.
      expect(f.count('continued')).toBeLessThanOrEqual(10)
      expect(f.count('continued')).toBeGreaterThanOrEqual(4)
      expect(await p.exitMark()).toBe('')
      expect(await p.dead()).toBe('0')
    }, 30_000)
  }
})

real('a take-over that waits in a real pane', () => {
  // The wait loop's `sleep` used to be the shell's foreground job: Ctrl+Z stopped it, and zsh gave the
  // script up while bash left the loop and started the engine with the terminal's still running.
  for (const shell of SHELLS.filter((path) => !path.endsWith('tcsh') && path !== FISH)) {
    it(`${shell}: Ctrl+Z does not end the wait, and Ctrl-C still leaves the conversation where it is`, async () => {
      const f = fixture()
      const other = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
      other.unref()
      waitedFor.push(other.pid!)
      const p = await open(shell, 'claude', f, { waitForPid: { pid: other.pid!, name: 'Claude Code' } })
      const deadStatus = async () => (await server!.run('display-message', '-p', '-t', p.pane, '#{pane_dead} #{pane_dead_status}')).trim()

      await until('the pane to say it is waiting', async () => (await p.screen()).includes('Waiting for the Claude Code in your terminal') || null)
      await p.keys('C-z')
      // Longer than a turn of the wait: still waiting, and nothing started.
      await new Promise((resolve) => setTimeout(resolve, 2_500))
      expect(await deadStatus()).toBe('0')
      expect(f.lines()).toEqual([])

      await p.keys('C-c')
      await until('the pane to say the conversation stays', async () => (await p.screen()).includes('It stays in your terminal.') || null)
      expect(await until('the script to end', async () => {
        const now = await deadStatus()
        return now.startsWith('1 ') ? now : null
      })).toBe('1 130')
      expect(f.lines()).toEqual([])
    }, 30_000)
  }
})
