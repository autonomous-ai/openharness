/**
 * The agent browser: a sandboxed Chrome under Podman beside each agent whose Browser is on, set up by Harness when
 * Podman is missing (docs/superpowers/specs/2026-11-10-agent-browser-design.md). Its parts are in agentBrowser/; this
 * wires them to the core: the port the core tells an agent's start, stop and purge, and reads its frame's `browser`
 * through, and the requests the apps send.
 *
 * Only the agent's person turns its Browser on and off, from its chat (`agent_browser_start`, `_stop`;
 * docs/superpowers/specs/2026-11-11-browser-from-chat-design.md). Whose Browser is on is this service's own, kept in its
 * state file (`on`), and no part of the core: the browser starts and stops in the order the person asked, and comes back
 * with its agent while it is on. What happens to agents it hears as every service that follows agents does
 * (`CoreApi.agents.follow`): an agent here starts its browser if it is on, one that ended stops it and keeps its profile,
 * and one purged loses it. The agent learns of it from two lines typed into it (agentBrowser/notices.ts): when its
 * person's Start is ready, and at its person's Stop.
 *
 * The browser moves with its pane (decision 19): when a new agent takes the pane its previous agent ended in, the core
 * says so (`taken`). The entry, its profile and whether it is on go to the new agent in both agents' queues
 * (agentBrowser/browsers.ts `move`), and the new agent's browser starts on the same volume once it runs, and it is
 * typed the ready line. Every name in Podman comes from the entry's profile, so the stream and the tool server exec
 * into the container the profile names.
 *
 * Until 2026-11-15 the core kept whose Browser was on, as a flag on each agent's row. Each agent seen running with that
 * flag still set has it taken in here once (`adopted`), which migrates them all as their agents run, and keeps a
 * Desktop from before Browser left New agent working: its create still sets the flag. Delete that on or after
 * 2026-12-18, with the row's field (lib/registry.ts `browser`).
 *
 * The agent drives it with `harness browser <command>` from its own pane (`agent_browser_run`, from this computer only):
 * the core proves the pane and names its agent, and the command runs on that agent's tool server, which this service
 * holds while the browser is ready (agentBrowser/toolServers.ts), one at a time. A command never starts or stops a
 * browser, never wakes Podman, and never reads the backend. The person's panel sizes Chrome's window
 * through the same tool server (`agent_browser_window`).
 *
 * The settings are its person's before the first Start too: a proxy set then is the one the browser first connects
 * through, never the machine's own address.
 *
 * It looks at Podman only once it is used (an agent whose Browser is on, or a request), or at once when its state file
 * says it was used before: a computer whose person never started a browser never runs Podman for it.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { availableParallelism, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { AGENT_BROWSER_REQUESTS, mayOpenBrowser, type AgentLife, type Asker, type CoreApi, type CorePorts, type ServiceRequests } from '../core/api.js'
import { browserTools } from '../lib/browserToolsAsset.js'
import type { ProductUsageMetric } from '../lib/productUsageContract.js'
import { BROWSER_CHUNK_BYTES, encodeTerminalLocal } from '../lib/terminalBinary.js'
import type { RegisteredSession } from '../lib/registry.js'
import { resolveViaLoginShell } from '../lib/tmuxOnPath.js'
import { Browsers, type BrowserState } from './agentBrowser/browsers.js'
import { Containers } from './agentBrowser/containers.js'
import { watchEvents } from './agentBrowser/events.js'
import { exitZone, testProxy, type ExitLookupDeps } from './agentBrowser/exitLookup.js'
import { download, run, sha256 } from './agentBrowser/hostTools.js'
import { ensureImage } from './agentBrowser/image.js'
import { Notices } from './agentBrowser/notices.js'
import { createPodman, PodmanError, type Podman } from './agentBrowser/podman.js'
import { clampWindow, humanMode, parseSettings, publicSettings, type BrowserHost } from './agentBrowser/settings.js'
import { canAskForPassword, Setup } from './agentBrowser/setup.js'
import { StateFile } from './agentBrowser/stateFile.js'
import { BROWSER_PACING_BYTES_PER_SECOND, BROWSER_WINDOW, BrowserStreamManager } from './agentBrowser/streams.js'
import { ToolServers, type ToolChild, type ToolReply } from './agentBrowser/toolServers.js'

export { AGENT_BROWSER_REQUESTS } from '../core/api.js'

type SetupDeps = ConstructorParameters<typeof Setup>[0]
type Reply = Record<string, unknown>

const LOCAL_ONLY = { error: 'LOCAL_ONLY' }
const INVALID_REQUEST = { error: 'INVALID_REQUEST' }
/** What a Start is answered while this service does not know whether its agent runs: asked again, it is answered. */
const UNANSWERED = { error: 'SERVICE_UNAVAILABLE', service: 'agentBrowser', retryable: true }
/** Setup's own failures whose Retry installs Podman again (agentBrowser/setup.ts); no start fails with them. */
const SETUP_INSTALL_FAILURES = new Set(['podman_install_failed', 'podman_manual'])
/** What a viewer's bytes are piped through inside a browser's container: to Xvnc, which listens on the container's own
 *  loopback and publishes no port. */
const VNC_PIPE = ['socat', 'STDIO', 'TCP:127.0.0.1:5900']
// The tool server in the image (cli/assets/browser/browser-tools.mjs), one JSON-RPC message per line on its stdio.
const TOOL_SERVER = ['node', '/opt/harness-browser/browser-tools.mjs']
/** Answered by name on Windows, so Desktop says Browser does not run there rather than "update Harness" (spec § Desktop),
 *  and an agent's `harness browser` that asks anyway reads the same. */
const NAMED_ON_WINDOWS: ReadonlySet<string> = new Set(['agent_browser_start', 'agent_browser_stop', 'agent_browser_run', 'agent_browser_window'])

export interface AgentBrowserOptions {
  /** How the core hears a browser's state when this runs in a process of its own (services/agentBrowserProcess.ts);
   *  absent, the core is asked to send the agent's frame again, and reads the state through the port. */
  told?: (agentId: string, state: BrowserState | undefined) => void
  /** Whether what it follows of the agents is caught up: in its own process, the core's first answer since it connected
   *  (services/followLink.ts `ready`); in the core's, at once. */
  followed?: () => Promise<boolean>
  /** Every agent here, live and stopped, read now; null when the core did not answer. */
  everyAgent?: () => Promise<RegisteredSession[] | null>
  podman?: Podman
  platform?: NodeJS.Platform
  host?: BrowserHost
  /** What setup does on this computer, for a spec (agentBrowser/hostTools.ts by default). */
  setup?: Partial<Omit<SetupDeps, 'podman' | 'platform' | 'step'>>
  lookup?: ExitLookupDeps
  now?: () => Date
}

/** The daemon's id on Podman's labels: a dev or test daemon beside the installed one never touches another's. */
export function daemonIdOf(dataDir: string): string {
  return createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 16)
}

/** The machine's zone and language, read once: a browser's defaults (spec § Settings per agent). Under launchd the
 *  locale may be plain `en-US`; the person changes it in the settings. */
function machineHost(): BrowserHost {
  const { timeZone, locale } = Intl.DateTimeFormat().resolvedOptions()
  return { timeZone, languages: locale }
}

/** What a browser that is not ready is, as the agent reads it: `setup`, `starting`, or its failure's name. One that reads
 *  ready, or reads nothing, is coming back: its tool server ended with its container before Podman's event said so. */
function notReady(shown: BrowserState | undefined): Reply {
  return { error: 'NOT_READY', state: shown && shown.state !== 'ready' ? shown.error ?? shown.state : 'starting' }
}

/** A tool's answer as `harness browser` prints it: its words, its image, and whether the tool failed. */
function commandReply(reply: ToolReply): Reply {
  const text = reply.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n')
  const image = reply.content.find(part => part.type === 'image')
  return { ok: true, text, ...(image ? { image: image.data } : {}), ...(reply.isError ? { failed: true } : {}) }
}

/** A failure the apps can act on, named; anything else is the service's own and counts against it. */
function named(error: unknown): Reply {
  if (error instanceof PodmanError) return { error: error.state.toUpperCase() }
  if (error instanceof Error && error.message.startsWith('invalid browser setting')) return { error: 'INVALID_SETTINGS', detail: error.message }
  throw error
}

/**
 * Windows is not in v1 (spec § Later: Windows): WSL 2 could not be tested on any runner or VM we have. Nothing here
 * runs Podman, the port tells the core no agent has a browser, and every request says so.
 */
function unsupported(ports: Pick<CorePorts, 'agentBrowser'>): ServiceRequests {
  ports.agentBrowser = {
    frameContext: () => undefined,
    stream: () => false,
    streamInput: () => false,
    streamClosed: () => {},
    streamRoute: () => {},
    streamTransportError: () => {},
    streamRefused: () => {},
    stop: () => {},
  }
  return Object.fromEntries(AGENT_BROWSER_REQUESTS.map(type => [type, () => (type === 'agent_browser_available'
    ? { state: 'unsupported' }
    : { error: NAMED_ON_WINDOWS.has(type) ? 'NOT_ON_WINDOWS' : 'UNSUPPORTED' })]))
}

export function startAgentBrowser(core: CoreApi, ports: Pick<CorePorts, 'agentBrowser'>, options: AgentBrowserOptions = {}): ServiceRequests {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return unsupported(ports)
  const podman = options.podman ?? createPodman()
  const now = options.now ?? (() => new Date())
  const log = (line: string) => console.log(line)
  const count = (name: string) => core.count?.(name as ProductUsageMetric)
  const daemonId = daemonIdOf(core.dataDir)
  const statePath = join(core.dataDir, 'agent-browser.json')
  const state = new StateFile(statePath)

  const containers = new Containers(podman, daemonId, log)
  const notices = new Notices({ state, turns: core.turns, measure: count, log })
  // podman.spawn pipes all three: the child's stdin and stdout are there. Only a ready browser's is started, and a
  // ready browser has an entry, so a profile; a state file that cannot be read is a tool server that cannot start.
  const toolServers = new ToolServers({ spawn: agentId => podman.spawn(containers.execArgs(browsers.profile(agentId)!, TOOL_SERVER)) as ToolChild, log })
  /** The commands an agent may run: the tools of `browser-tools.json`, by the name `harness browser` gives them. */
  const tools: ReadonlySet<string> = new Set(browserTools().tools.map(tool => tool.name))
  const followed = options.followed ?? (async () => true)
  const everyAgent = options.everyAgent ?? (async () => core.agents.all())
  // Built after setup, which tells it each step.
  let browsers: Browsers
  /**
   * The viewers' streams of this machine's browsers (agentBrowser/streams.ts). Each is this service's own exec into a
   * ready browser's container; its answers and the screen's bytes go to the core, which holds each to the connection
   * that opened the stream (core/browserStreams.ts). Until the audit of 2026-11-12 the core ran these itself.
   */
  const streams = new BrowserStreamManager({
    exec: (agentId) => {
      const shown = browsers.state(agentId)
      if (!shown) return { error: 'NO_BROWSER' }
      if (shown.state !== 'ready') return { error: 'NOT_READY' }
      // A ready browser has an entry, so a profile; one whose state file cannot be read now has no stream to open.
      let profile: string
      try { profile = browsers.profile(agentId)! } catch { return { error: 'NOT_READY' } }
      // Ready means Podman was found: it started this container. Xvnc listens on 5900 inside the container only (no
      // published port), so a viewer's bytes reach it through this exec.
      return { spawn: () => podman.spawn(containers.execArgs(profile, VNC_PIPE)) }
    },
    sendTarget: (connId, type, payload) => core.clients.browserFrame?.(connId, type, payload) ?? false,
    // Framed once, here, as a window is sent it: the core sends it on as it is, to the connection it holds the stream
    // for, whichever this names.
    sendBinaryTarget: (_connId, frame) => {
      const encoded = encodeTerminalLocal(frame)
      return !!encoded && (core.clients.browserBytes?.(encoded) ?? false)
    },
    measure: count,
    pacing: { bytesPerSecond: BROWSER_PACING_BYTES_PER_SECOND },
    window: BROWSER_WINDOW,
    chunkBytes: BROWSER_CHUNK_BYTES,
  })
  const setup = new Setup({
    podman, platform, arch: process.arch,
    download, sha256, run, which: resolveViaLoginShell, interactive: canAskForPassword,
    hostMemoryBytes: totalmem(), hostCpus: availableParallelism(),
    ...options.setup,
    step: step => browsers.setupStep(step),
  })
  browsers = new Browsers({
    podman, setup, state, log,
    containers,
    image: () => ensureImage(podman, now(), log),
    host: options.host ?? machineHost(),
    exitZone: proxy => exitZone(proxy, options.lookup),
    changed: (agentId) => {
      const shown = browsers.state(agentId)
      // A browser that leaves ready takes its tool server with it: what runs or waits is answered the state now.
      if (shown?.state !== 'ready') toolServers.end(agentId, 'ENDED')
      if (shown?.state === 'ready') notices.ready(agentId)
      if (options.told) return options.told(agentId, shown)
      const session = core.agents.byAgent(agentId)
      if (session) core.agents.sync(session)
    },
    closeViewers: agentId => streams.closeAgent(agentId),
    measure: count,
    podmanAnswered: () => events?.wake(),
  })

  /** The live agents, as the core told of them (`CoreApi.agents.follow`): each with its row as it began to run here. */
  const live = new Map<string, RegisteredSession>()
  /** The agents whose browser this service started and has not stopped since. */
  const attached = new Set<string>()
  /** Whether the state file lists the agent; null when the file cannot be read. */
  const listed = (agentId: string): boolean | null => {
    try { return Object.hasOwn(state.read().browsers, agentId) } catch { return null }
  }
  const hasBrowser = (agentId: string) => attached.has(agentId) || listed(agentId) === true
  /** Whether the agent's Browser is on: its person's Start, until their Stop. A state file that cannot be read has none
   *  on, and every browser that tries to start says so. */
  const isOn = (agentId: string): boolean => {
    try { return state.read().on?.[agentId] === true } catch { return false }
  }
  /** Turn the agent's Browser on or off in the state file: whether that changed it. Rejects when the file cannot be
   *  written, with nothing changed. */
  const setOn = (agentId: string, on: boolean): boolean => {
    let changed = false
    state.update(s => {
      changed = (s.on?.[agentId] === true) !== on
      if (on) s.on = { ...s.on, [agentId]: true }
      else if (s.on) delete s.on[agentId]
    })
    return changed
  }
  /** The flag the core kept on the agent's row until 2026-11-15, taken in once for each agent: its person's Start, or an
   *  older Desktop's create. A person's Stop after it is never undone by the row, which keeps the flag as it was.
   *  Delete on or after 2026-12-18, with the row's field (lib/registry.ts `browser`). */
  const adopt = (session: RegisteredSession): void => {
    if (session.browser !== true) return
    try {
      state.update(s => {
        if (s.adopted?.[session.agentId]) return
        s.adopted = { ...s.adopted, [session.agentId]: true }
        s.on = { ...s.on, [session.agentId]: true }
      })
    } catch (error) {
      // The next time it runs, it is taken in then.
      log(`agent browser ${session.agentId}: its Browser flag was not taken in: ${(error as Error).message}`)
    }
  }
  /** Its browser, started: once each time it runs here, and not for a guest's (the machine's Podman, memory and network
   *  are its owner's). */
  const startFor = (session: RegisteredSession): void => {
    if (session.guest || attached.has(session.agentId) || !isOn(session.agentId)) return
    begin()
    attached.add(session.agentId)
    void browsers.start(session.agentId)
  }

  /**
   * [to] took the pane [from] ended in (decision 19). A move that fails is said once, by its name only: the state file
   * could not be read or written, and both agents are as they were. [to]'s browser starts once it runs, if [from]'s
   * was on: at once when it already does.
   */
  const move = async (from: string, to: string): Promise<void> => {
    let moved: boolean
    try {
      moved = await browsers.move(from, to)
    } catch (error) {
      return log(`agent browser ${to}: browser_move_failed (${error instanceof PodmanError ? error.state : 'state_unwritable'})`)
    }
    const session = live.get(to)
    if (moved && session) startFor(session)
  }

  /** What happens to agents, as every service that follows them hears it. */
  const heard = (event: AgentLife): void => {
    if (event.kind === 'running') {
      live.set(event.session.agentId, event.session)
      adopt(event.session)
      startFor(event.session)
    } else if (event.kind === 'ended') {
      live.delete(event.agentId)
      // Its own end takes back what waits for it; its profile stays, so the login survives a resume.
      notices.ended(event.agentId)
      if (attached.delete(event.agentId) || browsers.state(event.agentId)) void browsers.stop(event.agentId)
    } else if (event.kind === 'purged') {
      live.delete(event.agentId)
      notices.ended(event.agentId)
      attached.delete(event.agentId)
      if (hasBrowser(event.agentId)) void browsers.delete(event.agentId)
      else forget(event.agentId)
    } else if (event.kind === 'taken') {
      // The agent that ended is typed nothing more, and keeps no browser. A guest's agent gets nothing of the owner's,
      // and one whose Browser is on keeps its own. A move never begins Podman's watch: with no state file there is no
      // entry, and it ends at one read.
      notices.ended(event.from)
      attached.delete(event.from)
      if (!event.guest && !isOn(event.to)) void move(event.from, event.to)
    }
  }
  /** A purged agent with no entry may still have been turned on, or taken in: nothing of it stays. */
  const forget = (agentId: string): void => {
    try {
      state.update(s => {
        if (s.on) delete s.on[agentId]
        if (s.adopted) delete s.adopted[agentId]
      })
    } catch { /* an unreadable file holds nothing to forget */ }
  }

  let begun = false
  let stopped = false
  let events: { close(): void; wake(): void } | null = null
  /** The first use: one event stream for this daemon's exits, and the clean-up after whatever happened while it was down. */
  const begin = () => {
    if (begun) return
    begun = true
    // Once looked for: a stream started before Podman's path is known fails and waits its backoff.
    void podman.path().catch(() => null).then(() => {
      if (stopped) return
      events = watchEvents(podman, daemonId, { exited: agentId => browsers.exited(agentId), reconnected: () => void browsers.reconcile(), log })
    })
    void (async () => {
      // Only an answer deletes: none, or a failed one, must never cost a person a login.
      const every = await everyAgent().catch(() => null)
      await browsers.resume(every ? new Set(every.map(session => session.agentId)) : null)
      // A browser left running for an agent that is not here, or not on: its agent ended while this service could not
      // hear it (its process and the core both restarted). Only once what it follows is caught up.
      if (await followed()) await browsers.stopAllBut(agentId => attached.has(agentId) || (live.has(agentId) && isOn(agentId)))
    })()
  }
  if (existsSync(statePath)) begin()
  // What happens to agents: told at once every live agent, then each change (in its own process, once it connects).
  const unfollow = core.agents.follow?.(heard)

  ports.agentBrowser = {
    frameContext: agentId => browsers.state(agentId),
    // A viewer's stream (agentBrowser/streams.ts). Who may open one is the core's word, with whether it is a window here.
    stream(connId, type, payload, asker) {
      // An open without who asked is no open: never a browser on a guess.
      if (type === 'agent_browser_open' && asker) streams.open(connId, payload, { allowed: mayOpenBrowser(asker), local: asker.local })
      else if (type === 'agent_browser_ack') streams.ack(connId, payload)
      else if (type === 'agent_browser_close') streams.close(connId, payload)
      else return false
      return true
    },
    // Taken, as the stream's own process: one that ended meanwhile hears its close come back.
    streamInput: (streamId, bytes) => { streams.input(streamId, bytes); return true },
    streamClosed: connId => streams.closeConnection(connId),
    streamRoute: (streamId, route) => (route ? streams.route(streamId, route) : streams.routeLost(streamId)),
    streamTransportError: () => streams.transportError(),
    streamRefused: streamId => streams.refused(streamId),
    stop() {
      stopped = true
      unfollow?.()
      events?.close()
      notices.close()
      toolServers.endAll()
      // Each viewer's exec ends with the service, and its panel is told: switched off in the core's process, nothing
      // else would end them.
      streams.closeAll()
    },
  }

  const idOf = (payload: Reply) => (typeof payload.agentId === 'string' ? payload.agentId : '')

  /**
   * A request for one agent's browser from its own person: the agent's id, or why not. `anyAgent`: an agent of this
   * machine, live or stopped, whether or not its browser is on, as the settings are; else only a browser it has.
   */
  const ownBrowser = (handler: (agentId: string, payload: Reply, asker: Asker) => Reply | Promise<Reply>, anyAgent = false) => async (payload: Reply, asker: Asker): Promise<Reply> => {
    if (!mayOpenBrowser(asker)) return { error: 'NOT_OWNER' }
    begin()
    const agentId = idOf(payload)
    if (!agentId || !(browsers.state(agentId) || (anyAgent && await isHere(agentId)))) return { error: 'NO_BROWSER' }
    try { return await handler(agentId, payload, asker) } catch (error) { return named(error) }
  }
  /** Whether the core has the agent, live or stopped; a core that cannot say has none. */
  const isHere = async (agentId: string): Promise<boolean> => {
    const every = await everyAgent().catch(() => null)
    return !!every && every.some(session => session.agentId === agentId)
  }

  /** The agent of the pane a command runs in, and whether it is a guest's; null for a pane with no parents to hold it to. */
  const paneAgent = async (payload: Reply) => {
    const pane = typeof payload.pane === 'string' ? payload.pane : ''
    const ancestors = Array.isArray(payload.ancestors) ? payload.ancestors.filter((pid): pid is number => typeof pid === 'number') : null
    if (!pane || !ancestors || !core.agents.ofPane) return null
    return core.agents.ofPane(pane, ancestors).catch(() => null)
  }

  /** Retry, and the person's Start of a failed browser: it starts again from the agent's queue. */
  const retry = (agentId: string, asker: Asker): Reply => {
    // These come from setup alone, and their Retry runs the install again: its password dialog shows on this
    // computer, so, as Install, only this computer may ask (spec § Setup).
    if (!asker.local && SETUP_INSTALL_FAILURES.has(browsers.state(agentId)?.error ?? '')) return LOCAL_ONLY
    void browsers.retry(agentId)
    return { ok: true }
  }

  return {
    agent_browser_available: async () => {
      begin()
      try {
        return await podman.available()
      } catch (error) {
        // Installed and not answering: the form goes on, and the browser's panel names it.
        if (error instanceof PodmanError) return { state: error.state }
        throw error
      }
    },
    agent_browser_setup: (_payload, asker) => {
      if (!asker.local) return LOCAL_ONLY
      begin()
      void browsers.setUp()
      return { ok: true }
    },
    // The relay of an agent launched with the browser's MCP argument asks this for every call, and runs the code it
    // started with until its agent restarts. Delete on or after 2026-12-18: 30 days after the CLI release that took the
    // argument away (assumed by 2026-11-18; whoever releases later moves the date).
    agent_browser_state: async (payload, asker) => {
      if (!asker.local) return LOCAL_ONLY
      begin()
      const pane = typeof payload.pane === 'string' ? payload.pane : ''
      const agentId = pane && core.agents.ofPane ? (await core.agents.ofPane(pane).catch(() => null))?.agentId : undefined
      const shown = agentId ? browsers.state(agentId) : undefined
      if (!agentId || !shown) return { error: 'NO_BROWSER' }
      // The connection, when Harness runs its own machine: the relay's exec must reach the machine the browser is on.
      const connection = podman.connection()
      try {
        return { agentId, state: shown.state, ...(shown.error ? { error: shown.error } : {}), podman: (await podman.path()) ?? '', ...(connection ? { connection } : {}), human: humanMode(browsers.settings(agentId)) }
      } catch (error) {
        return named(error)
      }
    },
    agent_browser_retry: ownBrowser((agentId, _payload, asker) => retry(agentId, asker)),
    // Turned on here, where whose Browser is on is kept, and started once its agent runs: at once for one that does. Only a
    // live agent that is not a guest's: the machine's Podman, memory and network are its owner's.
    agent_browser_start: async (payload, asker) => {
      if (!mayOpenBrowser(asker)) return { error: 'NOT_OWNER' }
      const agentId = idOf(payload)
      const shown = browsers.state(agentId)
      if (shown) return shown.state === 'failed' ? retry(agentId, asker) : { ok: true }
      // Not caught up with the core (it has not answered since this process connected) is not knowing whether the agent
      // runs: never read as an agent that does not.
      if (!await followed()) return UNANSWERED
      const session = live.get(agentId)
      if (!session) return { error: 'NOT_RUNNING' }
      if (session.guest) return { error: 'NOT_ALLOWED' }
      // Once per agent: its settings are in the state file from its first start on.
      const first = listed(agentId) === false
      let changed: boolean
      try { changed = setOn(agentId, true) } catch (error) { return named(error) }
      if (first) count('agent_browser_enabled')
      if (changed) count('agent_browser_started')
      startFor(session)
      return { ok: true }
    },
    // The volume and the settings stay: the login is there at the next Start.
    agent_browser_stop: async (payload, asker) => {
      if (!mayOpenBrowser(asker)) return { error: 'NOT_OWNER' }
      const agentId = idOf(payload)
      // Every command running or waiting is answered the stop line: the agent has read it, and is typed nothing.
      if (attached.has(agentId)) notices.stopped(agentId, toolServers.end(agentId, 'STOPPED') > 0)
      // Off even when it was never on: a Stop of a browser that is off, or of an agent gone since, is done already. One the
      // state file does not take still stops the browser, and starts it again at its agent's next run: said here.
      let changed = false
      try { changed = setOn(agentId, false) } catch (error) {
        log(`agent browser ${agentId}: its Stop was not kept: ${(error as Error).message}`)
      }
      if (attached.delete(agentId) || browsers.state(agentId)) void browsers.stop(agentId)
      if (changed) count('agent_browser_stopped')
      return { ok: true }
    },
    // One of the agent's commands, on its own browser and nothing else's. It never wakes Podman: a browser that is not
    // ready says what it is, and the agent asks its person.
    agent_browser_run: async (payload, asker, closed) => {
      if (!asker.local) return LOCAL_ONLY
      const agent = await paneAgent(payload)
      if (!agent) return { error: 'NO_AGENT' }
      // The machine's Podman, memory and network are its owner's.
      if (agent.guest) return { error: 'NOT_ALLOWED' }
      const command = typeof payload.command === 'string' ? payload.command : ''
      const args = payload.args
      if (!tools.has(`browser_${command}`) || typeof args !== 'object' || args === null || Array.isArray(args)) return INVALID_REQUEST
      const { agentId } = agent
      const shown = browsers.state(agentId)
      if (!shown) return { error: 'OFF' }
      if (shown.state !== 'ready') return notReady(shown)
      const result = await toolServers.call(agentId, `browser_${command}`, args as Reply, humanMode(browsers.settings(agentId)), closed)
      const answer = 'reply' in result ? commandReply(result.reply) : result.error === 'ENDED' ? notReady(browsers.state(agentId)) : { error: result.error }
      const done = answer.ok === true && answer.failed !== true
      count(done ? 'agent_browser_command_ok' : 'agent_browser_command_failed')
      // Its name and outcome only: its arguments and the page's words are the person's.
      log(`agent browser ${agentId}: ${command} ${done ? 'ok' : answer.ok ? 'failed' : String(answer.error).toLowerCase()}`)
      return answer
    },
    // The panel's size, on Chrome's window: not stored, as Chrome keeps the window's last size in its profile.
    agent_browser_window: async (payload, asker) => {
      if (!mayOpenBrowser(asker)) return { error: 'NOT_OWNER' }
      const agentId = idOf(payload)
      const shown = browsers.state(agentId)
      if (!shown) return { error: 'NO_BROWSER' }
      if (shown.state !== 'ready') return { error: 'NOT_READY' }
      const size = clampWindow(payload.width, payload.height, browsers.settings(agentId).screen)
      if (!size) return INVALID_REQUEST
      const set = await toolServers.window(agentId, size.width, size.height)
      // The panel keeps scaling the whole screen, and asks again at its next resize.
      if ('error' in set) log(`agent browser ${agentId}: window_failed`)
      return set
    },
    agent_browser_settings: ownBrowser(agentId => publicSettings(browsers.settings(agentId)), true),
    agent_browser_settings_save: ownBrowser(async (agentId, payload) => {
      const before = browsers.settings(agentId)
      const next = parseSettings(payload.settings, before)
      await browsers.saveSettings(agentId, next)
      if (next.proxy && JSON.stringify(next.proxy) !== JSON.stringify(before.proxy)) count('agent_browser_proxy_set')
      else if (!next.proxy && before.proxy) count('agent_browser_proxy_removed')
      return publicSettings(browsers.settings(agentId))
    }, true),
    // A proxy sent without its password is tested with the stored one only when it is the stored proxy, as a save keeps it.
    agent_browser_proxy_test: ownBrowser(async (agentId, payload) => {
      const current = browsers.settings(agentId)
      const proxy = parseSettings({ ...current, proxy: payload.proxy }, current).proxy
      if (!proxy) return { error: 'INVALID_SETTINGS', detail: 'invalid browser setting: proxy' }
      const answer = await testProxy(proxy, options.lookup)
      count(answer.ok ? 'agent_browser_proxy_test_ok' : 'agent_browser_proxy_test_failed')
      return answer
    }, true),
  }
}
