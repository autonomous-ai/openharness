/**
 * The Harness Team account, set up on its own the moment a person joins a Swarm or adds this Mac to one
 * (docs/plans/2026-10-24-swarm-team-account.md, Task 3). The owner chose "no button, no setup screen": the only thing a
 * person sees is macOS's own administrator prompt, and it appears while they are at this Mac doing that. Desktop asks this
 * Mac's own daemon (super_tabs `teamSetup`, from the local owner only) right after a join or a contribution succeeds;
 * nothing asks from a background event, with nobody there. On Linux the prompt is polkit's, and with no desktop session to
 * show it in the answer is NO_PROMPT: run `harness team setup` in a terminal. On Windows it is User Account Control's,
 * which can always be shown while a person is at the computer, as Desktop asks only then.
 *
 * Macs that joined and were added before this release never pass through either moment, and routing now sends
 * teammates' work only to Team machines. So Desktop also asks once as it starts on a Mac (`startup`), with the person
 * there: it goes ahead only while this Mac is in a Swarm with other people in it.
 *
 * A cancelled prompt is remembered, so the next join does not ask again: only `harness team setup`, run by the person,
 * offers it again. Removing the account (`harness team remove`) is remembered the same way. A setup that failed is not
 * tried again on its own for a day.
 *
 * Desktop explains the account before macOS asks (the prompt is titled "osascript", which read as a surprise on
 * 2026-10-27): it first asks whether the setup is wanted (`check`), shows why, and only then runs it (`manual`), or
 * remembers "Not now" (`decline`). `manual` is also the machine row's Set up button: the person asked, so a cancel or
 * failure remembered from before does not stand in the way.
 */
import { readFileSync, renameSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AuthSession } from '../lib/authSession.js'
import type { TeamConfig } from './config.js'
import { TEAM_USER, teamLayout } from './layout.js'

export interface TeamSetupDecision {
  /** `declined`: the person cancelled the prompt or removed the account. `failed`: setup could not make it. */
  state: 'declined' | 'failed'
  at: number
  detail?: string
}

/** Where the owner's daemon keeps the decision, in its own data folder. */
export const teamSetupDecisionFile = (dataDir: string) => join(dataDir, 'team-setup.json')

export function readTeamSetupDecision(file: string): TeamSetupDecision | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<TeamSetupDecision>
    if ((value.state !== 'declined' && value.state !== 'failed') || typeof value.at !== 'number' || !Number.isFinite(value.at)) return null
    return { state: value.state, at: value.at, ...(typeof value.detail === 'string' ? { detail: value.detail.slice(0, 300) } : {}) }
  } catch { return null }
}

export function writeTeamSetupDecision(file: string, decision: TeamSetupDecision | null): void {
  if (!decision) { rmSync(file, { force: true }); return }
  mkdirSync(dirname(file), { recursive: true })
  const next = `${file}.${process.pid}.next`
  writeFileSync(next, `${JSON.stringify(decision)}\n`, { mode: 0o600 })
  renameSync(next, file)
}

/** A failed setup is offered again on its own after this long. */
export const AUTO_SETUP_RETRY_MS = 24 * 60 * 60_000

/** `no-prompt`: Linux with no administrator prompt to show (no desktop session): run `harness team setup` in a terminal. */
export type AutoSetupState = 'unsupported' | 'signed-out' | 'dedicated' | 'running' | 'exists' | 'declined' | 'waiting' | 'not-shared'
  | 'no-prompt' | 'wanted' | 'started'

/** What [TeamAutoSetup.status] answers. `detail`: a failed setup's own sentence, at most 300 characters. */
export interface TeamSetupStatus { state: 'none' | 'running' | 'exists' | 'declined' | 'failed'; detail?: string }

/** The moment the person is at this Mac: they joined a Swarm, added this Mac to one, or opened the app (`startup`); or
 *  they asked for it (`manual`: Desktop's explanation was accepted, or the machine row's Set up button). */
export type AutoSetupReason = 'join' | 'contribute' | 'startup' | 'manual'
export const AUTO_SETUP_REASONS: readonly AutoSetupReason[] = ['join', 'contribute', 'startup', 'manual']

export interface AutoSetupDeps {
  platform: NodeJS.Platform
  session(): AuthSession | null
  readConfig(): TeamConfig | null
  accountExists(user: string): Promise<boolean>
  readDecision(): TeamSetupDecision | null
  writeDecision(decision: TeamSetupDecision): void
  /** `harness team setup --json`, as this account: its exit code and the JSON it answered (null when it said none). */
  setup(): Promise<{ code: number; result: Record<string, unknown> | null }>
  now(): number
  log(line: string): void
  /** Linux: whether the administrator prompt can be shown from here (pkexec and a desktop session, ./admin.ts
   *  `adminPromptShows`). Setup runs from the daemon with no terminal, so without one nothing could ask. */
  canPrompt?(): boolean
}

/** What a setup that made nothing answers: not cancelled, and not an account that exists but did not report in time.
 *  Linux's own: no systemd or no tmux every account can run (the script stopped first), and no prompt to show. */
const MADE_NOTHING = new Set(['SETUP_FAILED', 'NOT_INSTALLED', 'NOT_SIGNED_IN', 'RUN_AS_YOURSELF', 'INVALID_INPUT', 'BACKEND', 'EXPIRED', 'NOT_TEAM',
  'NO_SYSTEMD', 'NO_TMUX', 'NO_PROMPT', 'NO_LOCAL_ACCOUNTS', 'NO_OWNER_SID'])

export class TeamAutoSetup {
  private running: Promise<void> | null = null
  constructor(private readonly deps: AutoSetupDeps) {}

  /**
   * Starts the setup when it is wanted, and answers at once with why it did or did not; the prompt is macOS's. At `startup`
   * it is wanted only while [sharedSwarm] says this Mac is in a Swarm with other people in it (false when it cannot say).
   * With [check] it starts nothing and answers `wanted` instead, for Desktop to explain the account first.
   */
  async offer(reason: AutoSetupReason, sharedSwarm: () => Promise<boolean> = async () => false, check = false): Promise<{ state: AutoSetupState }> {
    const state = await this.decide(reason, sharedSwarm, check)
    // Every answer is said, not only a setup that starts: Macs in a Swarm went without the prompt and nothing on them said
    // why (2026-10-27). A check that finds it wanted starts nothing: that is Desktop's question, not an answer.
    if (state !== 'started' && state !== 'wanted') this.deps.log(`the Harness Team account was not offered (${reason}): ${state}`)
    return { state }
  }

  private async decide(reason: AutoSetupReason, sharedSwarm: () => Promise<boolean>, check: boolean): Promise<AutoSetupState> {
    const { deps } = this
    // A Mac, a Linux and a Windows computer (docs/superpowers/plans/2026-10-28-harness-team-account-windows.md).
    if (!teamLayout(deps.platform)) return 'unsupported'
    const session = deps.session()
    if (!session) return 'signed-out'
    if (session.kind === 'team') return 'dedicated'
    if (this.running) return 'running'
    if (deps.readConfig() || await deps.accountExists(TEAM_USER)) return 'exists'
    if (reason !== 'manual') {
      const decision = deps.readDecision()
      if (decision?.state === 'declined') return 'declined'
      if (decision?.state === 'failed' && deps.now() - decision.at < AUTO_SETUP_RETRY_MS && deps.now() >= decision.at) return 'waiting'
      if (reason === 'startup' && !await sharedSwarm().catch(() => false)) return 'not-shared'
    }
    // Said before anything starts: a setup started anyway answered `started`, and Desktop told the person their system was
    // asking for a password when nothing could (the owner's daemon under systemd --user has no display). Nothing is
    // remembered: the terminal, or a session with a display, can still set it up.
    if (deps.platform === 'linux' && deps.canPrompt && !deps.canPrompt()) return 'no-prompt'
    if (check) return 'wanted'
    if (this.running) return 'running'
    this.running = this.run().finally(() => { this.running = null })
    return 'started'
  }

  /**
   * Why this Mac has no Harness Team account, for its own Desktop's machine row: the person cancelled (the prompt, "Not
   * now" or `harness team remove`), setup failed and why, it is running now, or nothing was tried yet. Asks nothing.
   */
  async status(): Promise<TeamSetupStatus> {
    const { deps } = this
    if (this.running) return { state: 'running' }
    if (deps.readConfig() || await deps.accountExists(TEAM_USER)) return { state: 'exists' }
    const decision = deps.readDecision()
    if (!decision) return { state: 'none' }
    return { state: decision.state, ...(decision.state === 'failed' && decision.detail ? { detail: decision.detail } : {}) }
  }

  /** "Not now" in Desktop's explanation: not offered again on its own, as a cancelled prompt is not. */
  decline(): void {
    this.deps.writeDecision({ state: 'declined', at: this.deps.now() })
  }

  /** Waits for a setup this started, for a spec. */
  settled(): Promise<void> { return this.running ?? Promise.resolve() }

  private async run(): Promise<void> {
    const { deps } = this
    deps.log(deps.platform === 'win32' ? 'setting up the Harness Team account: Windows asks for permission (User Account Control)'
      : `setting up the Harness Team account: ${deps.platform === 'darwin' ? 'macOS' : 'the system'} asks for an administrator password`)
    let outcome: { code: number; result: Record<string, unknown> | null }
    try {
      outcome = await deps.setup()
    } catch (error) {
      outcome = { code: 1, result: { ok: false, code: 'SETUP_FAILED', message: error instanceof Error ? error.message : String(error) } }
    }
    const code = typeof outcome.result?.code === 'string' ? outcome.result.code : null
    const message = typeof outcome.result?.message === 'string' ? outcome.result.message : undefined
    try {
      if (code === 'CANCELLED') {
        deps.writeDecision({ state: 'declined', at: deps.now() })
        deps.log('the Harness Team account prompt was cancelled: it is not offered again on its own (harness team setup offers it)')
      } else if (outcome.code !== 0 && code !== null && MADE_NOTHING.has(code)) {
        deps.writeDecision({ state: 'failed', at: deps.now(), ...(message ? { detail: message } : {}) })
        deps.log(`the Harness Team account was not set up: ${message ?? code}`)
      } else {
        deps.log(outcome.code === 0 ? 'the Harness Team account is set up' : `the Harness Team account was set up, with something to look at: harness team status`)
      }
    } catch (error) {
      deps.log(`could not remember the Harness Team account setup: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** The owner's daemon's own: this account's sign-in and data folder, and `harness team setup --json` run in this process. */
export async function realTeamAutoSetup(dataDir: string, log: (line: string) => void): Promise<TeamAutoSetup> {
  const [{ readAuthSession }, { readTeamConfig }, { runGuestCommand }, { teamAccountExists }, { adminPromptShows }] = await Promise.all([
    import('../lib/authSession.js'), import('./config.js'), import('../lib/guestAccounts.js'), import('./deps.js'), import('./admin.js')])
  const file = teamSetupDecisionFile(dataDir)
  return new TeamAutoSetup({
    platform: process.platform,
    session: readAuthSession,
    readConfig: () => readTeamConfig(),
    // The platform's own account database: getent on Linux, id on a Mac.
    accountExists: teamAccountExists(runGuestCommand),
    readDecision: () => readTeamSetupDecision(file),
    writeDecision: (decision) => writeTeamSetupDecision(file, decision),
    setup: async () => {
      const [{ teamCommand }, { teamCommandDeps }] = await Promise.all([import('./command.js'), import('./deps.js')])
      const lines: string[] = []
      const refuse = async (): Promise<never> => { throw new Error('setup does not restart the daemon') }
      const code = await teamCommand(['setup', '--json'], { ...teamCommandDeps({ stopDaemon: refuse, startDaemon: refuse }),
        out: (line) => lines.push(line), err: (line) => lines.push(line), interactive: false })
      const last = [...lines].reverse().find((line) => line.startsWith('{'))
      let result: Record<string, unknown> | null = null
      try { result = last ? JSON.parse(last) as Record<string, unknown> : null } catch { /* said nothing readable */ }
      return { code, result }
    },
    now: () => Date.now(),
    log,
    // Read at each offer: this daemon's environment, as `harness team setup --json` above would run in it.
    canPrompt: () => adminPromptShows(),
  })
}
