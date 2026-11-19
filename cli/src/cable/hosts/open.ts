/**
 * A tap on an agent outside Harness brings it forward (docs/specs/2026-11-13-device-claude-orca.md): its own pane, where
 * its app has a way in that asks for no new permission, and on macOS the app itself, by its bundle id; on Linux its window,
 * through the raise (linuxRaise.ts, docs/plans/2026-11-19-dial-linux-design.md § 2.1). Here is only what every app
 * shares: each pane, and whether it comes before its app, instead of it or after it, is its adapter's (adapter.ts). Every
 * value of a tap came from a hook: a bundle is one of the apps below, a pane is checked by its adapter, and each command
 * runs with no shell, every value one argument. A pick in the dial's list of apps brings that app forward too
 * (docs/plans/2026-11-16-dial-pick-brings-app-design.md): the dial's word is only a key into the bundles below, or into
 * the raise's window classes.
 */
import { isAbsolute } from 'node:path'
import type { HostAdapter, Pane } from './adapter.js'
import { APP_BUNDLES, BUNDLE_APPS, HARNESS_BUNDLE, inCmux, inHerdr } from './hostDetect.js'
import type { LinuxRaise } from './linuxRaise.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'

/** Every app a tap brings forward. Alacritty is known by its bundle id alone: no other hint names it. Only one of these
 *  ever reaches `open`, never a hint's own value. */
const BUNDLES: ReadonlySet<string> = new Set([...Object.values(APP_BUNDLES), 'org.alacritty'])
/** `open`'s own path, so no `open` earlier on PATH runs instead. */
const OPEN = '/usr/bin/open'

/** The `open` every command of the devices runs: `bin`, the raw `HARNESS_OPEN_BIN` (read in services/devices.ts), when it
 *  is an absolute path, else `OPEN`. It is for the end-to-end tests, whose harness points it at a fake that records its
 *  arguments and opens nothing (e2e/harness/daemon.ts). A relative one is never looked up on PATH. */
export function openPath(bin?: string): string {
  return bin && isAbsolute(bin) ? bin : OPEN
}

/** What a tap can open of an agent: its app, by bundle id, and its own pane in it. */
export interface OpenTarget {
  bundle?: string
  pane?: Pane
}

/** The bundle a tap brings forward: the app the agent's own window belongs to wins over its host's. An hc terminal's is
 *  Herdr's window, whatever bundle id the process that started Herdr Core handed down to it; a cmux terminal's is cmux,
 *  though it may carry Ghostty's, which cmux is built on. */
export function bundleOf(host: string, hints: Readonly<Record<string, string>>): string | undefined {
  if (inHerdr(hints)) return APP_BUNDLES.herdr
  if (inCmux(hints)) return APP_BUNDLES.cmux
  const own = hints.__CFBundleIdentifier
  return own && BUNDLES.has(own) ? own : APP_BUNDLES[host]
}

export interface OpenDeps {
  run: OrcaDeps['run']
  platform: NodeJS.Platform
  /** The apps whose pane a tap brings forward: a pane of any other is none. */
  adapters: readonly HostAdapter[]
  log(line: string): void
  /** The raw `HARNESS_OPEN_BIN` (openPath). */
  bin?: string
  /** Herdr.app's window is herdr's ring's: the ring holds an agent in Herdr (hostDetect.ts inHerdr, or one the hc source
   *  lists). Asked at each pick. None: herdr's ring is herdr 0.8.0's alone. */
  herdrApp?(): boolean
  /** Linux's way to bring a window forward, where macOS runs `open -b`; none on macOS. */
  raise?: LinuxRaise
  /** An agent's window as the observed source knows it: its process and app (observed.ts windowOf). */
  windowOf?(agentId: string): { pid?: number; app?: string } | undefined
}

export function createOpenActions(deps: OpenDeps): {
  can(target: OpenTarget): boolean
  open(agentId: string, target: OpenTarget): Promise<boolean>
  /** Brings Harness Desktop forward, starting it when it is not running; there on macOS only. */
  desktop?: () => Promise<boolean>
  /** Brings a picked app forward by its id; undefined when nothing ran. There on macOS, and on Linux with a raise. */
  bring?: (app: string) => Promise<'ok' | 'failed' | undefined>
} {
  const mac = deps.platform === 'darwin'
  const raise = deps.raise
  // One command at a time per agent: a second tap while the first runs would only bring the same app forward twice.
  const running = new Set<string>()
  const openBin = openPath(deps.bin)
  // The last pick wins, so the front app ends matching the dial's ring (spec decision 4): one bring runs at a time for
  // any app, and a later one takes the single waiting place, answering the one it replaces at once.
  let bringing = false
  let waiting: { pick: () => Promise<boolean>; answer(outcome: Promise<'ok' | 'failed' | undefined> | undefined): void } | undefined
  const dropWaiting = (): void => {
    waiting?.answer(undefined)
    waiting = undefined
  }

  // The target's pane, when the opener holds its adapter, which brings it forward before or instead of its app and can
  // here (the Claude app's link is macOS's). One that comes after its app is the source's to raise once the app came
  // (observed.ts focus).
  const paneOn = (target: OpenTarget): { adapter: HostAdapter; pane: Pane } | undefined => {
    const pane = target.pane
    const adapter = pane && deps.adapters.find((known) => known.id === pane.adapter)
    return adapter && adapter.tap !== 'after' && adapter.canFocus(pane) ? { adapter, pane } : undefined
  }
  // On Linux the agent's window, by its process or its app's class: its app as its bundle names it (bundleOf), the only
  // word of it a target carries.
  const appOf = (bundle?: string): string | undefined => (bundle !== undefined && Object.hasOwn(BUNDLE_APPS, bundle) ? BUNDLE_APPS[bundle] : undefined)
  const can = (target: OpenTarget): boolean =>
    !!paneOn(target) || (mac && !!target.bundle) || !!raise?.ready({ agent: true, app: appOf(target.bundle) })
  const forward = async (bundle: string): Promise<boolean> => (await deps.run(openBin, ['-b', bundle], RUN_TIMEOUT_MS)).code === 0

  // herdr 0.8.0's agents, whose terminal nobody knows (#4366), have no window of their own: herdr's ring brings Herdr
  // only while Herdr.app's window is the ring's.
  const bundleFor = (app: string): string | undefined => {
    if (app === 'harness') return HARNESS_BUNDLE
    if (app === 'herdr') return deps.herdrApp?.() ? APP_BUNDLES.herdr : undefined
    return Object.hasOwn(APP_BUNDLES, app) ? APP_BUNDLES[app] : undefined
  }
  // On Linux a pick raises its app's window by the app's class, which only a desktop found and the app's own row give:
  // a pick has no process. With neither, nothing runs and nothing is logged (herdr, whose agents have no window of their
  // own there, has no class).
  const pickOf = (app: string): (() => Promise<boolean>) | undefined => {
    if (raise) return raise.ready({ agent: false, app }) ? () => raise.raise({ app }) : undefined
    const bundle = bundleFor(app)
    return bundle ? () => forward(bundle) : undefined
  }

  // Linux's raise brings forward the agent's window, where macOS brings its app: the window of [pid] when the pane's app
  // named the process holding it (a multiplexer's client its focus switched), else of the agent's own process.
  const raiseWindow = (linux: LinuxRaise, agentId: string, pid?: number): Promise<boolean> => {
    const window = deps.windowOf?.(agentId)
    return linux.raise({ pid: pid ?? window?.pid, app: window?.app })
  }

  async function bringNow(pick: () => Promise<boolean>): Promise<'ok' | 'failed'> {
    bringing = true
    try {
      return (await pick()) ? 'ok' : 'failed'
    } catch {
      return 'failed'
    } finally {
      bringing = false
      const next = waiting
      waiting = undefined
      // Failed or not, the last pick made meanwhile still runs.
      next?.answer(bringNow(next.pick))
    }
  }

  async function bring(app: string): Promise<'ok' | 'failed' | undefined> {
    const pick = pickOf(app)
    if (!bringing) return pick ? bringNow(pick) : undefined
    // A pick with nothing to bring is still the last pick: the one waiting would turn the dial away from it.
    dropWaiting()
    if (!pick) return undefined
    return new Promise((answer) => { waiting = { pick, answer } })
  }

  async function open(agentId: string, target: OpenTarget): Promise<boolean> {
    const own = paneOn(target)
    const bundle = mac ? target.bundle : undefined
    const shown = own ? await own.adapter.focus(own.pane) : false
    if (own && shown === true) {
      // A pane that comes before its app still needs its app at the front; one instead of it (the Claude app's link)
      // brought the app itself. The pane came, whatever the raise did.
      if (own.adapter.tap === 'before') {
        if (bundle) await forward(bundle)
        else if (raise) await raiseWindow(raise, agentId, own.adapter.windowPid?.(own.pane))
      }
      return true
    }
    const app = bundle ? () => forward(bundle) : raise && (() => raiseWindow(raise, agentId))
    if (!app) return false
    // The Claude app's link is undocumented and may change with any release: the app still comes forward. Which app
    // only, never its session, pane or handle. A pane refused has said so already.
    if (own && !shown) deps.log(`[device] open · ${own.adapter.id} · fallback`)
    return app()
  }

  return {
    can,
    async open(agentId, target) {
      // A tapped notice turns the dial to its own app: a pick waiting would turn it away again.
      dropWaiting()
      if (!can(target) || running.has(agentId)) return false
      running.add(agentId)
      try {
        return await open(agentId, target)
      } finally {
        running.delete(agentId)
      }
    },
    // A tap on a Harness agent with no window, which turns the dial to Harness's ring: it drops a pick waiting, as `open`.
    desktop: mac ? () => { dropWaiting(); return forward(HARNESS_BUNDLE) } : undefined,
    bring: mac || raise ? bring : undefined,
  }
}
