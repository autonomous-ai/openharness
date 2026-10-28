/** This computer's side of `harness team` (./command.ts): every module it needs, loaded only when it runs. */
import { existsSync, statSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { env } from '../config/env.js'
import { readAuthSession, writeAuthSession } from '../lib/authSession.js'
import { controlPlaneAuth, postJson, requestJson } from '../lib/controlPlane.js'
import { computerId } from '../lib/daemonState.js'
import { peekIdentity } from '../lib/e2ee/store.js'
import { runGuestCommand, type GuestRunner } from '../lib/guestAccounts.js'
import { managedNodeRuntimeDir } from '../lib/guestHelperInstall.js'
import { managedNodePath } from '../lib/nodeRuntime.js'
import { ancestorsOnce, removeSignIn, signOutAsked } from '../lib/signOut.js'
import { managedTmuxPath } from '../lib/tmuxOnPath.js'
import { adminRunner } from './admin.js'
import type { JobState, TeamCommandDeps } from './command.js'
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
    admin: adminRunner({ runner }),
    readConfig: () => readTeamConfig(),
    readStatus: (path) => readTeamStatus(path),
    writeStatus: writeTeamStatus,
    accountExists: async (user) => (await runner('id', ['-u', user], { timeoutMs: 10_000 })).code === 0,
    jobState: async (label) => {
      const result = await runner('launchctl', ['print', `system/${label}`], { timeoutMs: 10_000 })
      return parseLaunchctlPrint(result.code, result.stdout)
    },
    takeHandoff: (path) => takeHandoffFile(path),
    privacy: (config) => runPrivacyCheck(config, realPrivacyDeps),
    engines: (config) => checkTeamEngines(realEngineCheckDeps(config.home)),
    setupDecision: {
      clear: () => writeTeamSetupDecision(teamSetupDecisionFile(env.ADAPTER_DATA_DIR), null),
      decline: () => writeTeamSetupDecision(teamSetupDecisionFile(env.ADAPTER_DATA_DIR), { state: 'declined', at: Date.now() }),
    },
    stopDaemon: options.stopDaemon,
    startDaemon: options.startDaemon,
    ...(options.signIn ? { signIn: options.signIn } : {}),
  }
}
