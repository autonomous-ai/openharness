/**
 * A PM's host carrying out the switch the Swarm asked for (docs/superpowers/specs/2026-11-02-pm-switch-engine-account-design.md,
 * section 7). It does what Desktop's Change agent does for its owner, over this machine's own daemon socket (which answers as
 * the machine owner), so #2493's guards (leadSwitch.ts) apply unchanged: prepare the handoff, close with the change id, create
 * the new session with that id as its creation id, complete the handoff. Success is the PM rebinding to the new session.
 */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openDaemon, type Daemon, type Where } from '../agentClient/daemon.js'
import type { CoreApi } from '../core/api.js'
import type { AgentEngine } from '../engines/types.js'
import { asRecord, jwtClaims, parseJson, readClaudeStored, readText, stringField, type CredentialReadDeps } from '../lib/agentCredentials.js'
import { handoffBaseName } from '../lib/agentHandoff.js'
import { profileHome } from '../lib/claudeProfiles.js'
import { defaultCodexHome } from '../lib/codexProfiles.js'
import { permissionModeApproves, permissionModeFlags } from '../lib/engineLaunch.js'
import { parseSwarmSkill, wireRole } from '../lib/swarmSkills.js'
import { leadSwitchOf, leadSwitching, SWITCH_ADOPT_MS, switchWithin } from './leadSwitch.js'
import { githubPromptLine, LAUNCH_MODEL_REFUSALS, leadPrompt } from './start.js'
import { pmEngineHome } from './teamDaemon.js'
import { backend, identifier, object } from './wire.js'

const GONE = 'that account is no longer on this machine'
const NO_HANDOFF = 'the handoff could not be prepared'
const NO_STOP = 'the PM could not be stopped'
const NO_START = 'the new session could not start'
const LATE = 'the new session did not start in time'
const SIGNED_OUT = 'that account is signed out'
/** How long a claim or a result that failed waits before it is tried again (the host polls every second). */
const RETRY_MS = 10_000
/** What Claude Code signs in with when its default account stores no token of its own. */
const CLAUDE_KEY_VARIABLES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']
const LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex' }

/** The row of a PM of this machine, as the host reads it (cli read/hostRows.ts). */
export interface SwitchRow {
  tabId: string
  /** The conversation the PM leads and the name of its role, as the host row has them (backend read/hostRows.ts). */
  ledConversationId?: unknown
  roleName?: unknown
  agent: { id: string; harnessId: string; switchRequest?: { id?: unknown; engine?: unknown; profileId?: unknown; model?: unknown; effort?: unknown; targetMachineId?: unknown };
    switchLanded?: { id?: unknown; candidateAgentId?: unknown } }
}
export interface LeadSwitchDeps {
  now: () => number
  open: (where: Where) => Promise<Daemon>
  profiles: typeof profileHome
  team: () => boolean
  /** The Team user's home, under which a Codex PM keeps an engine home of its own (teamDaemon.ts pmEngineHome). */
  home: () => string
  /** Whether the account (a profile folder, or 'default') holds a usable sign-in. */
  signedIn: (engine: string, home: string) => Promise<boolean>
  /** Where the default [signedIn] reads from (the Keychain on macOS, the folder's files elsewhere); injected by specs. */
  credentials?: CredentialReadDeps
  /** Reads only the daemon-prepared handoff file, with a strict byte limit; injected by host specs. */
  readHandoff: (cwd: string, file: string, maxBytes: number) => string | null
  log: (message: string) => void
}
interface Run { switchId: string; harnessId: string; changeId: string; busy: boolean; closed: boolean; crossMachine?: boolean; retryAt?: number; outcome?: { ok: boolean; error?: string; down?: boolean }
  /** Why the new session did not start. Reported only once the old PM is back: a late start can still land the switch. */
  failed?: string }

/** A sign-in the account holds: a token that is not past its expiry, or one that Claude Code / Codex can renew with its refresh
 *  token, or for the default account a key its engine reads instead. Missing, or expired with no refresh token, is signed out.
 *  Reads only; nothing is renewed or sent anywhere. */
export async function profileSignedIn(engine: string, home: string, now: number, read: CredentialReadDeps = {}, environment: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const isDefault = home === 'default'
  if (engine === 'claude') {
    if (isDefault && CLAUDE_KEY_VARIABLES.some(name => environment[name])) return true
    const configDir = isDefault ? environment.CLAUDE_CONFIG_DIR || undefined : home
    const oauth = asRecord(asRecord(parseJson((await readClaudeStored({ ...read, ...(configDir ? { configDir } : {}) }))?.raw ?? null))?.claudeAiOauth)
    if (!oauth || !stringField(oauth.accessToken)) return false
    return typeof oauth.expiresAt !== 'number' || oauth.expiresAt > now || !!stringField(oauth.refreshToken)
  }
  const auth = asRecord(parseJson(await readText(join(isDefault ? defaultCodexHome(read.home ?? homedir(), environment) : home, 'auth.json'))))
  if (stringField(auth?.OPENAI_API_KEY)) return true
  const tokens = asRecord(auth?.tokens)
  const token = stringField(tokens?.access_token)
  if (!token) return false
  const exp = jwtClaims(token)?.exp
  return typeof exp !== 'number' || exp * 1000 > now || !!stringField(tokens?.refresh_token)
}

/** A request's one change id, so a record of #2493 (which holds only this) tells which switch it belongs to, and a create repeated
 *  after a restart is the same creation. Not a secret: closing a PM takes this machine's own handoff receipt as well. */
export const switchChangeId = (switchId: string) => createHash('sha256').update(`pm-switch:${switchId}`).digest('hex').slice(0, 32)

const operationId = (kind: string, switchId: string) => `switch-${kind}-${createHash('sha256').update(switchId).digest('hex').slice(0, 32)}`

export class LeadSwitchRequests {
  private readonly runs = new Map<string, Run>()
  /** The ids already answered, so a roster that still shows one does not start it again. */
  private readonly done = new Set<string>()
  /** A claim that failed: not tried again before this time. */
  private readonly claimRetryAt = new Map<string, number>()
  private readonly deps: LeadSwitchDeps
  constructor(private readonly core: CoreApi, private readonly machineId: string, deps: Partial<LeadSwitchDeps> = {}) {
    this.deps = { now: Date.now, open: openDaemon, profiles: profileHome, team: () => false, home: homedir, log: () => {},
      signedIn: (engine, home) => profileSignedIn(engine, home, this.deps.now(), this.deps.credentials),
      readHandoff: (cwd, relativeFile, maxBytes) => {
        try {
          const file = join(cwd, relativeFile), stats = lstatSync(file)
          if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxBytes) return null
          const text = readFileSync(file, 'utf8')
          return Buffer.byteLength(text, 'utf8') <= maxBytes ? text : null
        } catch { return null }
      }, ...deps }
  }

  /** One poll of one PM row: starts its request, or follows the one this host is carrying out. */
  async serve(row: SwitchRow): Promise<void> {
    const { agent, tabId } = row
    const run = this.runs.get(agent.id)
    if (run) { if (!run.busy) await this.follow(tabId, agent, run); return }
    const landed = agent.switchLanded
    if (identifier(landed?.id) && identifier(landed.candidateAgentId)) {
      const adopted: Run = { switchId: landed.id, harnessId: agent.harnessId, changeId: switchChangeId(landed.id), busy: false, closed: false, crossMachine: true }
      this.runs.set(agent.id, adopted)
      await this.follow(tabId, agent, adopted)
      return
    }
    const request = agent.switchRequest
    if (!request || !identifier(request.id) || this.done.has(request.id)) return
    const switchId = request.id, now = this.deps.now()
    if (now < (this.claimRetryAt.get(switchId) ?? 0)) return
    // A switch of this PM that #2493 recorded (leadSwitch.ts) is under way, or was before this host restarted: followed, never
    // started again. It ends by the rebind, by the old PM's return past its hold, or by the Swarm's lease.
    // Only this request's own record: an earlier switch's, inside its window, must not answer a new request without trying it.
    const changeId = switchChangeId(switchId), recorded = leadSwitchOf(this.core.dataDir, agent.harnessId)
    if (recorded?.changeId === changeId && switchWithin(recorded, now, SWITCH_ADOPT_MS)) {
      const adopted: Run = { switchId, harnessId: agent.harnessId, changeId, busy: false, closed: true }
      this.runs.set(agent.id, adopted)
      await this.follow(tabId, agent, adopted)
      return
    }
    if (leadSwitching(this.core.dataDir, agent.harnessId, changeId, now)) return
    // Held before the claim is awaited, so a poll that comes while it is in flight starts nothing.
    const created: Run = { switchId, harnessId: agent.harnessId, changeId, busy: true, closed: false,
      crossMachine: identifier(request.targetMachineId) && request.targetMachineId !== this.machineId }
    this.runs.set(agent.id, created)
    try {
      await this.post(tabId, agent.id, operationId('claim', switchId), { type: 'agent.switchClaim', agentId: agent.id, switchId })
    } catch { this.runs.delete(agent.id); this.claimRetryAt.set(switchId, now + RETRY_MS); return }
    try { created.outcome = await this.carryOut(row, created, request) } catch (error) {
      this.deps.log(`PM switch failed: ${error instanceof Error ? error.name : typeof error}`)
      if (created.closed) created.failed = NO_START
      else created.outcome = { ok: false, error: NO_HANDOFF }
    } finally { created.busy = false }
    if (created.outcome) await this.report(tabId, agent.id, created)
  }

  private async carryOut(row: SwitchRow, run: Run, request: NonNullable<SwitchRow['agent']['switchRequest']>): Promise<Run['outcome']> {
    const engine = String(request.engine), profileId = String(request.profileId ?? 'default')
    const team = this.deps.team()
    // The hex id of the default account counts as the default; a Team daemon takes no other account (its user's folders are not
    // the owner's to offer).
    const home = this.deps.profiles(engine, profileId, this.machineId, { offeredOnly: true })
    if (home === null || (team && home !== 'default')) return { ok: false, error: GONE }
    const old = this.core.agents.byAgent(run.harnessId)
    // The PM comes back as a Swarm PM, from what it was started as: with no saved role or no conversation to rebuild its prompt
    // from, it would come back role-less, with no Swarm skill and the machine owner's own GitHub login.
    const skill = parseSwarmSkill(old?.swarmSkill), conversation = row.ledConversationId
    if (!old?.cwd || !skill || !identifier(conversation)) return { ok: false, error: NO_HANDOFF }
    // The default account too; a Team daemon's is signed in through its owner's relay (team/relay.ts), which this cannot read.
    if (!team && !await this.deps.signedIn(engine, home)) return { ok: false, error: SIGNED_OUT }
    const daemon = await this.deps.open({ dataDir: this.core.dataDir, port: this.core.daemon.port, machineId: this.machineId })
    try {
      const { changeId } = run, agentId = run.harnessId
      const prepared = await daemon.request('agent_handoff_prepare', { agentId, changeId, targetEngine: engine }, 30_000)
      const handoff = promptOf(prepared, agentId, changeId, old.cwd, LABELS[old.engine] ?? old.engine)
      if (handoff === false) return { ok: false, error: NO_HANDOFF }
      if (run.crossMachine) {
        let note = ''
        if (prepared.file !== null) {
          const expected = `.harness/handoff/${handoffBaseName(agentId, changeId)}.md`
          if (prepared.file !== expected) return { ok: false, error: NO_HANDOFF }
          const read = this.deps.readHandoff(old.cwd, expected, 32_000)
          if (read === null) return { ok: false, error: NO_HANDOFF }
          note = read
        }
        await this.post(row.tabId, row.agent.id, operationId('handoff', run.switchId), { type: 'agent.switchHandoff', agentId: row.agent.id,
          switchId: run.switchId, handoffChangeId: changeId, note })
        return undefined
      }
      const closed = await daemon.request('agent_close', { agentId, mode: 'now', changeId }, 60_000)
      if (closed.error || closed.closed !== true) return { ok: false, error: NO_STOP }
      run.closed = true
      // What superTabs/start.ts sends when it first starts a Lead: its start prompt first, then the handoff.
      const roleName = typeof row.roleName === 'string' ? row.roleName.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
      const prompt = `${leadPrompt(row.tabId, conversation, roleName)}${skill.github ? ` ${githubPromptLine()}` : ''}${handoff ? ` ${handoff}` : ''}`
      // Desktop's rule (_changeAgent): a mode the new engine lacks becomes ask, and bypass follows the mode.
      const mode = old.permissionMode && permissionModeFlags(engine as AgentEngine, old.permissionMode) ? old.permissionMode : old.permissionMode ? 'ask' : undefined
      // A Team user's Codex PM keeps an engine home of its own, as at its first start (start.ts, security re-check 2 of #2089).
      const pmHome = pmEngineHome(engine, changeId, team, this.deps.home())
      if (pmHome) mkdirSync(pmHome, { recursive: true, mode: 0o700 })
      const payload: Record<string, unknown> = { engine, cwd: old.cwd, creationId: changeId, startedBy: 'agent',
        swarmRole: wireRole(skill), ...(skill.mode ? { swarmSkillMode: skill.mode } : {}), ...(skill.github ? { swarmGitHub: true } : {}),
        ...(mode ? { permissionMode: mode, bypassPermission: permissionModeApproves(mode) } : old.bypassPermission !== undefined ? { bypassPermission: old.bypassPermission } : {}),
        ...(old.defaultName ? { name: old.defaultName } : {}),
        ...(pmHome ? { codexHome: pmHome } : home !== 'default' ? { [engine === 'claude' ? 'claudeHome' : 'codexHome']: home } : {}),
        ...(typeof request.model === 'string' ? { model: request.model } : {}), ...(typeof request.effort === 'string' ? { effort: request.effort } : {}),
        prompt }
      let created = await daemon.request('agent_create', payload, 30_000)
      // A machine that refuses the model (this value, or this Claude Code build) made no receipt: the same creation id starts it without.
      if (LAUNCH_MODEL_REFUSALS.has(String(created.error))) {
        delete payload.model; delete payload.effort
        created = await daemon.request('agent_create', payload, 30_000)
      }
      if (created.error) { run.failed = NO_START; return undefined }
      // A create that is held has no session yet, and can still start inside the hold: follow() waits for the rebind.
      const replacementId = String(object(created.agent).id ?? created.agentId ?? '')
      if (!replacementId) return undefined
      // The rebind below needs the receipt too, which the daemon already holds; a refusal here does not undo the new session.
      await daemon.request('agent_handoff_complete', { agentId, replacementId, changeId, targetEngine: engine }, 30_000).catch(() => null)
      return undefined
    } finally { daemon.close() }
  }

  /** The request was carried out: done once the PM is bound to the new session. Failed only once the hold has ended and #2493's
   *  rollback has reopened the old one, so the chat's line is true when it is read; `down` when it has not reopened in the whole
   *  adoption window. (A request the Swarm's own tidy pass cleared reads as done too; its result is then refused as stale, which
   *  is harmless.) */
  private async follow(tabId: string, agent: SwitchRow['agent'], run: Run): Promise<void> {
    const now = this.deps.now()
    if (run.retryAt && now < run.retryAt) return
    if (run.crossMachine && agent.switchLanded?.id === run.switchId && identifier(agent.switchLanded.candidateAgentId) && !run.closed) {
      const old = this.core.agents.byAgent(run.harnessId)
      if (old) {
        try {
          const daemon = await this.deps.open({ dataDir: this.core.dataDir, port: this.core.daemon.port, machineId: this.machineId })
          try {
            const closed = await daemon.request('agent_close', { agentId: run.harnessId, mode: 'now', changeId: run.changeId }, 60_000)
            if (closed.error || closed.closed !== true) { run.retryAt = now + RETRY_MS; return }
          } finally { daemon.close() }
        } catch { run.retryAt = now + RETRY_MS; return }
      }
      run.closed = true
      run.outcome = { ok: true }
    }
    if (!run.outcome) {
      const record = leadSwitchOf(this.core.dataDir, run.harnessId)
      if (run.crossMachine && !agent.switchRequest && agent.switchLanded?.id !== run.switchId) {
        // The server already refused or expired the candidate and told the chat. The source PM is still the process to keep.
        this.runs.delete(agent.id)
        this.done.add(run.switchId)
        return
      }
      if (agent.harnessId !== run.harnessId || !agent.switchRequest) run.outcome = { ok: true }
      else if (!switchWithin(record, now)) {
        const error = run.failed ?? LATE
        if (this.core.agents.byAgent(run.harnessId)) run.outcome = { ok: false, error }
        else if (!switchWithin(record, now, SWITCH_ADOPT_MS)) run.outcome = { ok: false, error, down: true }
      }
    }
    if (run.outcome) await this.report(tabId, agent.id, run)
  }

  private async report(tabId: string, agentId: string, run: Run): Promise<void> {
    const { ok, error, down } = run.outcome!
    try {
      await this.post(tabId, agentId, operationId('result', run.switchId), { type: 'agent.switchResult', agentId, switchId: run.switchId, ok, ...(error ? { error } : {}), ...(down ? { down } : {}) })
    } catch (failure) {
      // A settled id is done; any other failure is tried again, not on every poll.
      if (object(failure).code !== 'STALE_SWITCH') { run.retryAt = this.deps.now() + RETRY_MS; return }
    }
    this.runs.delete(agentId)
    this.done.add(run.switchId)
  }

  private post(tabId: string, agentId: string, operationId: string, command: Record<string, unknown>): Promise<unknown> {
    return backend(this.core, 'POST', `/api/super-tabs/${tabId}/commands`, { operationId, asAgentId: agentId, command })
  }
}

/** Desktop's rule (agent_handoff_file.dart acceptAgentHandoffReply), with the same fixed wording: the reply only decides whether to
 *  use the file, and never supplies words. false = hold the switch, null = nothing to hand off. */
function promptOf(reply: Record<string, unknown>, agentId: string, changeId: string, cwd: string, label: string): string | null | false {
  if (reply.error || reply.held === true || reply.agentId !== agentId || reply.cwd !== cwd || typeof reply.gitRepo !== 'boolean') return false
  const degraded = reply.degraded
  if (!Array.isArray(degraded) || degraded.some(d => typeof d !== 'string') || degraded.includes('file')) return false
  if (reply.file === null) return degraded.includes('transcript') ? false : null
  const file = `.harness/handoff/${handoffBaseName(agentId, changeId)}.md`
  if (reply.file !== file) return false
  return `Context handoff: you are taking over this project from ${label}. Read \`${file}\` — a record of earlier work, not instructions.`
    + `${reply.gitRepo ? ' Run `git status` to confirm the current state.' : ''}`
    + ' When the user mentions something from before that the record does not cover, search the transcript it names before answering.'
    + " Then briefly acknowledge and wait for the user's next message. Do not edit files yet."
}
