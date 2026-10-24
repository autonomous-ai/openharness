/**
 * `harness team setup | status | remove | on | off` (docs/plans/2026-10-24-swarm-team-account.md, Task 2).
 *
 * On a Mac, Swarm work from teammates runs in the Harness Team account: a separate standard user with its own Harness
 * daemon, which cannot read the owner's files. A computer used only for agents (a Mac mini, a Linux or Windows box)
 * needs no second user: `harness team on` signs that computer in for team work only.
 *
 * Internal verbs, run by the scripts and the team daemon's job, not by people:
 *   __handoff          (as the owner, from setup's script) print a fresh team sign-in code
 *   __start <file>     (as the team account, before its daemon) redeem a handed-over code, run the privacy check
 *   __signout          (as the team account, from remove's script) sign its session out of Harness
 *
 * Nothing here falls back to the owner: a team account that is missing, signed out or not private is reported, and
 * team work does not run as the owner instead.
 */
import type { AuthSession } from '../lib/authSession.js'
import type { RunAdmin } from './admin.js'
import { teamConfigJson, type TeamConfig } from './config.js'
import { engineLines, type TeamEngines } from './engines.js'
import { mintTeamConversion, mintTeamHandoff, redeemTeamHandoff, revokeHarnessRefresh, teamSession, TeamSignInError, type Get, type Post } from './handoff.js'
import {
  SENTINEL_NAME, TEAM_CONFIG_FILE, TEAM_HOME, TEAM_LABEL, TEAM_PLIST, TEAM_PORT, TEAM_REAL_NAME, TEAM_STATUS_DIR, TEAM_STATUS_FILE,
  TEAM_USER, TeamInputError, carriedBackendEnv, checkPath, checkUser, teamPaths,
} from './layout.js'
import type { PrivacyResult, TeamStatus } from './privacy.js'
import { buildRemoveScript, buildSetupScript, teamLaunchdPlist } from './script.js'

export const TEAM_USAGE = [
  'Usage: harness team <setup | status | remove | on | off> [--json]',
  '',
  '  setup     make the Harness Team account on this Mac for Swarm work: a separate standard user, "Harness Team"',
  `            (${TEAM_USER}), whose own Harness daemon runs teammates' agents so they cannot read your files. macOS asks`,
  '            for an administrator password once. It installs the account\'s own Claude Code and Codex, which you sign in',
  '            once in a terminal on its machine. Running it again repairs it (--sign-in-again: a new sign-in for it)',
  '  status    whether the account exists and runs, its sign-in, privacy check and engines, and everything setup made',
  '  remove    delete the account, its home folder and its daemon (administrator password); your home stays private',
  '  on        for a computer used only for agents (a Mac mini, a Linux or Windows box): sign it in for team work',
  '            only. It then runs Swarm agents and reaches none of your other computers (--yes skips the question)',
  '  off       sign this computer out of team work, then sign it in as your own computer again',
].join('\n')

export const SETUP_PROMPT = 'Harness wants to create a separate account, Harness Team, for Swarm work on this Mac, so teammates\' agents cannot read your files.'
export const REMOVE_PROMPT = 'Harness wants to remove the Harness Team account, its home folder and its daemon from this Mac.'

/** How long setup waits for the team daemon to sign in and report its privacy check. */
export const SETUP_REPORT_WAIT_MS = 90_000

export interface Installed {
  /** The owner's installed CLI folder and its cli.js. */
  cliDir: string
  cliJs: string
  /** The managed Node the installed CLI runs on, and its runtime folder (null without a managed runtime). */
  node: string
  nodeRuntimeDir: string | null
  tmuxRuntimeDir: string | null
}

export interface JobState { loaded: boolean; pid: number | null; state: string | null }

export interface TeamCommandDeps {
  platform: NodeJS.Platform
  out(line: string): void
  err(line: string): void
  /** This process's account, home and uid. */
  user(): string
  home(): string
  uid(): number
  hostname(): string
  env: NodeJS.ProcessEnv
  interactive: boolean
  ask(question: string): Promise<string>
  now(): number
  sleep(ms: number): Promise<void>

  session(): AuthSession | null
  writeSession(session: AuthSession): void
  clearSession(): void
  /** Bearer headers for this computer's sign-in, refreshed when stale (lib/controlPlane.ts). */
  auth(): Promise<{ session: AuthSession; headers: Record<string, string> }>
  post: Post
  get: Get
  /** This computer's machine key on the account's device key log (lib/e2ee/store.ts), never made here; null when it has
   *  none. `team on` signs with it to show the backend it is this computer. */
  machineKey(): { priv: Uint8Array } | null
  computerId(): string
  autonomousEnv: 'prod' | 'stag'

  installed(): Installed
  exists(path: string): boolean
  /** A path's permission bits, or null when it cannot be read. */
  mode(path: string): number | null
  admin: RunAdmin
  readConfig(): TeamConfig | null
  readStatus(path: string): TeamStatus | null
  writeStatus(path: string, update: Partial<Omit<TeamStatus, 'version'>>): void
  accountExists(user: string): Promise<boolean>
  jobState(label: string): Promise<JobState>

  /** The team account's side: its handed-over code, the privacy check, and its own Claude Code and Codex (./engines.ts). */
  takeHandoff(path: string): string | null
  privacy(config: TeamConfig): PrivacyResult
  engines(config: TeamConfig): Promise<TeamEngines>

  /** This computer's daemon: stopped (true when one was running), started again (prints its status and may exit),
   *  and the ordinary sign-in, for `team off` (which starts the daemon again when [restart]). */
  stopDaemon(): Promise<boolean>
  startDaemon(): Promise<void>
  signIn?(restart: boolean): Promise<void>
}

export async function teamCommand(argv: string[], deps: TeamCommandDeps): Promise<number> {
  const words = argv.filter((arg) => !arg.startsWith('-'))
  const flags = argv.filter((arg) => arg.startsWith('-'))
  const json = flags.includes('--json')
  const verb = words[0]
  if (verb === undefined || verb === 'help' || flags.includes('-h') || flags.includes('--help')) {
    deps.out(TEAM_USAGE)
    return 0
  }
  try {
    switch (verb) {
      case 'setup': return await setup(deps, json, flags.includes('--sign-in-again'))
      case 'status': return await status(deps, json)
      case 'remove': return await remove(deps, json)
      case 'on': return await teamOn(deps, json, flags.includes('--yes'))
      case 'off': return await teamOff(deps, json)
      case '__handoff': return await handoff(deps)
      case '__start': return await jobStart(deps, words[1])
      case '__signout': return await signOut(deps)
      default:
        deps.err(`Unknown command: harness team ${verb}\n\n${TEAM_USAGE}`)
        return 2
    }
  } catch (error) {
    if (!(error instanceof TeamInputError) && !(error instanceof TeamSignInError)) throw error
    return fail(deps, json, error instanceof TeamSignInError ? error.code : 'INVALID_INPUT', error.message)
  }
}

function fail(deps: TeamCommandDeps, json: boolean, code: string, message: string, extra: Record<string, unknown> = {}): number {
  if (json) deps.out(JSON.stringify({ ok: false, code, message, ...extra }))
  else deps.err(`✗ ${message}`)
  return 1
}

/** What setup makes, said plainly so anyone can audit it or take it off the Mac by hand. */
function madeLines(ownerHome: string): string[] {
  const team = teamPaths()
  return [
    `  account   ${TEAM_REAL_NAME} (${TEAM_USER}): a standard user with no usable password, shown in Users & Groups`,
    `  home      ${TEAM_HOME}`,
    `  daemon    ${TEAM_LABEL}, a LaunchDaemon at ${TEAM_PLIST}, running as ${TEAM_USER} on port ${TEAM_PORT}`,
    `  log       ${team.log} (inside the account's home)`,
    `  setup     ${TEAM_CONFIG_FILE} and ${TEAM_STATUS_DIR}/`,
    `  check     ${ownerHome}/${SENTINEL_NAME}, a file the account must not be able to read`,
    `  engines   Claude Code and Codex in ${TEAM_HOME}/.local, installed by the account itself`,
    `  your home ${ownerHome}, made private (mode 700)`,
  ]
}

function byHandLines(ownerHome: string): string[] {
  return [
    '  To remove it by hand:',
    `    sudo launchctl bootout system/${TEAM_LABEL}; sudo rm ${TEAM_PLIST}`,
    `    sudo dscl . -delete /Users/${TEAM_USER}; sudo rm -rf ${TEAM_HOME}`,
    `    sudo rm -rf '${TEAM_CONFIG_FILE}' '${TEAM_STATUS_DIR}'; rm ${ownerHome}/${SENTINEL_NAME}`,
  ]
}

const notMac = 'The Harness Team account is made on a Mac. On a computer used only for agents, run `harness team on`.'

async function setup(deps: TeamCommandDeps, json: boolean, signInAgain: boolean): Promise<number> {
  if (deps.platform !== 'darwin') return fail(deps, json, 'UNSUPPORTED', notMac)
  if (deps.uid() === 0) return fail(deps, json, 'RUN_AS_YOURSELF', 'Run this as yourself, not with sudo: macOS asks for an administrator password itself.')
  const session = deps.session()
  if (!session) return fail(deps, json, 'NOT_SIGNED_IN', 'Sign this computer in first (harness login): the team account is signed in from your sign-in.')
  if (session.kind === 'team') return fail(deps, json, 'TEAM_SESSION', 'This computer already runs team work only (harness team on): it needs no Harness Team account.')
  const owner = checkUser(deps.user(), 'owner account')
  const ownerHome = checkPath(deps.home(), 'home folder')
  if (owner === TEAM_USER) return fail(deps, json, 'RUN_AS_YOURSELF', 'Run this from your own account, not the Harness Team account.')
  const installed = deps.installed()
  if (!deps.exists(installed.cliJs) || !installed.nodeRuntimeDir) {
    return fail(deps, json, 'NOT_INSTALLED', 'Harness is not installed for this account (no ~/.harness/cli/cli.js and Node runtime to copy). Install it, then run this again.')
  }
  const carried = carriedBackendEnv(deps.env)
  const mintEnv: Record<string, string> = { ...carried }
  if (deps.env.HARNESS_AUTH_DIR?.trim()) mintEnv.HARNESS_AUTH_DIR = checkPath(deps.env.HARNESS_AUTH_DIR.trim(), 'HARNESS_AUTH_DIR')
  delete mintEnv.ADAPTER_UPDATE_DISABLE
  const team = teamPaths()
  const nodeName = installed.nodeRuntimeDir.slice(installed.nodeRuntimeDir.lastIndexOf('/') + 1)
  const teamNode = `${team.runtime}/${nodeName}/bin/node`
  const config: TeamConfig = {
    version: 1, user: TEAM_USER, realName: TEAM_REAL_NAME, home: TEAM_HOME, owner, ownerHome,
    sentinel: `${ownerHome}/${SENTINEL_NAME}`, port: TEAM_PORT, label: TEAM_LABEL, plist: TEAM_PLIST,
    statusFile: TEAM_STATUS_FILE, node: teamNode, cli: team.cliJs, env: carried, createdAt: new Date(deps.now()).toISOString(),
  }
  const plist = teamLaunchdPlist({ user: TEAM_USER, home: TEAM_HOME, node: teamNode, cli: team.cliJs, port: TEAM_PORT, env: carried })
  if (!json) {
    deps.out('Harness will set up a separate account for Swarm work on this Mac. macOS asks for an administrator password once.')
    for (const line of madeLines(ownerHome)) deps.out(line)
  }
  const startedAt = deps.now()
  const result = await deps.admin((stageDir) => ({
    script: buildSetupScript({
      user: TEAM_USER, realName: TEAM_REAL_NAME, home: TEAM_HOME, owner, ownerHome, stageDir,
      nodeRuntimeDir: installed.nodeRuntimeDir!, tmuxRuntimeDir: installed.tmuxRuntimeDir, cliDir: installed.cliDir,
      ownerNode: installed.node, ownerCli: installed.cliJs, mintEnv, signIn: signInAgain ? 'always' : 'missing',
    }),
    files: { 'team.json': teamConfigJson(config), 'team.plist': plist },
  }), SETUP_PROMPT)
  if (!result.ok) {
    if (result.code === 'CANCELLED') return fail(deps, json, 'CANCELLED', 'Nothing was changed: the administrator prompt was cancelled.')
    return fail(deps, json, 'SETUP_FAILED', `The Harness Team account was not finished: ${result.message} Run \`harness team setup\` again; it repairs what is there.`)
  }
  const handedOver = /handed a sign-in to the team account/.test(result.stdout)
  if (!json) deps.out(handedOver ? 'Waiting for the team daemon to sign in and check its privacy…' : 'Waiting for the team daemon to check its privacy…')
  // The daemon reports through its status file (./privacy.ts): the sign-in when it redeemed one, the check every start.
  let report: TeamStatus | null = null
  // From now, not from before the prompt: a person may take longer than this to answer it.
  const deadline = deps.now() + SETUP_REPORT_WAIT_MS
  for (;;) {
    report = deps.readStatus(TEAM_STATUS_FILE)
    const checked = (report?.privacy?.checkedAt ?? 0) >= startedAt
    const signed = !handedOver || (report?.signIn?.at ?? 0) >= startedAt
    if ((checked && signed) || deps.now() >= deadline) break
    await deps.sleep(1_000)
  }
  const privacy = report?.privacy && report.privacy.checkedAt >= startedAt ? report.privacy : null
  const signIn = report?.signIn && (!handedOver || report.signIn.at >= startedAt) ? report.signIn : null
  const engines = report?.engines && report.engines.checkedAt >= startedAt ? report.engines : undefined
  if (json) {
    const ok = privacy?.passed === true && (!handedOver || signIn?.state === 'signed-in')
    deps.out(JSON.stringify({ ok, user: TEAM_USER, home: TEAM_HOME, label: TEAM_LABEL, plist: TEAM_PLIST, privacy, signIn, engines: engines ?? null }))
    return ok ? 0 : 1
  }
  let code = 0
  if (handedOver && signIn?.state === 'signed-in') deps.out('✓ The Harness Team account is signed in.')
  else if (handedOver && signIn) { deps.err(`✗ The team account did not sign in: ${signIn.detail ?? signIn.state}`); code = 1 }
  else if (handedOver) deps.out('! The team daemon has not signed in yet: harness team status')
  if (privacy?.passed) deps.out('✓ Private: the team account cannot read your files.')
  else if (privacy) { deps.err(`✗ Not private (${privacy.item}): ${privacy.detail}`); code = 1 }
  else deps.out('! The team daemon has not reported its privacy check yet: harness team status')
  // Installed by setup into the team account's own home; signed in once by the owner, in a terminal on the team machine.
  for (const line of engineLines(engines, (at) => ago(deps.now(), at))) deps.out(line)
  deps.out('  status: harness team status   ·   undo: harness team remove')
  return code
}

function ago(now: number, at: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 90) return `${seconds}s ago`
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m ago`
  return `${Math.round(seconds / 3600)}h ago`
}

async function status(deps: TeamCommandDeps, json: boolean): Promise<number> {
  const session = deps.session()
  const dedicated = session?.kind === 'team'
  const config = deps.platform === 'darwin' ? deps.readConfig() : null
  const exists = deps.platform === 'darwin' ? await deps.accountExists(config?.user ?? TEAM_USER) : false
  if (!config && !exists) {
    if (json) deps.out(JSON.stringify({ account: false, dedicated }))
    else if (dedicated) deps.out('This computer runs team work only (harness team on): Swarm agents run here, and it reaches none of your other computers.\n  undo: harness team off')
    else deps.out(`No Harness Team account on this computer.${deps.platform === 'darwin' ? ' harness team setup makes one.' : ' On a computer used only for agents: harness team on.'}`)
    return 0
  }
  const user = config?.user ?? TEAM_USER
  const home = config?.home ?? TEAM_HOME
  const ownerHome = config?.ownerHome ?? deps.home()
  const job = await deps.jobState(config?.label ?? TEAM_LABEL)
  const report = deps.readStatus(config?.statusFile ?? TEAM_STATUS_FILE)
  const homeMode = deps.mode(ownerHome)
  const plistPresent = deps.exists(config?.plist ?? TEAM_PLIST)
  if (json) {
    deps.out(JSON.stringify({
      account: exists, user, realName: config?.realName ?? TEAM_REAL_NAME, home, homePresent: deps.exists(home),
      label: config?.label ?? TEAM_LABEL, plist: config?.plist ?? TEAM_PLIST, plistPresent, job, port: config?.port ?? TEAM_PORT,
      config: config ? TEAM_CONFIG_FILE : null, ownerHomeMode: homeMode === null ? null : homeMode.toString(8),
      signIn: report?.signIn ?? null, privacy: report?.privacy ?? null, engines: report?.engines ?? null, dedicated,
    }))
    return 0
  }
  const now = deps.now()
  deps.out(`Harness Team account · ${config?.realName ?? TEAM_REAL_NAME} (${user})`)
  deps.out(`  account     ${exists ? '● exists' : '○ missing · harness team setup makes it again'}`)
  deps.out(`  daemon      ${job.pid !== null ? `● running (pid ${job.pid})` : job.loaded ? `◍ loaded, not running${job.state ? ` (${job.state})` : ''}` : plistPresent ? '○ installed, not loaded · harness team setup starts it' : '○ not installed · harness team setup installs it'}`)
  const signIn = report?.signIn
  deps.out(`  sign-in     ${!signIn ? '? not reported yet' : signIn.state === 'signed-in' ? `✓ signed in (${ago(now, signIn.at)})` : `✗ ${signIn.state}${signIn.detail ? `: ${signIn.detail}` : ''}`}`)
  const privacy = report?.privacy
  deps.out(`  privacy     ${!privacy ? '? not checked yet' : privacy.passed ? `Private ✓ (checked ${ago(now, privacy.checkedAt)})` : `✗ ${privacy.item}: ${privacy.detail} (checked ${ago(now, privacy.checkedAt)})`}`)
  deps.out(`  your home   ${ownerHome} · mode ${homeMode === null ? 'unknown' : homeMode.toString(8)}${homeMode === 0o700 ? ' ✓' : ' ✗ should be 700: harness team setup makes it private again'}`)
  for (const line of engineLines(report?.engines, (at) => ago(now, at))) deps.out(line)
  deps.out('')
  deps.out('  What setup made:')
  for (const line of madeLines(ownerHome)) deps.out(`  ${line}`)
  deps.out('')
  deps.out('  undo: harness team remove')
  for (const line of byHandLines(ownerHome)) deps.out(line)
  return 0
}

async function remove(deps: TeamCommandDeps, json: boolean): Promise<number> {
  if (deps.platform !== 'darwin') return fail(deps, json, 'UNSUPPORTED', 'The Harness Team account is made on a Mac; this computer has none. To stop team work here: harness team off.')
  if (deps.uid() === 0) return fail(deps, json, 'RUN_AS_YOURSELF', 'Run this as yourself, not with sudo: macOS asks for an administrator password itself.')
  const config = deps.readConfig()
  const ownerHome = checkPath(config?.ownerHome ?? deps.home(), 'home folder')
  if (!config && !await deps.accountExists(TEAM_USER) && !deps.exists(TEAM_PLIST) && !deps.exists(TEAM_HOME)) {
    if (json) deps.out(JSON.stringify({ ok: true, removed: false }))
    else deps.out('No Harness Team account on this Mac; nothing to remove.')
    return 0
  }
  const result = await deps.admin(() => ({
    script: buildRemoveScript({ user: config?.user ?? TEAM_USER, home: config?.home ?? TEAM_HOME, ownerHome,
      teamNode: config?.node ?? null, teamCli: config?.cli ?? null, env: config?.env ?? {} }),
  }), REMOVE_PROMPT)
  if (!result.ok) {
    if (result.code === 'CANCELLED') return fail(deps, json, 'CANCELLED', 'Nothing was removed: the administrator prompt was cancelled.')
    return fail(deps, json, 'REMOVE_FAILED', `The Harness Team account was not fully removed: ${result.message} Run \`harness team remove\` again.`)
  }
  if (json) deps.out(JSON.stringify({ ok: true, removed: true }))
  else {
    deps.out(`✓ Removed the Harness Team account (${TEAM_USER}), ${TEAM_HOME} and the daemon ${TEAM_LABEL}.`)
    deps.out(`  Your home folder stays private (mode 700). Its computer stays in your list until you remove it: harness machines`)
  }
  return 0
}

async function teamOn(deps: TeamCommandDeps, json: boolean, yes: boolean): Promise<number> {
  const session = deps.session()
  if (!session) return fail(deps, json, 'NOT_SIGNED_IN', 'Sign this computer in first (harness login), then run harness team on.')
  if (session.kind === 'team') {
    if (json) deps.out(JSON.stringify({ ok: true, changed: false }))
    else deps.out('This computer already runs team work only. undo: harness team off')
    return 0
  }
  if (deps.platform === 'darwin' && deps.readConfig()) {
    return fail(deps, json, 'TEAM_ACCOUNT', 'This Mac has a Harness Team account, which runs its team work. `harness team on` is for a computer used only for agents.')
  }
  if (!yes) {
    if (!deps.interactive || json) return fail(deps, json, 'CONFIRM', 'Add --yes to sign this computer in for team work only.')
    deps.out('This computer will run Swarm agents for your team and will no longer reach your other computers.')
    deps.out('Use it only on a computer used for agents alone: they can read everything this account can.')
    const answer = (await deps.ask('Sign this computer in for team work only? [y/N] ')).trim()
    if (!/^y(es)?$/i.test(answer)) return fail(deps, json, 'CANCELLED', 'Nothing was changed.')
  }
  const label = `${deps.hostname().slice(0, 60)} · Team`
  const unchanged = (error: unknown) => error instanceof TeamSignInError
    ? new TeamSignInError(`${error.message} Nothing was changed on this computer.`, error.code) : error
  // A code that turns this very computer into a team machine, keeping its computer id (./handoff.ts).
  let code: string
  try {
    ({ code } = await mintTeamConversion({ auth: () => deps.auth(), post: deps.post, get: deps.get, machineKey: deps.machineKey, now: deps.now }))
  } catch (error) { throw unchanged(error) }
  // Stopped before the code is redeemed: redeeming ends this computer's ordinary sign-in on the backend, and a daemon still
  // running on it, an Autonomous one above all, would connect again under it and make this an ordinary machine again.
  const wasRunning = await deps.stopDaemon()
  let tokens: Awaited<ReturnType<typeof redeemTeamHandoff>>
  try {
    tokens = await redeemTeamHandoff(code, label, session.computerId, { post: deps.post, sleep: deps.sleep, now: deps.now })
  } catch (error) {
    if (wasRunning) await deps.startDaemon()
    throw unchanged(error)
  }
  // The team sign-in takes the previous one's place in the session file, so nothing here can sign in with that one again.
  const previous = deps.session() ?? session
  deps.writeSession(teamSession(tokens, session.computerId, deps.autonomousEnv, deps.now(),
    session.machineId ? { machineId: session.machineId } : {}))
  await revokeHarnessRefresh(deps.post, previous.refreshToken)
  if (json) deps.out(JSON.stringify({ ok: true, changed: true }))
  else deps.out('✓ This computer now runs team work only. Its previous sign-in was discarded. undo: harness team off')
  if (wasRunning) await deps.startDaemon()
  return 0
}

async function teamOff(deps: TeamCommandDeps, json: boolean): Promise<number> {
  const session = deps.session()
  if (session?.kind !== 'team') {
    if (json) deps.out(JSON.stringify({ ok: true, changed: false }))
    else deps.out('This computer does not run team work only; nothing to change.')
    return 0
  }
  const wasRunning = await deps.stopDaemon()
  await revokeHarnessRefresh(deps.post, session.refreshToken)
  deps.clearSession()
  if (json) {
    deps.out(JSON.stringify({ ok: true, changed: true, next: 'harness login' }))
    if (wasRunning) await deps.startDaemon()
    return 0
  }
  deps.out('✓ Signed this computer out of team work.')
  // A team sign-in cannot hand out a computer's one (Task 1): signing in again is the ordinary sign-in.
  if (deps.interactive && deps.signIn) {
    await deps.signIn(wasRunning)
    return 0
  }
  deps.out('  Sign it in as your own computer: harness login')
  if (wasRunning) await deps.startDaemon()
  return 0
}

/** `team __handoff`: run as the owner by setup's script, the moment the code is handed over. Prints only the code. */
async function handoff(deps: TeamCommandDeps): Promise<number> {
  const { code } = await mintTeamHandoff(() => deps.auth(), deps.post)
  deps.out(code)
  return 0
}

/**
 * `team __start <file>`: run by the team daemon's job, as the team account, before its master starts. Its lines go
 * to the daemon's log. Always exits 0: the daemon starts either way, signed out if the sign-in failed, and reports
 * the privacy check it failed. Team work never runs as the owner instead.
 */
async function jobStart(deps: TeamCommandDeps, file: string | undefined): Promise<number> {
  const config = deps.readConfig()
  const mine = config && config.user === deps.user() ? config : null
  const statusFile = mine?.statusFile ?? TEAM_STATUS_FILE
  const log = (line: string) => deps.out(`${new Date(deps.now()).toISOString()} [team] ${line}`)
  const report = (update: Partial<Omit<TeamStatus, 'version'>>) => {
    if (!mine) return
    try { deps.writeStatus(statusFile, update) } catch (error) { log(`could not write ${statusFile}: ${(error as Error).message}`) }
  }
  if (file) {
    let code: string | null = null
    try {
      code = deps.takeHandoff(checkPath(file, 'sign-in file'))
    } catch (error) {
      log((error as Error).message)
      report({ signIn: { state: 'failed', at: deps.now(), detail: (error as Error).message } })
    }
    if (code && deps.session()) {
      log('already signed in; the handed-over sign-in code was not used')
      report({ signIn: { state: 'signed-in', at: deps.now() } })
    } else if (code) {
      const label = `${deps.hostname().slice(0, 60)} · Team`
      try {
        const computerId = deps.computerId()
        const tokens = await redeemTeamHandoff(code, label, computerId, { post: deps.post, sleep: deps.sleep, now: deps.now })
        deps.writeSession(teamSession(tokens, computerId, deps.autonomousEnv, deps.now()))
        log('signed in for team work')
        report({ signIn: { state: 'signed-in', at: deps.now() } })
      } catch (error) {
        log(`sign-in failed: ${(error as Error).message}`)
        report({ signIn: { state: 'failed', at: deps.now(), detail: (error as Error).message } })
      }
    }
  }
  if (mine) {
    const privacy = deps.privacy(mine)
    log(privacy.passed ? 'privacy check passed' : `privacy check FAILED (${privacy.item}): ${privacy.detail}`)
    report({ privacy })
    try {
      const engines = await deps.engines(mine)
      log(`engines: ${(['claude', 'codex'] as const).map((e) => `${e} ${engines[e].installed ? engines[e].signedIn === true ? 'signed in' : 'installed' : 'missing'}`).join(', ')}`)
      report({ engines })
    } catch (error) { log(`could not check the engines: ${(error as Error).message}`) }
  }
  return 0
}

/** `team __signout`: run as the team account by remove's script, before the account is deleted. */
async function signOut(deps: TeamCommandDeps): Promise<number> {
  const session = deps.session()
  if (session) await revokeHarnessRefresh(deps.post, session.refreshToken)
  deps.clearSession()
  const config = deps.readConfig()
  if (config && config.user === deps.user()) {
    try { deps.writeStatus(config.statusFile, { signIn: { state: 'signed-out', at: deps.now() } }) } catch { /* removed next */ }
  }
  return 0
}
