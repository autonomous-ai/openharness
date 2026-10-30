/** This computer's side of `harness team` (./command.ts): every module it needs, loaded only when it runs. */
import { existsSync, statSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { env } from '../config/env.js'
import { readAuthSession, updateAuthSession, writeAuthSession } from '../lib/authSession.js'
import { controlPlaneAuth, postJson, requestJson } from '../lib/controlPlane.js'
import { computerId } from '../lib/daemonState.js'
import { peekIdentity } from '../lib/e2ee/store.js'
import { runGuestCommand, type GuestRunner } from '../lib/guestAccounts.js'
import { managedNodeRuntimeDir } from '../lib/guestHelperInstall.js'
import { managedNodePath } from '../lib/nodeRuntime.js'
import { ancestorsOnce, removeSignIn, signOutAsked } from '../lib/signOut.js'
import { managedTmuxPath } from '../lib/tmuxOnPath.js'
import { currentPtyVersion } from '../lib/ptyHost/launch.js'
import { CLI_POINTER, readPointer } from '../lib/windows/installLayout.js'
import { runPowershell } from '../lib/windows/powershell.js'
import { adminRunner } from './admin.js'
import type { Installed, JobState, TeamCommandDeps } from './command.js'
import {
  WHOAMI_USER_ARGS, parseWindowsAccountExists, parseWindowsJobState, takeWindowsHandoffFile, windowsAccountExistsScript, windowsJobStateScript,
  windowsStartTaskScript, windowsUserSid, writeWindowsHandoff, type PowershellQuery,
} from './windowsTeam.js'
import { readTeamConfig } from './config.js'
import { realPrivacyDeps, readTeamStatus, runPrivacyCheck, writeTeamStatus } from './privacy.js'
import { takeHandoffFile } from './handoff.js'
import { checkTeamEngines, realEngineCheckDeps } from './engines.js'
import { teamSetupDecisionFile, writeTeamSetupDecision } from './autoSetup.js'

/** What `launchctl print system/<label>` says of a job; not loaded when launchd does not know it. Readable without root. */
export function parseLaunchctlPrint(code: number | null, stdout: string): JobState {
  if (code !== 0) return { loaded: false, pid: null, state: null }
  const pid = /^\s*pid = (\d+)\s*$/m.exec(stdout)
  const state = /^\s*state = (.+?)\s*$/m.exec(stdout)
  return { loaded: true, pid: pid ? Number(pid[1]) : null, state: state ? state[1]! : null }
}

/** Whether a local account by [user] exists: the account database itself on Linux (`getent passwd`, through NSS), `id`
 *  on a Mac, `Get-LocalUser` on Windows. */
export const teamAccountExists = (runner: GuestRunner, platform: NodeJS.Platform = process.platform) => async (user: string): Promise<boolean> =>
  platform === 'win32' ? parseWindowsAccountExists(powershell(windowsAccountExistsScript(user)))
    : (platform === 'linux'
      ? await runner('getent', ['passwd', user], { timeoutMs: 10_000 })
      : await runner('id', ['-u', user], { timeoutMs: 10_000 })).code === 0

/** What `systemctl show -p LoadState,ActiveState,MainPID <unit>` says of the team daemon; not loaded when systemd
 *  does not know it. Readable without root. */
export function parseSystemctlShow(code: number | null, stdout: string): JobState {
  if (code !== 0) return { loaded: false, pid: null, state: null }
  const values = new Map(stdout.split('\n').filter((line) => line.includes('=')).map((line) => {
    const at = line.indexOf('=')
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()] as const
  }))
  if (values.get('LoadState') !== 'loaded') return { loaded: false, pid: null, state: null }
  const pid = Number(values.get('MainPID'))
  return { loaded: true, pid: Number.isInteger(pid) && pid > 0 ? pid : null, state: values.get('ActiveState') || null }
}

export function teamCommandDeps(options: {
  stopDaemon: () => Promise<boolean>
  startDaemon: () => Promise<void>
  signIn?: (restart: boolean) => Promise<void>
  runner?: GuestRunner
}): TeamCommandDeps {
  const runner = options.runner ?? runGuestCommand
  // Read once: the same processes decide whether a person asked and are named in the log.
  const chain = ancestorsOnce()
  return {
    platform: process.platform,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    user: () => userInfo().username,
    home: () => homedir(),
    uid: () => process.getuid?.() ?? -1,
    hostname: () => hostname(),
    env: process.env,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ask: (question) => new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      rl.question(question, (answer) => { rl.close(); resolve(answer) })
    }),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    session: readAuthSession,
    writeSession: writeAuthSession,
    updateSession: updateAuthSession,
    signOutAsked: (flags) => signOutAsked({ interactive: process.stdin.isTTY === true, flags, ancestors: chain }),
    removeSignIn: (asked) => removeSignIn('team off', asked, chain),
    auth: controlPlaneAuth,
    post: (path, body, headers) => postJson(path, body, headers ?? {}),
    get: (path, headers) => requestJson('GET', path, undefined, headers ?? {}),
    delete: (path, headers) => requestJson('DELETE', path, undefined, headers ?? {}),
    machineKey: () => peekIdentity(),
    computerId,
    autonomousEnv: env.AUTONOMOUS_ENV,
    installed: () => {
      if (process.platform === 'win32') return windowsInstalled()
      const tmux = managedTmuxPath()
      return {
        cliDir: env.ADAPTER_CLI_DIR,
        cliJs: join(env.ADAPTER_CLI_DIR, 'cli.js'),
        node: managedNodePath(),
        nodeRuntimeDir: managedNodeRuntimeDir(),
        tmuxRuntimeDir: tmux ? dirname(dirname(tmux)) : null,
      }
    },
    exists: existsSync,
    mode: (path) => { try { return statSync(path).mode & 0o777 } catch { return null } },
    admin: adminRunner({ runner, platform: process.platform }),
    readConfig: () => readTeamConfig(),
    readStatus: (path) => readTeamStatus(path),
    writeStatus: writeTeamStatus,
    accountExists: teamAccountExists(runner),
    jobState: async (label) => {
      // Windows: Task Scheduler, the one task setup registers (./windowsTeam.ts), whatever the label says.
      if (process.platform === 'win32') return parseWindowsJobState(powershell(windowsJobStateScript()))
      if (process.platform === 'linux') {
        const result = await runner('systemctl', ['show', '-p', 'LoadState,ActiveState,MainPID', label], { timeoutMs: 10_000 })
        return parseSystemctlShow(result.code, result.stdout)
      }
      const result = await runner('launchctl', ['print', `system/${label}`], { timeoutMs: 10_000 })
      return parseLaunchctlPrint(result.code, result.stdout)
    },
    takeHandoff: (path) => process.platform === 'win32' ? takeWindowsHandoffFile(path) : takeHandoffFile(path),
    privacy: (config) => runPrivacyCheck(config, realPrivacyDeps),
    engines: (config) => checkTeamEngines(realEngineCheckDeps(config.home)),
    setupDecision: {
      clear: () => writeTeamSetupDecision(teamSetupDecisionFile(env.ADAPTER_DATA_DIR), null),
      decline: () => writeTeamSetupDecision(teamSetupDecisionFile(env.ADAPTER_DATA_DIR), { state: 'declined', at: Date.now() }),
    },
    stopDaemon: options.stopDaemon,
    startDaemon: options.startDaemon,
    ...(options.signIn ? { signIn: options.signIn } : {}),
    // Windows, as the owner: who they are by SID, and the two steps after the elevated script (./command.ts).
    ownerSid: async () => {
      const who = await runner('whoami', WHOAMI_USER_ARGS, { timeoutMs: 10_000 })
      return who.code === 0 ? windowsUserSid(who.stdout) : null
    },
    handOver: (code) => writeWindowsHandoff(code),
    startTeamTask: async () => powershell(windowsStartTaskScript()).status === 0,
  }
}

/** A short Windows PowerShell query (lib/windows/powershell.ts): the inputs in its environment, never in its text. */
const powershell = (query: PowershellQuery) => runPowershell(query.script, query.inputs)

/**
 * What the Windows install laid down for this account (lib/windows/installLayout.ts): the CLI in its version folder,
 * which `cli\current` names; Node with node.exe at its top, not in bin\; and the terminal host `runtime\pty\current-pty`
 * names, which the team account gets a copy of. No tmux on Windows.
 */
function windowsInstalled(): Installed {
  const version = readPointer(env.ADAPTER_CLI_DIR, CLI_POINTER)
  const cliDir = version ? join(env.ADAPTER_CLI_DIR, version) : env.ADAPTER_CLI_DIR
  const node = managedNodePath()
  const pty = currentPtyVersion(env.ADAPTER_RUNTIME_DIR)
  const ptyDir = pty ? join(env.ADAPTER_RUNTIME_DIR, 'pty', pty) : null
  return {
    cliDir, cliJs: join(cliDir, 'cli.js'), node,
    nodeRuntimeDir: node.startsWith(env.ADAPTER_RUNTIME_DIR + sep) ? dirname(node) : null,
    tmuxRuntimeDir: null,
    ptyDir: ptyDir && existsSync(ptyDir) ? ptyDir : null,
  }
}
