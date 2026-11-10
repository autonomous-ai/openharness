/**
 * The agent browser: a sandboxed Chrome under Podman beside each agent created with Browser, set up by Harness when
 * Podman is missing (docs/superpowers/specs/2026-11-10-agent-browser-design.md). Its parts are in agentBrowser/; this
 * wires them to the core: the port the core tells an agent's start, stop and purge, and reads its frame's `browser`
 * through, and the requests the apps send.
 *
 * It looks at Podman only once it is used (an agent with Browser, or a request), or at once when its state file says
 * it was used before: a computer that never ticked Browser never runs Podman for it.
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
import { createPodman, PodmanError, type Podman } from './agentBrowser/podman.js'
import { humanMode, parseSettings, publicSettings, type BrowserHost } from './agentBrowser/settings.js'
import { canAskForPassword, Setup } from './agentBrowser/setup.js'
import { StateFile } from './agentBrowser/stateFile.js'

export { AGENT_BROWSER_REQUESTS } from '../core/api.js'

type SetupDeps = ConstructorParameters<typeof Setup>[0]
type Reply = Record<string, unknown>

const LOCAL_ONLY = { error: 'LOCAL_ONLY' }
// Xvnc listens on 5900 inside the container only (no published port): a viewer's bytes reach it through an exec.
const VNC_PIPE = ['socat', 'STDIO', 'TCP:127.0.0.1:5900']

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
  return Object.fromEntries(AGENT_BROWSER_REQUESTS.map(type =>
    [type, () => (type === 'agent_browser_available' ? { state: 'unsupported' } : { error: 'UNSUPPORTED' })]))
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
      if (options.told) return options.told(agentId, browsers.state(agentId))
      const session = core.agents.byAgent(agentId)
      if (session) core.agents.sync(session)
    },
    closeViewers: agentId => { for (const listener of viewerListeners) listener(agentId) },
    measure: count,
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
  let events: { close(): void } | null = null
  /** The first use: one event stream for this daemon's exits, and the clean-up after whatever happened while it was down. */
  const begin = () => {
    if (begun) return
    begun = true
    // Once looked for: a stream started before Podman's path is known fails and waits its backoff.
    void podman.path().catch(() => null).then(() => {
      if (stopped) return
      events = watchEvents(podman, daemonId, { exited: agentId => browsers.exited(agentId), reconnected: () => void browsers.reconcile() })
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
      if (!hasBrowser(agentId)) return
      attached.delete(agentId)
      void browsers.stop(agentId)
    },
    deleted(agentId) {
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
    },
  }

  /** A request for one agent's browser from its own person: the agent's id, or why not. */
  const ownBrowser = (handler: (agentId: string, payload: Reply) => Reply | Promise<Reply>) => async (payload: Reply, asker: Asker): Promise<Reply> => {
    if (!mayOpenBrowser(asker)) return { error: 'NOT_OWNER' }
    begin()
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
    if (!agentId || !browsers.state(agentId)) return { error: 'NO_BROWSER' }
    try { return await handler(agentId, payload) } catch (error) { return named(error) }
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
    agent_browser_state: async (payload, asker) => {
      if (!asker.local) return LOCAL_ONLY
      begin()
      const pane = typeof payload.pane === 'string' ? payload.pane : ''
      const agentId = pane && core.agents.ofPane ? await core.agents.ofPane(pane).catch(() => null) : null
      const shown = agentId ? browsers.state(agentId) : undefined
      if (!agentId || !shown) return { error: 'NO_BROWSER' }
      try {
        return { agentId, state: shown.state, ...(shown.error ? { error: shown.error } : {}), podman: (await podman.path()) ?? '', human: humanMode(browsers.settings(agentId)) }
      } catch (error) {
        return named(error)
      }
    },
    agent_browser_retry: ownBrowser((agentId) => {
      void browsers.retry(agentId)
      return { ok: true }
    }),
    agent_browser_settings: ownBrowser(agentId => publicSettings(browsers.settings(agentId))),
    agent_browser_settings_save: ownBrowser(async (agentId, payload) => {
      const before = browsers.settings(agentId)
      const next = parseSettings(payload.settings, before)
      await browsers.saveSettings(agentId, next)
      if (next.proxy && JSON.stringify(next.proxy) !== JSON.stringify(before.proxy)) count('agent_browser_proxy_set')
      else if (!next.proxy && before.proxy) count('agent_browser_proxy_removed')
      return publicSettings(browsers.settings(agentId))
    }),
    // A proxy sent without its password is tested with the stored one, as a save keeps it.
    agent_browser_proxy_test: ownBrowser(async (agentId, payload) => {
      const current = browsers.settings(agentId)
      const proxy = parseSettings({ ...current, proxy: payload.proxy }, current).proxy
      if (!proxy) return { error: 'INVALID_SETTINGS', detail: 'invalid browser setting: proxy' }
      const answer = await testProxy(proxy, options.lookup)
      count(answer.ok ? 'agent_browser_proxy_test_ok' : 'agent_browser_proxy_test_failed')
      return answer
    }),
  }
}
