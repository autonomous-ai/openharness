/**
 * `harness team setup | status | remove | on | off` (docs/plans/2026-10-24-swarm-team-account.md, Task 2).
 *
 * On a Mac or a Linux computer, Swarm work from teammates runs in the Harness Team account: a separate standard user with
 * its own Harness daemon, which cannot read the owner's files (Linux: docs/superpowers/plans/2026-10-28-harness-team-account-linux.md).
 * A computer used only for agents (a Mac mini, a Linux or Windows box) needs no second user: `harness team on` signs that
 * computer in for team work only.
 *
 * Internal verbs, run by the scripts and the team daemon's job, not by people:
 *   __handoff          (as the owner, from setup's script) print a fresh team sign-in code
 *   __start <file>     (as the team account, before its daemon) redeem a handed-over code, run the privacy check
 *
 * Nothing here falls back to the owner: a team account that is missing, signed out or not private is reported, and
 * team work does not run as the owner instead.
 */
import type { AuthSession } from '../lib/authSession.js'
import { SIGN_OUT_BUTTON_FLAG, type SignOutAsked } from '../lib/signOut.js'
import type { AdminVia, RunAdmin } from './admin.js'
import { teamConfigJson, type TeamConfig } from './config.js'
import { engineLines, type TeamEngines } from './engines.js'
import { mintTeamConversion, mintTeamHandoff, redeemTeamHandoff, revokeHarnessRefresh, teamSession, TeamSignInError, type Delete, type Get, type Post } from './handoff.js'
import {
  SENTINEL_NAME, TEAM_PORT, TEAM_REAL_NAME, TEAM_STATUS_FILE,
  TEAM_USER, TeamInputError, carriedBackendEnv, checkPath, checkUser, teamLayout, teamPaths, type TeamLayout, type TeamPlatform,
} from './layout.js'
import type { PrivacyResult, TeamStatus } from './privacy.js'
import {
  LINUX_NO_SYSTEMD, LINUX_NO_TMUX, REMOVE_REFUSED, TEAM_COMPUTER_LINE, buildLinuxRemoveScript, buildLinuxSetupScript, buildRemoveScript,
  buildSetupScript, teamLaunchdPlist, teamSystemdUnit, type RemoveScriptInput, type SetupScriptInput, type TeamPlistInput,
} from './script.js'

/** How a platform with a Harness Team account makes and removes it. Windows has its own plan
 *  (docs/superpowers/plans/2026-10-28-harness-team-account-windows.md) and none yet. */
interface TeamScripts {
  setup(input: SetupScriptInput): string
  remove(input: RemoveScriptInput): string
  /** The team daemon's service definition. */
  service(input: TeamPlistInput): string
  /** Its name in the staging folder, where the setup script installs it from. */
  serviceFile: string
}

const SCRIPTS: Partial<Record<TeamPlatform, TeamScripts>> = {
  darwin: { setup: buildSetupScript, remove: buildRemoveScript, service: teamLaunchdPlist, serviceFile: 'team.plist' },
  linux: { setup: buildLinuxSetupScript, remove: buildLinuxRemoveScript, service: teamSystemdUnit, serviceFile: 'team.service' },
}

interface TeamHere { layout: TeamLayout; scripts: TeamScripts; mac: boolean; where: string }

/** This computer's layout and scripts, or null where `harness team setup` makes no account. */
function teamHere(platform: NodeJS.Platform): TeamHere | null {
  const layout = teamLayout(platform)
  const scripts = layout ? SCRIPTS[layout.platform] : undefined
  if (!layout || !scripts) return null
  const mac = layout.platform === 'darwin'
  return { layout, scripts, mac, where: mac ? 'this Mac' : 'this computer' }
}

export const TEAM_USAGE = [
  'Usage: harness team <setup | status | remove | on | off> [--json]',
  '',
  '  setup     make the Harness Team account on this Mac or Linux computer for Swarm work: a separate standard user,',
  `            "Harness Team" (${TEAM_USER}), whose own Harness daemon runs teammates' agents so they cannot read your files.`,
  '            The system asks for an administrator password once. It installs the account\'s own Claude Code and Codex,',
  '            which you sign in once in a terminal on its machine. Running it again repairs it (--sign-in-again: a new sign-in)',
  '  status    whether the account exists and runs, its sign-in, privacy check and engines, and everything setup made',
  '  remove    delete the account, its home folder and its daemon; your home stays private. Run it in Terminal: sudo',
  '            asks for your password, and macOS asks once to let Terminal administer your computer, which it needs',
  '  on        for a computer used only for agents (a Mac mini, a Linux or Windows box): sign it in for team work',
  '            only. It then runs Swarm agents and reaches none of your other computers (--yes skips the question)',
  '  off       sign this computer out of team work, then sign it in as your own computer again',
].join('\n')

/** What the administrator prompt says (sudo's prompt on Linux; pkexec shows polkit's own words). */
const prompts = (where: string) => ({
  setup: `Harness wants to create a separate account, Harness Team, for Swarm work on ${where}, so teammates' agents cannot read your files.`,
  repair: `Harness wants to repair the Harness Team account, which runs Swarm work on ${where} so teammates' agents cannot read your files.`,
  remove: `Harness wants to remove the Harness Team account, its home folder and its daemon from ${where}.`,
})
export const SETUP_PROMPT = prompts('this Mac').setup
/** The same script on a Mac that has the account: it repairs what is there. (The dialog's title, "osascript", is the
 *  process that asks, and osascript cannot change it.) */
export const REPAIR_PROMPT = prompts('this Mac').repair
export const REMOVE_PROMPT = prompts('this Mac').remove

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
  /** Rewrites the newest sign-in under the refresh lock, leaving a signed-out mark alone (lib/authSession.ts
   *  `updateAuthSession`): [change] gives the new one, or null to leave it. */
  updateSession(change: (latest: AuthSession) => AuthSession | null): Promise<AuthSession | null>
  /** How a person asked for this computer's sign-in to go, or null when nothing says one did (lib/signOut.ts). */
  signOutAsked(flags: readonly string[]): SignOutAsked | null
  /** Takes the sign-in away, logged with who asked (lib/signOut.ts `removeSignIn`). */
  removeSignIn(asked: SignOutAsked): void
  /** Bearer headers for this computer's sign-in, refreshed when stale (lib/controlPlane.ts). */
  auth(): Promise<{ session: AuthSession; headers: Record<string, string> }>
  post: Post
  get: Get
  delete: Delete
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
  /** What Desktop's automatic offer remembers (./autoSetup.ts): a setup that made the account forgets a cancelled prompt,
   *  and a removal is remembered as one, so the account is not made again on its own. */
  setupDecision?: { clear(): void; decline(): void }
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
      case 'off': return await teamOff(deps, json, flags)
      case '__handoff': return await handoff(deps)
      case '__start': return await jobStart(deps, words[1])
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

/** The folder above the status folder on Linux (/var/lib/harness), which setup also made and marked. */
const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))

/** What setup makes, said plainly so anyone can audit it or take it off the computer by hand. */
function madeLines({ layout, mac }: TeamHere, owner: string, ownerHome: string): string[] {
  const team = teamPaths(layout.home)
  const { label, file } = layout.service
  return [
    mac
      ? `  account   ${TEAM_REAL_NAME} (${TEAM_USER}): a standard user with a random password nobody knows, listed in Users & Groups`
      : `  account   ${TEAM_REAL_NAME} (${TEAM_USER}): a standard user with a locked password, never an administrator`,
    `  home      ${layout.home}`,
    `  daemon    ${label}, ${mac ? 'a LaunchDaemon' : 'a systemd unit'} at ${file}, running as ${TEAM_USER} on port ${TEAM_PORT}`,
    `  log       ${team.log} (inside the account's home)`,
    `  setup     ${layout.configFile} and ${layout.statusDir}/`,
    ...mac ? [] : [`  relay     ${layout.relayDir(owner)}, yours, which the account may read to use your subscriptions`],
    `  check     ${ownerHome}/${SENTINEL_NAME}, a file the account must not be able to read`,
    `  engines   Claude Code and Codex in ${layout.home}/.local, installed by the account itself`,
    `  your home ${ownerHome}, made private (mode 700)`,
  ]
}

function byHandLines({ layout, mac }: TeamHere, owner: string, ownerHome: string): string[] {
  const { label, file } = layout.service
  if (!mac) {
    const state = parentOf(layout.statusDir)
    const stateMark = `${state}/${layout.sharedMark.slice(layout.sharedMark.lastIndexOf('/') + 1)}`
    return [
      '  To remove it by hand, in a terminal:',
      `    sudo systemctl disable --now ${label}; sudo pkill -KILL -u ${TEAM_USER}; sudo userdel -r ${TEAM_USER}`,
      `    sudo rm ${file}; sudo rm -rf ${layout.configFile} ${layout.statusDir} ${layout.relayDir(owner)} ${layout.sharedMark} ${stateMark}`,
      `    rm ${ownerHome}/${SENTINEL_NAME}; sudo rmdir ${layout.sharedDir} ${state}   (only when they are empty)`,
    ]
  }
  return [
    '  To remove it by hand, in Terminal (macOS asks to let Terminal administer your computer for the first line):',
    `    sudo dscl . -delete /Users/${TEAM_USER}`,
    `    sudo launchctl bootout system/${label}; sudo rm ${file}; sudo rm -rf ${layout.home}`,
    `    sudo rm -rf '${layout.configFile}' '${layout.statusDir}' '${layout.sharedMark}'; rm ${ownerHome}/${SENTINEL_NAME}`,
    `    sudo rmdir '${layout.sharedDir}'   (only when it is empty)`,
  ]
}

const notMac = 'The Harness Team account is made on a Mac or a Linux computer. On a computer used only for agents, run `harness team on`.'

/** Why the Linux setup script stopped before it made anything, by the code `harness team setup --json` answers. */
const LINUX_REFUSALS: ReadonlyMap<string, string> = new Map([[LINUX_NO_SYSTEMD, 'NO_SYSTEMD'], [LINUX_NO_TMUX, 'NO_TMUX']])

/** A script's reason as a sentence, so the one after it does not run on: the scripts' own reasons end without a stop. */
const sentence = (text: string): string => /[.!?]$/.test(text) ? text : `${text}.`

async function setup(deps: TeamCommandDeps, json: boolean, signInAgain: boolean): Promise<number> {
  const here = teamHere(deps.platform)
  if (!here) return fail(deps, json, 'UNSUPPORTED', notMac)
  const { layout, scripts, mac } = here
  if (deps.uid() === 0) {
    return fail(deps, json, 'RUN_AS_YOURSELF', `Run this as yourself, not with sudo: ${mac ? 'macOS' : 'Harness'} asks for an administrator password itself.`)
  }
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
  const team = teamPaths(layout.home)
  const nodeName = installed.nodeRuntimeDir.slice(installed.nodeRuntimeDir.lastIndexOf('/') + 1)
  const teamNode = `${team.runtime}/${nodeName}/bin/node`
  const config: TeamConfig = {
    version: 1, user: TEAM_USER, realName: TEAM_REAL_NAME, home: layout.home, owner, ownerHome,
    sentinel: `${ownerHome}/${SENTINEL_NAME}`, port: TEAM_PORT, label: layout.service.label, plist: layout.service.file,
    statusFile: layout.statusFile, node: teamNode, cli: team.cliJs, env: carried, createdAt: new Date(deps.now()).toISOString(),
  }
  const service = scripts.service({ user: TEAM_USER, home: layout.home, node: teamNode, cli: team.cliJs, port: TEAM_PORT, env: carried })
  const repair = deps.readConfig() !== null || await deps.accountExists(TEAM_USER)
  // Linux: sudo in a terminal, which works over SSH too; polkit's dialog otherwise (Desktop's offer), when there is a desktop.
  const via: AdminVia | undefined = mac ? undefined : deps.interactive ? 'sudo' : 'prompt'
  if (!json) {
    const asks = mac ? 'macOS asks for an administrator password once.'
      : via === 'sudo' ? 'sudo asks for your password here.' : 'Your system asks for your password once.'
    deps.out(repair
      ? `Harness will repair the Harness Team account on ${here.where}. ${asks}`
      : `Harness will set up a separate account for Swarm work on ${here.where}. ${asks}`)
    for (const line of madeLines(here, owner, ownerHome)) deps.out(line)
  }
  const startedAt = deps.now()
  const asked = prompts(here.where)
  const result = await deps.admin((stageDir) => ({
    script: scripts.setup({
      user: TEAM_USER, realName: TEAM_REAL_NAME, home: layout.home, owner, ownerHome, stageDir,
      nodeRuntimeDir: installed.nodeRuntimeDir!, tmuxRuntimeDir: installed.tmuxRuntimeDir, cliDir: installed.cliDir,
      ownerNode: installed.node, ownerCli: installed.cliJs, mintEnv, signIn: signInAgain ? 'always' : 'missing',
    }),
    files: { 'team.json': teamConfigJson(config), [scripts.serviceFile]: service },
  }), repair ? asked.repair : asked.setup, ...via ? [via] : [])
  if (!result.ok) {
    if (result.code === 'CANCELLED') return fail(deps, json, 'CANCELLED', 'Nothing was changed: the administrator prompt was cancelled.')
    if (result.code === 'NO_PROMPT') return fail(deps, json, 'NO_PROMPT', result.message)
    const refusal = result.status === 3 ? LINUX_REFUSALS.get(result.message) : undefined
    if (refusal) return fail(deps, json, refusal, `The Harness Team account was not set up: ${sentence(result.message)} Nothing was changed.`)
    return fail(deps, json, 'SETUP_FAILED', `The Harness Team account was not finished: ${sentence(result.message)} Run \`harness team setup\` again; it repairs what is there.`)
  }
  try { deps.setupDecision?.clear() } catch { /* only Desktop's offer reads it */ }
  const handedOver = /handed a sign-in to the team account/.test(result.stdout)
  if (!json) deps.out(handedOver ? 'Waiting for the team daemon to sign in and check its privacy…' : 'Waiting for the team daemon to check its privacy…')
  // The daemon reports through its status file (./privacy.ts): the sign-in when it redeemed one, the check every start.
  let report: TeamStatus | null = null
  // From now, not from before the prompt: a person may take longer than this to answer it.
  const deadline = deps.now() + SETUP_REPORT_WAIT_MS
  for (;;) {
    report = deps.readStatus(layout.statusFile)
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
    deps.out(JSON.stringify({ ok, user: TEAM_USER, home: layout.home, label: layout.service.label, plist: layout.service.file, privacy, signIn,
      engines: engines ?? null }))
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
  const here = teamHere(deps.platform)
  const config = here ? deps.readConfig() : null
  const exists = here ? await deps.accountExists(config?.user ?? TEAM_USER) : false
  if (!here || (!config && !exists)) {
    if (json) deps.out(JSON.stringify({ account: false, dedicated }))
    else if (dedicated) deps.out('This computer runs team work only (harness team on): Swarm agents run here, and it reaches none of your other computers.\n  undo: harness team off')
    else deps.out(`No Harness Team account on this computer.${here ? ' harness team setup makes one.' : ' On a computer used only for agents: harness team on.'}`)
    return 0
  }
  const { layout } = here
  const user = config?.user ?? TEAM_USER
  const home = config?.home ?? layout.home
  const owner = config?.owner ?? deps.user()
  const ownerHome = config?.ownerHome ?? deps.home()
  const label = config?.label ?? layout.service.label
  const serviceFile = config?.plist ?? layout.service.file
  const job = await deps.jobState(label)
  const report = deps.readStatus(config?.statusFile ?? layout.statusFile)
  const homeMode = deps.mode(ownerHome)
  const plistPresent = deps.exists(serviceFile)
  if (json) {
    deps.out(JSON.stringify({
      account: exists, user, realName: config?.realName ?? TEAM_REAL_NAME, home, homePresent: deps.exists(home),
      label, plist: serviceFile, plistPresent, job, port: config?.port ?? TEAM_PORT,
      config: config ? layout.configFile : null, ownerHomeMode: homeMode === null ? null : homeMode.toString(8),
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
  for (const line of madeLines(here, owner, ownerHome)) deps.out(`  ${line}`)
  deps.out('')
  deps.out('  undo: harness team remove')
  for (const line of byHandLines(here, owner, ownerHome)) deps.out(line)
  return 0
}

/** A terminal app's bundle id as macOS gives it to what the app starts, for the one command that asks again. */
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/

/** What to do when macOS keeps the account ([REMOVE_REFUSED]): nothing was removed, and the account runs as before. */
function refusedLines(deps: TeamCommandDeps, inTerminal: boolean): string[] {
  const usersAndGroups = `delete "${TEAM_REAL_NAME}" in System Settings > Users & Groups (ⓘ, Delete User…, Delete the home folder), then run harness team remove again for the rest`
  if (!inTerminal) {
    return [
      '  macOS 26 deletes an account only for an app you allow to administer this Mac, and it cannot ask that for this prompt. Either:',
      '    · run harness team remove in Terminal: it asks for your password there, then macOS asks to let Terminal',
      '      administer your computer. Choose Allow.',
      `    · or ${usersAndGroups}.`,
    ]
  }
  const app = deps.env.__CFBundleIdentifier?.trim()
  const reset = `tccutil reset SystemPolicySysAdminFiles${app && BUNDLE_ID.test(app) ? ` ${app}` : ''}`
  return [
    '  macOS deletes an account only for an app you allow to administer this Mac. If you chose Don\'t Allow when it asked,',
    `  it asks again after: ${reset}`,
    `  Or ${usersAndGroups}.`,
  ]
}

interface MachineRow { machineId: string; computerId?: string | null; sessionKind?: string | null }

/** A computer id as the backend keeps it (backend lib/deviceAuth.ts `normalizeComputerId`): lower case, no dashes. */
const computerKey = (id: string | null | undefined): string => (id ?? '').trim().toLowerCase().replace(/-/g, '')

/**
 * The team account's computer, off the owner's Harness account: the backend ends the team sign-in bound to it with it.
 * Only after the account is gone: a removal macOS refuses must leave the account signed in and running. Only a team
 * machine with that computer id, never this computer's own.
 */
async function forgetTeamComputer(deps: TeamCommandDeps, computerId: string): Promise<{ removed: number } | { error: string }> {
  if (!deps.session()) return { error: 'this computer is not signed in to Harness' }
  try {
    const { session, headers } = await deps.auth()
    const { machines = [] } = await deps.get<{ machines?: MachineRow[] }>('/api/machines', headers)
    const key = computerKey(computerId)
    const ours = machines.filter((m) => key !== '' && computerKey(m.computerId) === key && m.sessionKind === 'team' && m.machineId !== session.machineId)
    for (const machine of ours) await deps.delete(`/api/machines/${encodeURIComponent(machine.machineId)}`, headers)
    return { removed: ours.length }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

async function remove(deps: TeamCommandDeps, json: boolean): Promise<number> {
  const here = teamHere(deps.platform)
  if (!here) return fail(deps, json, 'UNSUPPORTED', 'The Harness Team account is made on a Mac or a Linux computer; this computer has none. To stop team work here: harness team off.')
  const { layout, scripts, mac } = here
  if (deps.uid() === 0) return fail(deps, json, 'RUN_AS_YOURSELF', 'Run this as yourself, not with sudo: Harness asks for an administrator password itself.')
  const config = deps.readConfig()
  const ownerHome = checkPath(config?.ownerHome ?? deps.home(), 'home folder')
  if (!config && !await deps.accountExists(TEAM_USER) && !deps.exists(layout.service.file) && !deps.exists(layout.home)) {
    if (json) deps.out(JSON.stringify({ ok: true, removed: false }))
    else deps.out(`No Harness Team account on ${here.where}; nothing to remove.`)
    return 0
  }
  // In a terminal, with sudo there: macOS then asks to let the terminal app administer the Mac, which deleting an account
  // needs (./admin.ts). Elsewhere (Desktop, a script), the administrator prompt, which macOS 26 refuses it.
  const inTerminal = deps.interactive
  if (inTerminal && !json) {
    deps.out(mac ? 'Harness will remove the Harness Team account. sudo asks for your password here; macOS may then ask to let this terminal administer your computer.'
      : 'Harness will remove the Harness Team account. sudo asks for your password here.')
  }
  const result = await deps.admin(() => ({
    script: scripts.remove({ user: config?.user ?? TEAM_USER, home: config?.home ?? layout.home, ownerHome,
      owner: checkUser(config?.owner ?? deps.user(), 'owner account') }),
  }), prompts(here.where).remove, inTerminal ? 'sudo' : 'prompt')
  if (!result.ok) {
    if (result.code === 'CANCELLED') {
      return fail(deps, json, 'CANCELLED', `Nothing was removed: ${inTerminal ? 'sudo did not get an administrator password' : 'the administrator prompt was cancelled'}.`)
    }
    if (result.code === 'NO_PROMPT') return fail(deps, json, 'NO_PROMPT', 'No administrator prompt here: run harness team remove in a terminal.')
    if (result.status === REMOVE_REFUSED) {
      // Linux: userdel keeps a user something still runs as, which the removal stopped first; a restart ends it for certain.
      const next = mac ? refusedLines(deps, inTerminal) : ['  Something on this computer still runs as the account. Restart it, then run harness team remove again.']
      if (json) return fail(deps, json, 'DELETE_REFUSED', sentence(result.message), { next: next.map((line) => line.trim()) })
      fail(deps, json, 'DELETE_REFUSED', `${mac ? 'macOS' : 'Linux'} kept the Harness Team account: ${sentence(result.message)}`)
      for (const line of next) deps.err(line)
      return 1
    }
    return fail(deps, json, 'REMOVE_FAILED', `The Harness Team account was not fully removed: ${sentence(result.message)} Run \`harness team remove\` again.`)
  }
  try { deps.setupDecision?.decline() } catch { /* only Desktop's offer reads it */ }
  const computerId = TEAM_COMPUTER_LINE.exec(result.stdout)?.[1] ?? null
  const forgotten = computerId ? await forgetTeamComputer(deps, computerId) : null
  if (json) {
    deps.out(JSON.stringify({ ok: true, removed: true, computer: forgotten }))
    return 0
  }
  deps.out(`✓ Removed the Harness Team account (${TEAM_USER}), ${layout.home} and the daemon ${layout.service.label}.`)
  const teamMachine = `"${deps.hostname().slice(0, 60)} · Team"`
  if (forgotten && 'removed' in forgotten && forgotten.removed > 0) deps.out('✓ Took its computer off your Harness account, which signs it out.')
  else if (forgotten && 'error' in forgotten) deps.out(`! Its computer is still on your Harness account (${forgotten.error}). Remove ${teamMachine}: harness machines`)
  else if (!computerId) deps.out(`  If its computer, ${teamMachine}, is still on your Harness account, remove it there: harness machines`)
  deps.out('  Your home folder stays private (mode 700).')
  deps.out('  Harness will not make it again on its own when you join a Swarm; harness team setup makes it again.')
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
  const here = teamHere(deps.platform)
  if (here && deps.readConfig()) {
    return fail(deps, json, 'TEAM_ACCOUNT', `This ${here.mac ? 'Mac' : 'computer'} has a Harness Team account, which runs its team work. \`harness team on\` is for a computer used only for agents.`)
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
    ? new TeamSignInError(`${error.message}${/[.!?]$/.test(error.message) ? '' : '.'} Nothing was changed on this computer.`, error.code) : error
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

async function teamOff(deps: TeamCommandDeps, json: boolean, flags: readonly string[]): Promise<number> {
  const session = deps.session()
  if (session?.kind !== 'team') {
    if (json) deps.out(JSON.stringify({ ok: true, changed: false }))
    else deps.out('This computer does not run team work only; nothing to change.')
    return 0
  }
  // Before anything stops or is revoked. 10-27: a `harness logout` nobody asked for signed a whole Mac out.
  const asked = deps.signOutAsked(flags)
  if (!asked) {
    return fail(deps, json, 'NOT_A_PERSON', '`harness team off` signs this computer out, and nothing says a person '
      + `asked: it has no terminal, and no ${SIGN_OUT_BUTTON_FLAG}. Run it in a terminal.`)
  }
  const wasRunning = await deps.stopDaemon()
  await revokeHarnessRefresh(deps.post, session.refreshToken)
  deps.removeSignIn(asked)
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
 * The team account's machine id, in its session file, before its daemon starts. `harness start` resolves a session's machine
 * (cli.ts `resolveMachineIfUnknown`), but launchd runs this account's master directly, so without this its daemon ran as its
 * computer id: its gateway counted it signed out and never put its key on the device key log, so its Mac's daemon could not
 * reach it to add it to a Swarm, and its Swarm host polled under an id that is not its machine (third VM run,
 * docs/plans/2026-10-24-swarm-team-account.md). The first resolve creates its machine, named "<this Mac> · Team".
 * Never fails the start: the next start tries again.
 */
async function recordTeamMachine(deps: TeamCommandDeps, label: string, log: (line: string) => void): Promise<void> {
  const session = deps.session()
  if (session?.kind !== 'team' || session.machineId) return
  try {
    const { headers } = await deps.auth()
    const answer = await deps.post<{ machine?: { machineId?: unknown } }>('/api/machines/resolve-computer',
      { computerId: session.computerId, label }, headers)
    const machineId = answer?.machine?.machineId
    if (typeof machineId !== 'string' || !machineId) throw new Error('Harness answered without a machine id')
    // A refresh may have rewritten the session meanwhile: the machine id goes into the newest one.
    const kept = await deps.updateSession((latest) => latest.kind !== 'team' || latest.computerId !== session.computerId
      || latest.machineId === machineId ? null : { ...latest, machineId, updatedAt: deps.now() })
    if (kept?.kind !== 'team' || kept.computerId !== session.computerId) return
    log(`runs as machine ${machineId}`)
  } catch (error) {
    log(`could not look up this account's machine yet (${(error as Error).message}); the next start tries again`)
  }
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
  const label = `${deps.hostname().slice(0, 60)} · Team`
  if (file) {
    let code: string | null = null
    try {
      code = deps.takeHandoff(checkPath(file, 'sign-in file'))
    } catch (error) {
      log((error as Error).message)
      report({ signIn: { state: 'failed', at: deps.now(), detail: (error as Error).message } })
    }
    // Setup hands a code over only when this account has no sign-in, or when its owner asked for a new one
    // (`--sign-in-again`): a sign-in already here is replaced, and kept when the new one cannot be had.
    if (code) {
      const previous = deps.session()
      try {
        const computerId = deps.computerId()
        const tokens = await redeemTeamHandoff(code, label, computerId, { post: deps.post, sleep: deps.sleep, now: deps.now })
        deps.writeSession(teamSession(tokens, computerId, deps.autonomousEnv, deps.now()))
        if (previous) await revokeHarnessRefresh(deps.post, previous.refreshToken)
        log(previous ? 'signed in for team work again; the previous sign-in was ended' : 'signed in for team work')
        report({ signIn: { state: 'signed-in', at: deps.now() } })
      } catch (error) {
        log(`sign-in failed: ${(error as Error).message}${previous ? '; the previous sign-in is kept' : ''}`)
        report({ signIn: { state: 'failed', at: deps.now(), detail: (error as Error).message } })
      }
    }
  }
  await recordTeamMachine(deps, label, log)
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
