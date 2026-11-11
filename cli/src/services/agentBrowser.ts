/**
 * The agent browser: a sandboxed Chrome under Podman beside each agent whose Browser is on, set up by Harness when
 * Podman is missing (docs/superpowers/specs/2026-11-10-agent-browser-design.md). Its parts are in agentBrowser/; this
 * wires them to the core: the port the core tells an agent's start, stop and purge, and reads its frame's `browser`
 * through, and the requests the apps send.
 *
 * Only the agent's person turns its Browser on and off, from its chat (`agent_browser_start`, `_stop`;
 * docs/superpowers/specs/2026-11-11-browser-from-chat-design.md). The core sets the agent's flag and tells this port
 * `attached` or `stopped` in the same turn (`CoreApi.agents.setBrowser`), so the browser starts and stops in the order
 * the person asked, and comes back with its agent while the flag is on. The agent learns of it from two lines typed
 * into it (agentBrowser/notices.ts): when its person's Start is ready, and at its person's Stop.
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
import { AGENT_BROWSER_REQUESTS, mayOpenBrowser, type Asker, type CoreApi, type CorePorts, type ServiceRequests } from '../core/api.js'
import type { ProductUsageMetric } from '../lib/productUsageContract.js'
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
import { humanMode, parseSettings, publicSettings, type BrowserHost } from './agentBrowser/settings.js'
import { canAskForPassword, Setup } from './agentBrowser/setup.js'
import { StateFile } from './agentBrowser/stateFile.js'

export { AGENT_BROWSER_REQUESTS } from '../core/api.js'

type SetupDeps = ConstructorParameters<typeof Setup>[0]
type Reply = Record<string, unknown>

const LOCAL_ONLY = { error: 'LOCAL_ONLY' }
/** Setup's own failures whose Retry installs Podman again (agentBrowser/setup.ts); no start fails with them. */
const SETUP_INSTALL_FAILURES = new Set(['podman_install_failed', 'podman_manual'])
// Xvnc listens on 5900 inside the container only (no published port): a viewer's bytes reach it through an exec.
const VNC_PIPE = ['socat', 'STDIO', 'TCP:127.0.0.1:5900']
/** Answered by name on Windows, so Desktop says Browser does not run there rather than "update Harness" (spec § Desktop). */
const NAMED_ON_WINDOWS: ReadonlySet<string> = new Set(['agent_browser_start', 'agent_browser_stop'])

export interface AgentBrowserOptions {
  /** How the core hears a browser's state when this runs in a process of its own (services/agentBrowserProcess.ts);
   *  absent, the core is asked to send the agent's frame again, and reads the state through the port. */
  told?: (agentId: string, state: BrowserState | undefined) => void
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
    attached: () => {},
    stopped: () => {},
    deleted: () => {},
    frameContext: () => undefined,
    streamCommand: () => ({ error: 'NO_BROWSER' }),
    onCloseViewers: () => {},
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
  /**
   * The agents whose person's Stop is under way: marked before the core is asked, so the port's `stopped` that follows
   * is told apart from the agent's own end, and a browser that turns ready meanwhile is owed nothing.
   */
  const byPerson = new Set<string>()
  /** The core's streams to this machine's browsers (core/browserStreams.ts), told when one stops or goes. */
  const viewerListeners: Array<(agentId: string) => void> = []
  // Built after setup, which tells it each step.
  let browsers: Browsers
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
      if (shown?.state === 'ready' && !byPerson.has(agentId)) notices.ready(agentId)
      if (options.told) return options.told(agentId, shown)
      const session = core.agents.byAgent(agentId)
      if (session) core.agents.sync(session)
    },
    closeViewers: agentId => { for (const listener of viewerListeners) listener(agentId) },
    measure: count,
    podmanAnswered: () => events?.wake(),
  })

  /** The agents attached since this service started: attached is said on every look at an agent. */
  const attached = new Set<string>()
  /** Whether the state file lists the agent; null when the file cannot be read. */
  const listed = (agentId: string): boolean | null => {
    try { return Object.hasOwn(state.read().browsers, agentId) } catch { return null }
  }
  const hasBrowser = (agentId: string) => attached.has(agentId) || listed(agentId) === true

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
      const ids = core.agents.ids ? await core.agents.ids().catch(() => null) : null
      await browsers.resume(ids ? new Set([...ids.live, ...ids.stopped]) : null)
    })()
  }
  if (existsSync(statePath)) begin()

  ports.agentBrowser = {
    attached(session: RegisteredSession) {
      if (!session.browser || attached.has(session.agentId)) return
      begin()
      attached.add(session.agentId)
      // Once per agent: its settings are in the state file from its first start on.
      if (listed(session.agentId) === false) count('agent_browser_enabled')
      void browsers.start(session.agentId)
    },
    stopped(agentId) {
      // The person's Stop told the agent already; its own end takes back what waits for it.
      if (!byPerson.delete(agentId)) notices.ended(agentId)
      if (!hasBrowser(agentId)) return
      attached.delete(agentId)
      void browsers.stop(agentId)
    },
    deleted(agentId) {
      notices.ended(agentId)
      if (!hasBrowser(agentId)) return
      attached.delete(agentId)
      void browsers.delete(agentId)
    },
    frameContext: agentId => browsers.state(agentId),
    streamCommand(agentId) {
      const shown = browsers.state(agentId)
      if (!shown) return { error: 'NO_BROWSER' }
      if (shown.state !== 'ready') return { error: 'NOT_READY' }
      // Ready means Podman was found: it started this container.
      return { argv: podman.argv(containers.execArgs(agentId, VNC_PIPE)) }
    },
    onCloseViewers: listener => { viewerListeners.push(listener) },
    stop() {
      stopped = true
      events?.close()
      notices.close()
    },
  }

  const idOf = (payload: Reply) => (typeof payload.agentId === 'string' ? payload.agentId : '')
  /** The person's Start and Stop go through the core, which owns the agent's flag (`CoreApi.agents.setBrowser`). */
  const setBrowser = (agentId: string, on: boolean) => core.agents.setBrowser!(agentId, on)

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
    const ids = await core.agents.ids?.().catch(() => null)
    return !!ids && (ids.live.includes(agentId) || ids.stopped.includes(agentId))
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
      const agentId = pane && core.agents.ofPane ? await core.agents.ofPane(pane).catch(() => null) : null
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
    // The browser itself starts through the port's `attached`, which the core calls as it sets the flag. A browser its
    // person is stopping is asked of the core all the same: the core switches in the order it is asked, so it starts
    // again after that stop.
    agent_browser_start: async (payload, asker) => {
      if (!mayOpenBrowser(asker)) return { error: 'NOT_OWNER' }
      const agentId = idOf(payload)
      const shown = byPerson.has(agentId) ? undefined : browsers.state(agentId)
      if (shown) return shown.state === 'failed' ? retry(agentId, asker) : { ok: true }
      const answer = await setBrowser(agentId, true)
      if ('error' in answer) return answer
      if (answer.changed) count('agent_browser_started')
      return { ok: true }
    },
    // The volume and the settings stay: the login is there at the next Start.
    agent_browser_stop: async (payload, asker) => {
      if (!mayOpenBrowser(asker)) return { error: 'NOT_OWNER' }
      const agentId = idOf(payload)
      if (attached.has(agentId)) {
        byPerson.add(agentId)
        notices.stopped(agentId, false)
      }
      const answer = await setBrowser(agentId, false)
      // The core told the port nothing to stop: nothing stays marked, and the agent's own end is heard as its own.
      byPerson.delete(agentId)
      if ('changed' in answer && answer.changed) count('agent_browser_stopped')
      return { ok: true }
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
