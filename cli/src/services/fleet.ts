/**
 * The fleet: the owner's other machines, and getting to them (docs/design/2026-10-03-harnessd.md,
 * "Devices", step D0). The machine list kept fresh, the keys pinned for the machines linked to this
 * one, the device lane to them (`DeviceLink`, `DeviceFleet`), and the router every turn goes through:
 * which machine an agent is on, and a turn, a stop or an answer reaching it there (fleetRouter.ts).
 *
 * It was built inside the dial's wiring, and the router lived in the dial's host, so ⌘K and the
 * window's voice route reached another machine only through the dial. It is a part of the devices now
 * (services/devices.ts, step 9), beside its main caller: the dial reads a dozen routing facts while it
 * builds each frame (which machine an agent is on, whether it is known, who it is), and those reads
 * stay in line only on the same side of a process boundary as the dial. ⌘K reaches it through the
 * devices' port.
 *
 * It reads the core only through `CoreApi`.
 */
import { env } from '../config/env.js'
import { FAIL, later, type CoreApi, type PortFallbacks, type RouteAnswer, type SendResult, type ForkResult } from '../core/api.js'
import { DeviceFleet } from '../device/deviceFleet.js'
import { DeviceLink } from '../device/deviceLink.js'
import type { MachineListCache } from '../device/machineList.js'
import { MachinePeerStore } from '../lib/e2ee/machinePeers.js'
import { routeVoiceTask, type RouterAgent, type RouterContinuity } from '../lib/voiceRouter.js'
import type { CableAgent, CableMachine, CableMachineSource } from '../cable/cableSession.js'
import type { FleetEvent } from '../cable/machineFleet.js'
import type { AnswerReceipt, ReviewedAnswer } from '../cable/questionInbox.js'
import { FleetRouter } from './fleetRouter.js'

/** A fork and where it was asked: `asked` is false for a refusal made before asking anyone (an agent
 *  never listed, a daemon or a fleet that cannot fork), which nobody needs to hear about. */
export interface ForkOutcome { result: ForkResult; machineId: string; asked: boolean }
/** A machine selected for the dial, or the refusal a person can act on. */
export type SelectResult = { ok: true } | { ok: false; code: string; message: string }

/**
 * Which machine an agent is on, and a turn, a stop or an answer reaching it there: the fleet's router
 * (services/fleetRouter.ts), as the dial asks it. Also the lane to the other machines, which the dial
 * holds while it is plugged in. A refusal is an answer here, never a throw: through the devices' guard,
 * a throw is a failure of the fleet, and counts toward switching it off.
 */
export interface FleetRouting {
  listMachines(): Promise<{ machines: CableMachine[]; source: CableMachineSource }>
  listAgentsFlat(): Promise<CableAgent[]>
  agentTotal(): number
  describe(agentId: string): { name: string; engine: string; machine: string } | undefined
  noteAgent(machineId: string, agentId: string): void
  machineOf(agentId: string): string
  knows(agentId: string): boolean
  isLocalAgent(agentId: string): boolean
  sendTurn(agentId: string, text: string): SendResult
  lastRouted(): RouterContinuity | undefined
  stopTurn(agentId: string): void
  canSpeakQuestion(agentId: string): boolean
  answerReviewed(answer: ReviewedAnswer): Promise<AnswerReceipt>
  answer(agentId: string, requestId: string, answers: Record<string, string>): void
  updateAgent(agentId: string, model?: string, effort?: string): void
  recentSummaries(agentId: string): Promise<Array<{ recap: string; text: string; ask: string }>>
  recentAsks(agentId: string): Promise<string[]>
  listModels(agentId: string): Promise<string[]>
  forkAgent(agentId: string): Promise<ForkOutcome>
  /** Whether a lane to the other machines exists: signed in, with the fleet's own fleet. */
  hasLane(): boolean
  /** Hold the lane for a dial, attached to no machine. Resolves with how it went; never rejects. */
  online(): Promise<{ ok: true } | { ok: false; message: string }>
  select(machineId: string): Promise<SelectResult>
  release(immediate?: boolean): void
}

/** The fleet as the devices hold it: ⌘K's two requests — which agent a typed task belongs to, on any of
 *  the owner's machines, and delivering it to that agent's own machine — the routing the dial asks of it,
 *  the cards the other machines send, and stopping the lane to them. */
export interface Fleet extends FleetRouting {
  routeTask(text: string): Promise<RouteAnswer>
  routeSend(agentId: string, text: string): SendResult
  /** The other machines' cards, for the dial. Returns how to stop hearing them. */
  onEvent(listener: (event: FleetEvent) => void): () => void
  stop(): void
}

export const FLEET_UNAVAILABLE = 'the fleet service is unavailable'

/**
 * What the devices get when the fleet fails. ⌘K says so, picking no agent and sending nothing; a shutdown
 * goes on; the cards stop. The dial's routing FAILs: the dial routes this computer by itself then, as it
 * does with the fleet off (cable/cableHost.ts), rather than reading a made-up answer as the fleet's.
 */
export const FLEET_FALLBACKS: PortFallbacks<Fleet> = {
  routeTask: later({ agentId: '', machineId: '', name: '', confidence: 0, reason: FLEET_UNAVAILABLE, candidates: [], weighed: 0, machines: 0, via: '' }),
  routeSend: { ok: false, machine: '', reason: FLEET_UNAVAILABLE },
  onEvent: () => {},
  stop: undefined,
  listMachines: later(FAIL), listAgentsFlat: later(FAIL), agentTotal: FAIL, describe: FAIL, noteAgent: FAIL,
  machineOf: FAIL, knows: FAIL, isLocalAgent: FAIL, sendTurn: FAIL, lastRouted: FAIL, stopTurn: FAIL,
  canSpeakQuestion: FAIL, answerReviewed: later(FAIL), answer: FAIL, updateAgent: FAIL, recentSummaries: later(FAIL),
  recentAsks: later(FAIL), listModels: later(FAIL), forkAgent: later(FAIL), hasLane: FAIL, online: later(FAIL),
  select: later(FAIL), release: FAIL,
}

/**
 * How many agents ⌘K weighs at once.
 *
 * A classifier budget, not a UI one: each candidate spends its name, its machine and three recaps inside
 * one prompt, and past a point the window that decides the pick is more crowded than it is informed.
 * Fifteen is the owner's number; the ordering that decides WHICH fifteen is in routeTask.
 */
const ROUTE_MAX_CANDIDATES = 15
/** What ⌘K gives the classifier before the name matcher answers instead. */
const ROUTE_CLASSIFY_APP_MS = 20_000
/** How often the machine list is read again: the wheel's dots and the agent lists follow it. */
const MACHINE_LIST_REFRESH_MS = 60_000

/** What the fleet needs that is not the core's to give. */
export interface FleetDeps {
  /** The owner's machines: the devices' own copy of the list, read from the core (`account.machines`).
   *  This service keeps it fresh. */
  machines: MachineListCache
  /** The window's tiles on its active tab, in tile order, as it last reported them. */
  desk(): string[]
  /** Read this computer's agents again before a list is built from them (FleetLocal.refresh). */
  refresh?: () => Promise<void>
}

/** Start the fleet: what ⌘K and the dial reach it through. The router itself is returned beside it, for
 *  this service's own tests; nothing else holds it. */
export function startFleet(core: CoreApi, deps: FleetDeps): { fleet: Fleet; router: FleetRouter } {
  // Three independent things, on purpose. The LIST is a REST read that works while the backend socket is
  // down; `local` is derived from the computer id and needs no network at all; and the LANE is a device
  // socket that only exists while the dial is actually looking at another machine.
  //
  // Signed out there is nothing to fetch and a fetch would only earn a 401 that empties the wheel, so the
  // core answers with the one row this daemon can speak for (`account.machines`).
  const refreshMachineList = (): void => { void deps.machines.refresh() }
  refreshMachineList()
  const machineListTimer = setInterval(refreshMachineList, MACHINE_LIST_REFRESH_MS)
  machineListTimer.unref?.()

  const peers = new MachinePeerStore()
  const link = new DeviceLink({
    // Signed in and sealed through the core (step 10, R3): its tokens are the core's session's, which
    // shares a refresh in flight with the backend link, and its E2EE sessions are the gateway's, under the
    // SAME identity `harness remote-password set` publishes and `harness link connect` proves knowledge
    // against, so one link ceremony covers the desktop app's relay and the dial's lane alike.
    auth: { accessToken: (options) => core.account.accessToken(options) },
    backendWsBase: env.BACKEND_WS_URL,
    computerId: core.machine.computerId(),
    autonomousEnv: core.account.environment(),
    seal: core.account.lane,
    // Read FRESH on every attach: `harness link connect` runs as a separate process, so a value captured
    // at daemon start would keep answering "not linked" until the next restart.
    peer: (machineId) => peers.get(machineId),
    // Read fresh for the same reason: it is '' until the daemon has resolved this computer's machine, and
    // the echo guard must start working the moment it is not.
    localMachineId: () => core.machine.id(),
    log: (line) => console.log(`[device] ${line}`),
  })
  const devices = new DeviceFleet({
    list: deps.machines,
    link,
    // Read FRESH on every call, never cached: `harness link connect` runs as a separate process, so a
    // cached answer would keep saying "not linked" for as long as this daemon lives.
    hasPeerLink: (machineId) => peers.get(machineId) !== null,
    log: (line) => console.log(`[device] ${line}`),
  })
  // This computer's side of every route: the core's own doors, the ones the web and the hooks use.
  const router = new FleetRouter({
    machineName: () => core.machine.name(),
    machineId: () => core.machine.id(),
    computerId: () => core.machine.computerId(),
    sessions: () => core.agents.advertised(),
    refresh: deps.refresh,
    displayName: (session) => core.agents.displayName(session),
    runtimeProfile: (session) => core.agents.runtimeProfile(session),
    desk: () => deps.desk(),
    sendTurn: (agentId, text) => core.turns.send(agentId, text),
    stopTurn: (agentId) => core.turns.stop(agentId),
    answer: (agentId, requestId, answers) => core.questions.answer(agentId, requestId, answers),
    answerReviewed: (answer) => core.questions.answerReviewed(answer),
    recent: (agentId, n) => core.turns.recent(agentId, n),
    recentAsks: (agentId) => core.turns.asks(agentId),
    updateAgent: (agentId, model, effort) => core.agents.setRuntime(agentId, model, effort),
    listModels: (agentId) => core.agents.runtimeModels(agentId),
    forkAgent: (agentId) => core.agents.fork(agentId),
    // The lines the dial's host always wrote, under the name people search the log for.
    log: (line) => console.log(`[cable] ${line}`),
  }, devices)
  // Which machine an agent is on, before its list is necessarily read: what lets a question from it be
  // named and, tapped, opened — whichever surface is listening, the dial or none.
  devices.onEvent((event) => { if (event.kind !== 'state') router.noteAgent(event.machineId, event.agentId) })
  const fleet: Fleet = {
    // ⌘K's two requests.
    routeTask: (text) => routeTask(router, text),
    routeSend: (agentId, text) => router.sendTurn(agentId, text),
    // What the dial asks: the router's own answers.
    listMachines: () => router.listMachines(),
    listAgentsFlat: () => router.listAgentsFlat(),
    agentTotal: () => router.agentTotal(),
    describe: (agentId) => router.describe(agentId),
    noteAgent: (machineId, agentId) => router.noteAgent(machineId, agentId),
    machineOf: (agentId) => router.machineOf(agentId),
    knows: (agentId) => router.knows(agentId),
    isLocalAgent: (agentId) => router.isLocalAgent(agentId),
    sendTurn: (agentId, text) => router.sendTurn(agentId, text),
    lastRouted: () => router.lastRouted(),
    stopTurn: (agentId) => router.stopTurn(agentId),
    canSpeakQuestion: (agentId) => router.canSpeakQuestion(agentId),
    answerReviewed: (answer) => router.answerReviewed(answer),
    answer: (agentId, requestId, answers) => router.answer(agentId, requestId, answers),
    updateAgent: (agentId, model, effort) => router.updateAgent(agentId, model, effort),
    recentSummaries: (agentId) => router.recentSummaries(agentId),
    recentAsks: (agentId) => router.recentAsks(agentId),
    listModels: (agentId) => router.listModels(agentId),
    forkAgent: (agentId) => router.forkAgent(agentId),
    hasLane: () => router.hasLane(),
    online: () => router.online(),
    select: (machineId) => router.select(machineId),
    release: (immediate) => router.release(immediate),
    // The other machines' cards, for the dial's screen. The router notes their machines itself, above.
    onEvent: (listener) => devices.onEvent(listener),
    stop: () => {
      clearInterval(machineListTimer)
      link.stop()
    },
  }
  return { fleet, router }
}

/**
 * ⌘K in the window: a typed task, and which agent it belongs to.
 *
 * THE SAME ROUTER THE DIAL USES, given a second caller. routeVoiceTask has never cared that its input
 * arrived as speech — the transcript is just text by the time it sees it — so this is not a port. What
 * is new is the answer coming back to something that can SHOW it: the dial had to act on the pick,
 * the window can ask.
 *
 * EVERY AGENT, EVERY MACHINE. The candidate list is the dial's own — this computer first, then each
 * machine in wheel order — because the agent that fits the words is not always the one on the desk in
 * front of you, and a router that cannot see the others cannot say so.
 *
 * CAPPED AT FIFTEEN, and the cap is about the CLASSIFIER, not about us: every candidate spends its
 * name and three recaps in one prompt, and a list long enough to crowd that window makes the pick
 * worse, not slower.
 *
 * WHICH fifteen is the rail's own order — this computer's agents, then each other machine's — because
 * that is the list the person is looking at while they type, and "the first fifteen" has to mean the
 * first fifteen they can SEE. An earlier cut put open tiles first, on the theory that working on
 * something is a statement about relevance; it is, but it also made the fifteen unpredictable from
 * the screen, and predictable beat clever here (owner's call).
 */
async function routeTask(router: FleetRouter, text: string): Promise<RouteAnswer> {
  // Whatever the daemon knows right now. This also kicks a refresh of the remote machines, so a list
  // that is short because a machine has not been asked yet fills in for the NEXT question rather than
  // holding this one open.
  // FLAT, not the dial's ring: listAgents() re-cuts the same snapshot around the window's open
  // tiles, which is the right answer for a carousel and the wrong one for a list the person reads
  // top to bottom.
  const all = await router.listAgentsFlat()
  const ranked = all.slice(0, ROUTE_MAX_CANDIDATES)
  if (ranked.length < all.length) {
    // Never a silent truncation: a route that could not have picked the right agent must not read
    // like a route that considered it and said no.
    console.log(`[route] ${all.length} agents · weighing the first ${ranked.length} (open tiles first)`)
  }
  // Recaps AFTER the cap, and in parallel: a remote agent's recap is an RPC to its machine, so
  // fetching for agents that were never going to be weighed is latency spent on nothing. They are
  // cached per agent on the fleet side, so a second ⌘K costs no round trip at all.
  const candidates: RouterAgent[] = await Promise.all(ranked.map(async (agent) => ({
    id: agent.id,
    name: agent.name,
    engine: agent.engine,
    machine: agent.machine,
    // THE PERSON'S OWN QUESTIONS, AND NOTHING ELSE.
    //
    // This used to be `turn.ask || turn.recap || turn.text`, cut to sixty characters and joined
    // into one blob — under a prompt heading that told the model every word of it was something
    // the person had asked. For any agent with no recorded question that was false: it was a
    // summary of what the AGENT REPLIED. Measured on this desk, "which year did the second world
    // war end" summarised to "1945." — an answer, labelled as a question, handed to a model asked
    // to recognise a topic. An agent with nothing on record now sends an empty list and is
    // described honestly in the prompt.
    //
    // UNCUT, too. Sixty characters was chosen when fifteen agents each carried three recaps at
    // full length and the prompt timed out; a real machine has four to eight agents, and cutting
    // a Vietnamese sentence at sixty takes the object with it — which is the topic. The bound that
    // matters now lives at the two ends: ASK_MAX_CHARS where the question is recorded, and the
    // endpoint's own per-prompt ceiling.
    prompts: await router.recentAsks(agent.id),
  })))
  // 20s, not the shared 12s: this path answers a person watching a spinner in their own window, and
  // it is under nobody else's deadline — the app's rpc waits longer still. The dial and the web keep
  // the default; overshooting a deadline they DO have would turn a late answer into no answer.
  // …and WHO THIS PERSON WAS JUST TALKING TO. Nothing else in the prompt can supply it: a follow-up
  // question names no agent and often shares no words with the first one, and the recap of the turn
  // it follows may not even exist yet — the answer is still being written while the next question
  // is being asked.
  const decision = await routeVoiceTask(text, candidates, undefined, ROUTE_CLASSIFY_APP_MS, router.lastRouted())
  const named = (id: string) => candidates.find((agent) => agent.id === id)
  // The runners-up in the ROUTER's order when it gave one, and the list's own order when it did not.
  // A picker that has to ask "which agent" is showing a ranking either way; this decides whose.
  const ranking = (decision.scores ?? []).filter((score) => score.agentId !== decision.agentId)
  // EVERY AGENT THAT WAS WEIGHED, not the best two.
  //
  // The picker used to offer three rows — the pick and two runners-up — on the theory that a person
  // who has to be asked wants the shortlist. They do not: when the router is unsure the right agent
  // is often the one it ranked fourth, and a shortlist that cannot show it turns a question into a
  // dead end, with no way out but Esc and typing the task again somewhere else.
  //
  // Ranked first where the router said something, then everything else it looked at in rail order,
  // so the list stays the one the person is reading on screen. Nothing is dropped: the cap that
  // matters is ROUTE_MAX_CANDIDATES above, and `weighed` already says what it did.
  const rankedOthers = ranking
    .map((score) => named(score.agentId))
    .filter((agent): agent is RouterAgent => !!agent)
  const listed = new Set([decision.agentId, ...rankedOthers.map((agent) => agent.id)])
  const others = [...rankedOthers, ...candidates.filter((agent) => !listed.has(agent.id))]
  const fitOf = (id: string) => id === decision.agentId
    ? decision.confidence
    : ranking.find((score) => score.agentId === id)?.confidence ?? 0
  return {
    agentId: decision.agentId,
    machineId: all.find((entry) => entry.id === decision.agentId)?.machineId ?? '',
    name: named(decision.agentId)?.name ?? '',
    confidence: decision.confidence,
    reason: decision.reason,
    // How many agents were actually WEIGHED, and across how many computers. The window says this
    // while it waits, because the question a person has during those seconds is not "how long" —
    // it is "did it even look at the agent I mean". The cap above can hide agents, and until now
    // the only place that was said was this process's log.
    weighed: ranked.length,
    machines: new Set(ranked.map((agent) => agent.machine).filter(Boolean)).size,
    // 'model' or 'heuristic', coarsened from the router's own label. The two arrive at the same low
    // confidence BY DESIGN — an unsure model and a router that could not run must both stop and ask
    // — and that is exactly why the window has to be able to tell them apart when it explains itself.
    via: (decision.via ?? '').startsWith('heuristic') ? 'heuristic' : 'model',
    candidates: [decision.agentId ? named(decision.agentId) : null, ...others]
      .filter((agent): agent is RouterAgent => !!agent)
      .map((agent) => {
        const listed = all.find((entry) => entry.id === agent.id)
        return {
          agentId: agent.id,
          name: agent.name,
          // The machine travels twice, and both are needed: the NAME because two agents called "api"
          // on two computers are otherwise one row twice, and the ID because the window has to open
          // the pane on the machine the agent actually lives on.
          machineId: listed?.machineId ?? '',
          machine: agent.machine ?? '',
          engine: agent.engine ?? '',
          recent: (agent.recentSummary ?? '').slice(0, 120),
          // Drawn as a bar in the picker, never dispatched on. 0 = the router said nothing about
          // this one, which the window renders as no bar rather than as a zero-length one.
          confidence: fitOf(agent.id),
        }
      }),
  }
}
