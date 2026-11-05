/**
 * A Harness Team agent stranded on a relay grant its owner's daemon no longer answers is restarted onto the current one
 * (task #3106).
 *
 * A Team agent spends its owner's subscription through the owner's relay, with the address and token it was launched with
 * in its environment (team/relay.ts). The owner's daemon keeps that address across a restart when it can, and otherwise
 * moves to a new port and a new token (team/relay.ts `openRelay`), or mints a new token when the old one reaches its age.
 * Running agents cannot read the new grant: on daniel-pc, 2026-11-05, the CLI 0.5.43 update restarted the owner's daemon
 * at 11:33, and every Team agent already running there failed each model request until someone restarted it by hand,
 * while those started after 11:33 worked. Each loss cost a task and its restart.
 *
 * So the Team daemon's terminal watch (./terminal.ts), which reads each agent's screen anyway, tells this module what it
 * sees. Once an agent's model has failed for a minute, and the relay answers a model call with the grant published now, the
 * agent is restarted in its pane on the same session. Its relaunch reads the owner's relay again, as every launch does
 * (lib/launchOverrides.ts `ownerRelay`). A short continue is typed once it is back, as limit resume does (./limitResume.ts).
 * A grant that does not answer restarts nothing, since a relaunch would fail the same way. Each agent is restarted at most
 * once per grant, so an agent failing for any other reason is left to its model alert as before.
 *
 * A signed-out screen counts as a failing model too (./terminal.ts `signedOut`: Claude Code's "Not logged in · Please run
 * /login" or "API Error: 401", task #3301): a Team agent launched while its owner's grant could not be read, or holding a
 * token the relay no longer takes, is relaunched the same way once a grant reads and answers.
 *
 * ⚠️ The token is never logged: a grant is compared only by a digest, held in memory.
 */
import { createHash } from 'node:crypto'
import { openDaemon } from '../agentClient/daemon.js'
import type { CoreApi } from '../core/api.js'
import { readAuthSession } from '../lib/authSession.js'
import { readTeamConfig } from '../team/config.js'
import { readTeamRelay, type TeamRelayGrant } from '../team/relay.js'

/** How long an agent's model fails before its grant is looked at. Claude Code retries a refused connection for minutes
 *  before it gives up a turn, and a busy model's retries mostly clear sooner than this. */
export const RECOVER_AFTER_MS = 60_000
/** When the continue is first tried after a restart: the next screen read, once the relaunched engine is up. */
const CONTINUE_AFTER_MS = 15_000
/** A prompt open at that time is waited out this long between tries. */
const CONTINUE_RETRY_MS = 15_000
/** A restarted agent whose model still fails is not told to carry on: after this long the continue owed to it is dropped. */
const CONTINUE_GIVE_UP_MS = 10 * 60_000
/** How long a probe of the relay may take. */
const PROBE_TIMEOUT_MS = 10_000

/** Said to a restarted agent, whose last turn failed: the task is still its own. */
export const RELAY_RESTORED = 'continue: your connection to the model is back, so carry on with your task from where it stopped'

/** The engines the owner's relay serves (team/relay.ts `teamRelayLaunch`). */
const RELAYED_ENGINES: ReadonlySet<string> = new Set(['claude', 'codex'])

export interface RelayRecoveryDeps {
  /** The grant the owner's daemon publishes for this Team account now; null on any other daemon, or with none published. */
  grant(): TeamRelayGrant | null
  /** Whether the relay answers a model call with [grant]. */
  answers(grant: TeamRelayGrant): Promise<boolean>
  /** Relaunches the agent in its own pane, on the same session (`agent_restart`). */
  restart(harnessId: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** Types [text] and Enter into the agent's terminal. */
  input(harnessId: string, text: string): Promise<{ ok: true } | { ok: false; error: string }>
  now(): number
  log(line: string): void
}

/** One screen read of a running agent: when its model began failing, if it is failing now, and whether a prompt is open. */
export interface RelaySeen { failingSince: number | null; waiting: boolean }

const digestOf = (grant: TeamRelayGrant) => createHash('sha256').update(`${grant.url}\0${grant.token}`).digest('base64url')

/**
 * Whether the relay at [grant] answers a model call with its token: a GET of Claude's model list, which spends nothing.
 * The relay forwards it with the owner's sign-in, so a relay that is gone, a token it refuses and an owner it cannot sign in
 * all read as not answering.
 */
export async function relayAnswers(grant: TeamRelayGrant, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const answer = await fetchImpl(`${grant.url.replace(/\/$/, '')}/claude/v1/models`, {
      headers: { authorization: `Bearer ${grant.token}`, 'anthropic-version': '2023-06-01', accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    await answer.body?.cancel().catch(() => {})
    return answer.ok
  } catch {
    return false
  }
}

export class RelayRecovery {
  /** Per agent, the digest of the grant it was last restarted for. */
  private readonly restartedFor = new Map<string, string>()
  /** Per restarted agent, the continue owed to it: when to try it next, and when it was restarted. */
  private readonly owed = new Map<string, { at: number; restartedAt: number }>()
  private readonly busy = new Set<string>()

  constructor(private readonly deps: RelayRecoveryDeps) {}

  /** Only these agents are still here: what is kept for the others goes. */
  keep(harnessIds: ReadonlySet<string>): void {
    for (const map of [this.restartedFor, this.owed]) for (const id of map.keys()) if (!harnessIds.has(id)) map.delete(id)
  }

  /** One screen read of a running agent of [engine]. */
  async seen(harnessId: string, engine: string | undefined, read: RelaySeen): Promise<void> {
    if (this.busy.has(harnessId)) return
    this.busy.add(harnessId)
    try { await this.decide(harnessId, engine, read) } finally { this.busy.delete(harnessId) }
  }

  private async decide(harnessId: string, engine: string | undefined, read: RelaySeen): Promise<void> {
    const now = this.deps.now()
    const owed = this.owed.get(harnessId)
    if (owed) {
      if (now < owed.at) return
      if (read.failingSince === null) {
        // Enter on a permission prompt, a question or a menu would answer it.
        if (read.waiting) { owed.at = now + CONTINUE_RETRY_MS; return }
        this.owed.delete(harnessId)
        const typed = await this.deps.input(harnessId, RELAY_RESTORED).catch((error: unknown) => ({ ok: false as const, error: String(error) }))
        if (!typed.ok) this.deps.log(`could not tell ${harnessId} to carry on after its restart: ${typed.error}`)
        return
      }
      // Still failing after its restart: never told to carry on. On the same grant it is left to its model alert below; a
      // grant published since is worth one more restart.
      if (now - owed.restartedAt >= CONTINUE_GIVE_UP_MS) this.owed.delete(harnessId)
    }
    if (read.failingSince === null || now - read.failingSince < RECOVER_AFTER_MS) return
    if (!engine || !RELAYED_ENGINES.has(engine)) return
    const grant = this.deps.grant()
    if (!grant) return
    const digest = digestOf(grant)
    if (this.restartedFor.get(harnessId) === digest) return
    if (!await this.deps.answers(grant).catch(() => false)) return
    this.restartedFor.set(harnessId, digest)
    const restarted = await this.deps.restart(harnessId).catch((error: unknown) => ({ ok: false as const, error: String(error) }))
    if (!restarted.ok) {
      this.deps.log(`could not restart ${harnessId} onto its owner's current relay: ${restarted.error}`)
      return
    }
    this.deps.log(`restarted ${harnessId} onto its owner's current relay: its model had failed for ${Math.round((now - read.failingSince) / 1000)} s`)
    this.owed.set(harnessId, { at: now + CONTINUE_AFTER_MS, restartedAt: now })
  }
}

/** How long a restart may take: the relaunch waits on the engine's command and its pane. */
const RESTART_TIMEOUT_MS = 60_000

/**
 * This machine's: the grant only in the Harness Team account, read as each launch reads it (team/relay.ts
 * `realTeamRelayLaunch`); the restart through this machine's own daemon socket, as the apps ask it (`agent_restart`); the
 * continue through the core's own terminal input.
 */
export function realRelayRecovery(core: CoreApi, machineId: string, options: { now: () => number; log: (line: string) => void }): RelayRecovery {
  return new RelayRecovery({
    grant: () => {
      if (readAuthSession()?.kind !== 'team') return null
      const config = readTeamConfig()
      return config ? readTeamRelay(config) : null
    },
    answers: grant => relayAnswers(grant),
    restart: async harnessId => {
      const local = await openDaemon({ dataDir: core.dataDir, port: core.daemon.port, machineId })
      try {
        const answer = await local.request('agent_restart', { agentId: harnessId }, RESTART_TIMEOUT_MS)
        return typeof answer.error === 'string' ? { ok: false, error: answer.error } : { ok: true }
      } finally { local.close() }
    },
    input: (harnessId, text) => core.superTabs ? core.superTabs.input(harnessId, text, ['Enter']) : Promise.resolve({ ok: false, error: 'no terminal input here' }),
    now: options.now,
    log: line => options.log(`relay recovery: ${line}`),
  })
}
