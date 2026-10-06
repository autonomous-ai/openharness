/**
 * Which machine an agent is on, and getting a turn, a stop or an answer to it there: the turn router
 * across the owner's machines (docs/design/2026-10-03-harnessd.md, "Devices", step D0).
 *
 * It lived inside the dial's host (cable/cableHost.ts), so ⌘K and the window's voice route reached
 * another machine's agent only through the dial: with the dial off, ⌘K would have answered "no agent
 * list yet". It belongs to the fleet service now (services/fleet.ts), and ⌘K, the voice route and the
 * dial all send through one router, so who the person was just talking to (`lastRouted`) is one fact
 * for all three, as it was when the dial's host held it.
 *
 * Its own file, apart from the service that builds it, so the dial's host can build one over a bare
 * fleet (its tests, and a daemon whose fleet service is off) without loading the cloud socket and the
 * E2EE stores the service starts.
 */
import type { ForkResult, SendResult } from '../core/api.js'
import type { FleetRouting, ForkOutcome, SelectResult } from './fleet.js'
import { extendShortRecap } from '../lib/deviceRecap.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { RouterContinuity } from '../lib/voiceRouter.js'
import type { RecentTurn } from '../cable/cableHost.js'
import type { CableAgent, CableMachine, CableMachineSource } from '../cable/cableSession.js'
import { FleetError, type FleetMachine, type MachineFleet } from '../cable/machineFleet.js'
import type { AnswerReceipt, ReviewedAnswer } from '../cable/questionInbox.js'

export type { ForkResult, SendResult }

/**
 * This computer, as the router needs it: its identity, its agents, the window's tiles, and the doors a
 * turn, a stop or an answer for one of its own agents goes through. The dial's host fills it from its
 * wiring; the fleet service from the core (`CoreApi`).
 */
export interface FleetLocal {
  machineName(): string
  /** This computer's machineId, or '' when the daemon has never resolved one (signed out). */
  machineId(): string
  /** A stable id for this computer, used to name the local row when there is no machineId yet. */
  computerId(): string
  /** The live agents the apps are shown. */
  sessions(): RegisteredSession[]
  /** The name the apps show for an agent. */
  displayName(session: RegisteredSession): string
  /** The opaque runtime-v1 profile, which is where the dial's Model/Effort chips come from. */
  runtimeProfile?: (session: RegisteredSession) => string | null
  /** The window's tiles on its active tab, in tile order, as last reported. */
  desk(): string[]
  /** Deliver text into a local agent. The SAME path the web and the WiFi device use. */
  sendTurn: (agentId: string, text: string) => void
  stopTurn: (agentId: string) => void
  answer: (agentId: string, requestId: string, answers: Record<string, string>) => void
  answerReviewed?: (answer: ReviewedAnswer) => Promise<boolean>
  /** Recaps of a local agent's last `n` completed turns. */
  recent: (agentId: string, n: number) => RecentTurn[] | Promise<RecentTurn[]>
  /** The person's own last questions to a LOCAL agent, newest first. */
  recentAsks: (agentId: string) => string[] | Promise<string[]>
  /** Read this computer's agents again before a list is built from them: the devices in their own process
   *  keep a copy of them, asked of the core when the dial's tick or ⌘K needs it. */
  refresh?: () => Promise<void>
  updateAgent?: (agentId: string, model?: string, effort?: string) => void
  listModels?: (agentId: string) => Promise<Array<{ id: string }>>
  /** Fork a LOCAL agent — see lib/forkAgent.ts. Resolves to the new agent's id. */
  forkAgent?: (agentId: string) => Promise<ForkResult>
  log: (line: string) => void
}

/**
 * A placeholder id for a machine this daemon does not know the real id of.
 *
 * A BELT, not a mode. `harness start` refuses to run without an SSO session and awaits
 * `resolveComputerMachine()` before it spawns the daemon, so by the time anything here runs the machineId
 * is real. The guard exists because the alternative failure is silent: an empty id makes a row that
 * renders, is tappable, and can never be selected. `cable:` is deliberately not machineId-shaped, so
 * nothing downstream mistakes it for one and announces it to the backend.
 */
function placeholderId(computerId: string): string {
  return `cable:${computerId}`
}

/** How often another machine's agent list is re-asked. Far slower than the dial's one-second tick: the
 *  list changes when a person starts an agent, not continuously. */
const REMOTE_REFRESH_MS = 5_000
/** How long a machine's last good list survives failures before its tiles leave the carousel. */
const REMOTE_GRACE_MS = 30_000

/** A fleet row as the wire carries it. `authMode` does not travel: the dial has no use for the word, and
 *  `remote` is just `!local`, which the row already says. */
function toCableMachine(m: FleetMachine): CableMachine {
  return { id: m.machineId, name: m.name, state: m.state, local: false }
}

/** Split `runtime-v1:<sid>:<engine>:<model>@<effort>` back into the two words the dial's chips show. */
function chipsFromProfile(profile: string | null | undefined): { model?: string; effort?: string } {
  if (!profile || !profile.startsWith('runtime-v1:')) return {}
  const tail = profile.split(':').slice(3).join(':')
  if (!tail) return {}
  const [model, effort] = tail.split('@')
  return { model: model || undefined, effort: effort || undefined }
}

export class FleetRouter implements FleetRouting {
  /** The last turn this daemon delivered, for [lastRouted]. In memory only: a conversation that spans a
   *  daemon restart is not one the five-minute window would have carried anyway. */
  private lastTurn?: { agentId: string; at: number }

  /** Each other machine's agents, as last read. `asked` throttles the round; `at` ages the answer. */
  private readonly remoteAgents = new Map<string, { agents: CableAgent[]; at: number; asked: number }>()
  /** Machines with a list RPC in flight, so a slow machine is asked once rather than every tick. */
  private readonly inFlight = new Set<string>()
  /** agentId → machineId, rebuilt from the snapshot last handed to the dial. */
  private agentMachine = new Map<string, string>()

  /**
   * Every agent this daemon has listed since it started, by id.
   *
   * Kept for ONE purpose: a tile open in the window must always be a tile on the dial. A machine can
   * leave the list for reasons that have nothing to do with its agents — the backend going quiet, the
   * machine going offline while its work stays on screen — and a desk with a hole in it makes a swipe
   * skip a tile and an agent chosen in the window have nowhere to land.
   */
  private readonly knownAgents = new Map<string, CableAgent>()

  /** Tiles currently held on the list from that memory, so it is logged once and not every tick. */
  private readonly deskHeld = new Set<string>()

  /** Size of the last flat list — see agentTotal. */
  private flatCount = 0

  /** agentId → machineId for agents heard from but not (yet) listed — see noteAgent. */
  private readonly seenOn = new Map<string, string>()
  /** machineId → name, from the last wheel read, for describe(). */
  private machineNames = new Map<string, string>()

  /** `fleet` undefined = no lane to any other machine exists; every agent is this computer's. */
  constructor(private readonly local: FleetLocal, readonly fleet?: MachineFleet) {}

  /** This computer's id, or the placeholder when it has none yet. */
  localId(): string {
    return this.local.machineId() || placeholderId(this.local.computerId())
  }

  async listMachines(): Promise<{ machines: CableMachine[]; source: CableMachineSource }> {
    const local: CableMachine = {
      id: this.localId(),
      // The machine's own name. What makes this row recognisable as the cabled one is its second line,
      // which the dial writes — see machine_meta_line.
      name: this.local.machineName(),
      // Always ready: the cable IS the evidence. Nothing else on this list can say that about itself.
      state: 'ready',
      local: true,
    }
    if (!this.fleet) return { machines: [local], source: 'signed-out' }
    const { machines, source } = await this.fleet.list()
    const rows: CableMachine[] = [local]
    for (const m of machines) {
      // The backend list contains THIS computer too. Dropped rather than rendered: the same machine on
      // the wheel twice, under two names, with the ✓ able to mark only one of them. Its name is already
      // here anyway — MACHINE_NAME_FILE is mirrored from the backend on every connect.
      if (m.machineId === local.id) continue
      rows.push(toCableMachine(m))
    }
    return { machines: rows, source }
  }

  /** This computer's own agents, in the order every other surface reads them in. */
  private localAgents(): CableAgent[] {
    // `advertised()`, not `list()` — the SAME set `agents_list` answers the web and the desktop app with. They
    // read one registry and must not disagree about what is on it: a dead agent holding a tile on the dial
    // and nowhere else is a tile that cannot be driven and cannot be explained.
    // Terminals INCLUDED. A shell has no turn to watch and no model to switch, and the dial does not
    // pretend otherwise — it draws the tile and offers no Voice on it. What it does offer is the
    // thing that was missing: the tile can be reached. The window draws a shell as a tile like any
    // other, so a dial that skipped it disagreed with the app about what was on the desk, and a pane
    // the carousel cannot walk to is a pane the dial cannot explain either. A terminal that has
    // adopted an engine is that engine here, as everywhere.
    //
    // ⚠️ NOT the same question as `deviceAgentRow` in core/agents/list.ts, which keeps shells out of the
    // `agents_list` RPC a CLOUD device asks over the backend. This is the cable's own list, pulled by
    // `listAgents()` on the session's tick; the two surfaces answer separately and always did.
    const sessions = this.local.sessions()
    // Oldest → newest, and TOTAL: the id breaks a tie so the order cannot fall through to array position,
    // which is Map insertion order and differs between daemon runs. Both producers sort identically, so
    // the dial and the app cannot drift apart while reading the same registry.
    sessions.sort((a, b) => a.registeredAt - b.registeredAt || a.agentId.localeCompare(b.agentId))
    const machineId = this.localId()
    const machine = this.local.machineName()
    return sessions.map((s) => ({
      id: s.agentId,
      name: this.local.displayName(s),
      engine: s.engine ?? '',
      machineId,
      machine,
      ...chipsFromProfile(this.local.runtimeProfile?.(s)),
    }))
  }

  /**
   * Name, engine and machine of an agent this daemon has ever listed — for a `summary` or `question`
   * about one the dial no longer holds. The dial used to look these up in its own copy of the fleet;
   * with that copy gone, the frame has to say who it is about.
   */
  describe(agentId: string): { name: string; engine: string; machine: string } | undefined {
    const a = this.knownAgents.get(agentId) ?? this.localAgents().find((x) => x.id === agentId)
    if (a) return { name: a.name, engine: a.engine ?? '', machine: a.machine ?? '' }
    // A remote agent whose machine has spoken (a question, a card) before its list was ever read: no
    // name to give, but the machine's is better than nothing on a screen asking for a decision.
    const machineId = this.seenOn.get(agentId)
    const machine = machineId ? this.machineNames.get(machineId) ?? '' : ''
    return machineId ? { name: '', engine: '', machine } : undefined
  }

  /**
   * A card arrived from a machine for an agent. Remembered so a `question` or `summary` about an agent
   * this daemon has never LISTED — a remote machine's, before its list was read, or one on a tab the
   * window has not opened — can still be described and, when tapped, opened: `machineOf` falls back to
   * this, and without it the open was "ignored for unknown agent" and the tap did nothing.
   */
  noteAgent(machineId: string, agentId: string): void {
    if (machineId && agentId) this.seenOn.set(agentId, machineId)
  }

  /**
   * EVERY agent in LIST order — this computer first, then each machine in wheel order — the fleet the
   * dial no longer holds.
   *
   * It is the order the desktop app's rail draws, and the two must not drift: ⌘K reads this to decide
   * which agents a typed task is weighed against, and a person looking at their rail while they type has
   * every right to expect "the first fifteen" to mean the first fifteen they can see. The dial's
   * `listAgents()` is its view of the same snapshot — the same agents, re-cut around the tiles the window
   * has open, which is a different question with a different right answer.
   *
   * Read from a CACHE, never from a live RPC. The dial calls this on the session's one-second tick, and a
   * naive implementation would fire one cloud round trip per machine per second — the dial would spend
   * its whole life waiting on the network to answer a question whose answer changes every few minutes.
   * `refreshRemotes()` does the asking, off to the side, on its own slower clock.
   */
  async listAgentsFlat(): Promise<CableAgent[]> {
    await this.local.refresh?.()
    const out = this.localAgents()
    const { machines } = await this.listMachines()
    this.machineNames = new Map(machines.map((m) => [m.id, m.name]))
    for (const m of machines) {
      if (m.local) continue
      const entry = this.remoteAgents.get(m.id)
      if (entry) for (const a of entry.agents) out.push({ ...a, machineId: m.id, machine: m.name })
    }
    this.refreshRemotes(machines)
    // Rebuilt from the SAME snapshot that is about to be pushed, so the map can never name a machine an
    // agent has already left. Every action the dial can take is routed through it.
    const next = new Map<string, string>()
    for (const a of out) if (a.machineId) next.set(a.id, a.machineId)
    this.agentMachine = next

    const byId = new Map(out.map((a) => [a.id, a]))

    for (const a of out) this.knownAgents.set(a.id, a)
    // A tile the window has open, whose agent has left the list. Put it back — under the name and
    // machine it was last seen with, so the dial's tile keeps saying what the window's tile says.
    //
    // Gated on being ON THE DESK, and only that: an agent that was deleted, or one simply never
    // opened, must not be resurrected by this memory. The window holding a tile is the whole warrant.
    const missing = this.local.desk().filter((id) => !byId.has(id))
    for (const id of missing) {
      const remembered = this.knownAgents.get(id)
      if (!remembered) continue
      // Appended, not slotted back where it was. When a machine drops out none of its agents are left
      // to sit beside, so the end of the list is the only honest place; the tab's list is drawn in TILE
      // order by the dial's listAgents, so where it sits here does not matter. Never routed by position
      // either — `agentMachine` below is what sends a turn home.
      out.push(remembered)
      byId.set(id, remembered)
      if (remembered.machineId) this.agentMachine.set(id, remembered.machineId)
      if (!this.deskHeld.has(id)) {
        this.deskHeld.add(id)
        this.local.log(`cable: holding ${id.slice(0, 8)} on the tab — the window has a tile for it`)
      }
    }
    for (const id of [...this.deskHeld]) if (!missing.includes(id)) this.deskHeld.delete(id)

    // The overview's number is AGENTS, and a shell is not one. The carousel carries shell tiles now —
    // they are panes the window has and the dial can reach — but "12 agents · all idle" is read as how
    // much work is in flight, and counting empty terminals in it would answer a question nobody asked.
    // Two different numbers about the same desk, each honest about what it counts.
    this.flatCount = out.filter((a) => a.engine !== 'terminal').length
    return out
  }

  /** How many agents the account has across every machine — the overview's number, sent beside the
   *  tab's list rather than as 70 rows the dial would hold for a digit. Read from the last flat list,
   *  minus the terminals in it: the list is every TILE, this is every AGENT. */
  agentTotal(): number {
    return this.flatCount
  }

  /**
   * Which machine an agent lives on, or '' if the dial named one this daemon has never listed.
   *
   * NEVER falls back to the selected machine. A wrong answer here does not fail — it delivers the user's
   * turn to a different computer, which is the worst outcome this whole feature can produce.
   */
  machineOf(agentId: string): string {
    return this.agentMachine.get(agentId) ?? this.seenOn.get(agentId) ?? ''
  }

  /** Whether this daemon's last list held that agent — see CableHost.knows. */
  knows(agentId: string): boolean {
    return this.agentMachine.has(agentId)
  }

  /** True when the agent belongs to this computer (or is unknown, which is handled at the call site). */
  isLocalAgent(agentId: string): boolean {
    const machineId = this.machineOf(agentId)
    return !machineId || machineId === this.localId()
  }

  /**
   * Fork an agent on its own machine: the same `agent_fork` the window sends. The new agent is noted on
   * that machine at once, so the open that follows lands before any list has named it. The outcome says
   * which machine was asked, and whether anyone was: a refusal before asking (an agent never listed, a
   * daemon or a fleet that cannot fork) is only an answer.
   */
  async forkAgent(agentId: string): Promise<ForkOutcome> {
    const machineId = this.machineOf(agentId)
    const refused = (result: ForkResult): ForkOutcome => ({ result, machineId, asked: false })
    if (!machineId) return refused({ ok: false, error: 'AGENT_NOT_FOUND', detail: 'The dial named an agent this daemon has never listed.' })
    let result: ForkResult
    if (this.isLocalAgent(agentId)) {
      if (!this.local.forkAgent) return refused({ ok: false, error: 'UNSUPPORTED', detail: 'This daemon cannot fork agents.' })
      result = await this.local.forkAgent(agentId)
    } else {
      if (!this.fleet?.forkAgent) return refused({ ok: false, error: 'UNSUPPORTED_ON_REMOTE' })
      try {
        result = { ok: true, agentId: await this.fleet.forkAgent(machineId, agentId) }
      } catch (err) {
        result = { ok: false, error: 'FORK_FAILED', detail: (err as Error).message }
      }
    }
    if (result.ok) this.seenOn.set(result.agentId, machineId)
    return { result, machineId, asked: true }
  }

  // ── the lane, held while a dial is plugged in ───────────────────────────────────────────────────

  hasLane(): boolean {
    return !!this.fleet
  }

  /** Come online for a dial — see MachineFleet.online. A lane that will not open is an answer: the dial
   *  says so in its log and carries on with this computer. */
  async online(): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      await this.fleet!.online()
      return { ok: true }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  }

  /** Attach to a machine, which is also how the backend learns where the dial is. A refusal comes back with
   *  the code the dial acts on and the words it shows; anything else unexpected reads as unreachable. */
  async select(machineId: string): Promise<SelectResult> {
    try {
      await this.fleet!.select(machineId)
      return { ok: true }
    } catch (err) {
      if (err instanceof FleetError) return { ok: false, code: err.code, message: err.message }
      return { ok: false, code: 'UNREACHABLE', message: (err as Error).message }
    }
  }

  /** Let go of what `select` acquired; `immediate` when the dial is gone — see MachineFleet.release. */
  release(immediate?: boolean): void {
    this.fleet?.release(immediate)
  }

  /**
   * Refresh the other machines' agent lists, on their own clock.
   *
   * Only `ready` machines are asked. An offline one has nothing to say and an unlinked one cannot be
   * read at all (no pinned key), and asking either costs a 15-second RPC timeout per machine per round.
   *
   * A machine that fails keeps its LAST GOOD list for `REMOTE_GRACE_MS` and only then goes empty. A cloud
   * blip is the common case, and dropping every one of a machine's tiles off the carousel for a few
   * seconds — then putting them back — is a far worse lie than briefly showing a list that is a minute
   * old.
   *
   * `unknown` is NOT a reason to drop anything, and reading it as one cost a morning. It means the
   * backend could not be asked — `MachineListCache.degrade()` sets every machine to it in one go when
   * the list cannot be refreshed, on the stated principle that the rows are "stale but not wrong". The
   * agents follow the rows: kept, with no timer, until the backend actually says offline. Measured on
   * the real dial, the old reading emptied a remote machine off the carousel mid-session with no log
   * line, while the window went on showing those agents — which is what made a swipe run out of agents
   * early, and an agent chosen in the window have no tile to move to.
   */
  private refreshRemotes(machines: CableMachine[]): void {
    if (!this.fleet) return
    const fleet = this.fleet
    const now = Date.now()
    for (const m of machines) {
      if (m.local) continue
      const entry = this.remoteAgents.get(m.id)
      if (m.state === 'offline' || m.state === 'needs-link') {
        // The machine ITSELF says it has nothing to offer, which is different from not being able to
        // ask it. No grace period, but never silently: an agent leaving the carousel is exactly the
        // event that is impossible to diagnose after the fact from its absence.
        if (entry && entry.agents.length) {
          this.remoteAgents.set(m.id, { agents: [], at: now, asked: entry.asked })
          this.local.log(`cable: ${m.name} is ${m.state} — its ${entry.agents.length} agents left the carousel`)
        }
        continue
      }
      // Not ready and not refused: the backend could not be asked. Keep what it last said.
      if (m.state !== 'ready') continue
      if (entry && now - entry.asked < REMOTE_REFRESH_MS) continue
      if (this.inFlight.has(m.id)) continue
      this.inFlight.add(m.id)
      this.remoteAgents.set(m.id, { agents: entry?.agents ?? [], at: entry?.at ?? 0, asked: now })
      void fleet.listAgents(m.id)
        .then((agents) => {
          const before = this.remoteAgents.get(m.id)
          this.remoteAgents.set(m.id, { agents, at: Date.now(), asked: Date.now() })
          // One line per TRANSITION, not per round: this runs every few seconds forever, and a healthy
          // machine that logs each time buries everything else in the file.
          if (!before || before.agents.length !== agents.length) {
            this.local.log(`cable: ${m.name} → ${agents.length} agents`)
          }
        })
        .catch((err) => {
          const before = this.remoteAgents.get(m.id)
          const stale = before && Date.now() - before.at > REMOTE_GRACE_MS
          if (stale) this.remoteAgents.set(m.id, { agents: [], at: Date.now(), asked: Date.now() })
          if (before?.agents.length && stale) {
            this.local.log(`cable: ${m.name} dropped off the carousel (${(err as Error).message})`)
          }
        })
        .finally(() => this.inFlight.delete(m.id))
    }
  }

  /**
   * Deliver a turn, and SAY whether it could be.
   *
   * The remote leg is fire-and-forget by protocol — `message` frames carry no ack — so a machine that
   * has stopped answering takes the turn and nothing comes back. Measured: the fleet's own `agents_list`
   * was timing out every twenty seconds while a ⌘K route was handed to an agent on that machine, and
   * every side stayed silent about it. The E2EE session still said `ready`, because it handshook while
   * the machine was alive; the backend's list still called it online.
   *
   * So the check is the one thing that actually knows: did the LAST request to that machine come back.
   * Never asked (null) is not a refusal — a cold start must not read as a failure.
   *
   * Callers that do not care may ignore the result; nothing here changes for them.
   */
  sendTurn(agentId: string, text: string): SendResult {
    if (!this.isLocalAgent(agentId)) {
      const machineId = this.machineOf(agentId)
      const machine = this.knownAgents.get(agentId)?.machine || machineId.slice(0, 8)
      const seen = this.fleet?.reachable?.(machineId)
      if (seen && !seen.ok) {
        const ago = Math.round((Date.now() - seen.at) / 1000)
        this.local.log(`cable: refused a turn for ${agentId.slice(0, 8)} — ${machine} last failed ${ago}s ago`)
        return { ok: false, machine, reason: 'the last request to it did not come back' }
      }
      this.fleet!.sendTurn(machineId, agentId, text)
      this.spokeTo(agentId)
      return { ok: true }
    }
    this.local.sendTurn(agentId, text)
    this.spokeTo(agentId)
    return { ok: true }
  }

  /**
   * Remember who this person is talking to.
   *
   * Recorded HERE because every path that actually delivers a turn passes through sendTurn — the
   * window's palette, the dial naming a tile, and the router's own fallback — so there is one fact and
   * one place it is written. Recorded only on a delivery that was accepted: a turn refused because its
   * machine went deaf is not a conversation anybody is in the middle of.
   */
  private spokeTo(agentId: string): void {
    if (agentId) this.lastTurn = { agentId, at: Date.now() }
  }

  /** Who the last delivered turn went to, and how long ago — the router's continuity signal. */
  lastRouted(): RouterContinuity | undefined {
    if (!this.lastTurn) return undefined
    return { agentId: this.lastTurn.agentId, agoMs: Date.now() - this.lastTurn.at }
  }

  stopTurn(agentId: string): void {
    if (!this.isLocalAgent(agentId)) { this.fleet!.stopTurn(this.machineOf(agentId), agentId); return }
    this.local.stopTurn(agentId)
  }

  canSpeakQuestion(agentId: string): boolean {
    // Remote receiver capabilities are not negotiated yet; no free-text fallback.
    return this.knows(agentId) && this.isLocalAgent(agentId) && !!this.local.answerReviewed
  }

  async answerReviewed(answer: ReviewedAnswer): Promise<AnswerReceipt> {
    if (answer.freeTextKeys?.length && !this.canSpeakQuestion(answer.agentId))
      return { ok: false, error: 'Use the terminal to type this answer.' }
    if (!this.isLocalAgent(answer.agentId)) {
      const machineId = this.machineOf(answer.agentId)
      if (!this.fleet || this.fleet.reachable?.(machineId)?.ok === false) {
        return { ok: false, error: 'That machine is unavailable. Check its connection.' }
      }
      // Older remote drivers split multi-select labels on commas. Do not lose
      // a selected label when that receiver cannot prove support for exact arrays.
      if (answer.questions.some(q => q.multi && answer.selections[q.key]?.some(label => label.includes(',')))) {
        return { ok: false, error: 'Use the terminal for this multi-select answer.' }
      }
      if (this.fleet.answerReviewed) this.fleet.answerReviewed(machineId, answer)
      else this.fleet.answer(machineId, answer.agentId, answer.requestId, answer.answers)
      return { ok: true, pending: true } // Handoff only; the dialog's close is authoritative.
    }
    if (!this.local.answerReviewed) return { ok: false, error: 'Update Harness to answer this question.' }
    const ok = await this.local.answerReviewed(answer)
    return ok ? { ok: true } : { ok: false, error: 'Could not confirm the answer. Check the terminal.' }
  }

  answer(agentId: string, requestId: string, answers: Record<string, string>): void {
    if (!this.isLocalAgent(agentId)) { this.fleet!.answer(this.machineOf(agentId), agentId, requestId, answers); return }
    this.local.answer(agentId, requestId, answers)
  }

  updateAgent(agentId: string, model?: string, effort?: string): void {
    if (!this.isLocalAgent(agentId)) { this.fleet!.updateAgent(this.machineOf(agentId), agentId, model, effort); return }
    this.local.updateAgent?.(agentId, model, effort)
  }

  /** The last few turns, newest first, in the shape the dial's tile draws: a headline and a body. */
  async recentSummaries(agentId: string): Promise<Array<{ recap: string; text: string; ask: string }>> {
    const raw = this.isLocalAgent(agentId)
      ? await this.local.recent(agentId, 3)
      : await this.fleet!.recentSummaries(this.machineOf(agentId), agentId)
    return raw
      .map((r) => ({ recap: extendShortRecap(r?.recap ?? '', r?.text ?? ''), text: r?.text ?? '', ask: r?.ask ?? '' }))
      .filter((s) => s.recap || s.text || s.ask)
  }

  /**
   * The person's own last questions to an agent, newest first — what the router ranks on.
   *
   * Its own trip rather than a field on [recentSummaries]: a question is recorded when it is asked and
   * a recap when the answer is summarised, so the two lists are different lengths on any machine where
   * a turn ended without one. Folding them together is what left the newest question — the one that
   * says where the next one belongs — off the end.
   */
  async recentAsks(agentId: string): Promise<string[]> {
    const raw = this.isLocalAgent(agentId)
      ? await this.local.recentAsks(agentId)
      : await this.fleet!.recentAsks(this.machineOf(agentId), agentId)
    return raw.map((a) => (a || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
  }

  async listModels(agentId: string): Promise<string[]> {
    if (!this.isLocalAgent(agentId)) return this.fleet!.listModels(this.machineOf(agentId), agentId)

    const models = (await this.local.listModels?.(agentId)) ?? []
    return models.map((m) => m.id).filter(Boolean)
  }
}
