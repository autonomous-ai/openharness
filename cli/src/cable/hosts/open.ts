/**
 * A tap on an agent outside Harness brings it forward (docs/specs/2026-11-13-device-claude-orca.md): its own pane, where
 * its app has a way in that asks for no new permission, and on macOS the app itself, by its bundle id. Here is only what
 * every app shares: each pane, and whether it comes before its app, instead of it or after it, is its adapter's
 * (adapter.ts). Every value came from a hook: a bundle is one of the apps below, a pane is checked by its adapter, and
 * each command runs with no shell, every value one argument.
 */
import { isAbsolute } from 'node:path'
import type { HostAdapter, Pane } from './adapter.js'
import { APP_BUNDLES, HARNESS_BUNDLE } from './hostDetect.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'

/** Every app a tap brings forward. Alacritty is known by its bundle id alone: no other hint names it. Only one of these
 *  ever reaches `open`, never a hint's own value. */
const BUNDLES: ReadonlySet<string> = new Set([...Object.values(APP_BUNDLES), 'org.alacritty'])
/** `open`'s own path, so no `open` earlier on PATH runs instead. `HARNESS_OPEN_BIN` (read in services/devices.ts, handed
 *  here as `bin`) is for the end-to-end tests, whose harness points it at a fake that records its arguments and opens
 *  nothing (e2e/harness/daemon.ts). Only an absolute path is taken, so a relative one is never looked up on PATH. */
export const OPEN = '/usr/bin/open'

/** What a tap can open of an agent: its app, by bundle id, and its own pane in it. */
export interface OpenTarget {
  bundle?: string
  pane?: Pane
}

/** The bundle a tap brings forward: the app the agent's own window belongs to wins over its host's. */
export function bundleOf(host: string, hints: Readonly<Record<string, string>>): string | undefined {
  const own = hints.__CFBundleIdentifier
  return own && BUNDLES.has(own) ? own : APP_BUNDLES[host]
}

export interface OpenDeps {
  run: OrcaDeps['run']
  platform: NodeJS.Platform
  /** The apps whose pane a tap brings forward: a pane of any other is none. */
  adapters: readonly HostAdapter[]
  log(line: string): void
  /** The raw `HARNESS_OPEN_BIN`: an absolute path is the `open` run instead of `OPEN`. */
  bin?: string
}

export function createOpenActions(deps: OpenDeps): {
  can(target: OpenTarget): boolean
  open(agentId: string, target: OpenTarget): Promise<boolean>
  /** Brings Harness Desktop forward, starting it when it is not running; there on macOS only. */
  desktop?: () => Promise<boolean>
  /** Brings a picked app forward by its id; undefined when nothing ran. There on macOS only. */
  bring?: (app: string) => Promise<'ok' | 'failed' | undefined>
} {
  const mac = deps.platform === 'darwin'
  // One command at a time per agent: a second tap while the first runs would only bring the same app forward twice.
  const running = new Set<string>()
  const openBin = deps.bin && isAbsolute(deps.bin) ? deps.bin : OPEN
  // The last pick wins, so the Mac's front app ends matching the dial's ring (spec decision 4): one bring runs at a time
  // for any app, and a later one takes the single waiting place, answering the one it replaces at once.
  let bringing = false
  let waiting: { bundle: string; answer(outcome: Promise<'ok' | 'failed' | undefined> | undefined): void } | undefined
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
  const can = (target: OpenTarget): boolean => !!paneOn(target) || (mac && !!target.bundle)
  const forward = async (bundle: string): Promise<boolean> => (await deps.run(openBin, ['-b', bundle], RUN_TIMEOUT_MS)).code === 0

  // herdr's ring is herdr's socket's agents, whose terminal nobody knows (#4366): its own app is no window of theirs.
  const bundleFor = (app: string): string | undefined =>
    app === 'harness' ? HARNESS_BUNDLE : app !== 'herdr' && Object.hasOwn(APP_BUNDLES, app) ? APP_BUNDLES[app] : undefined

  async function bringNow(bundle: string): Promise<'ok' | 'failed'> {
    bringing = true
    try {
      return (await forward(bundle)) ? 'ok' : 'failed'
    } catch {
      return 'failed'
    } finally {
      bringing = false
      const next = waiting
      waiting = undefined
      // Failed or not, the last pick made meanwhile still runs.
      next?.answer(bringNow(next.bundle))
    }
  }

  async function bring(app: string): Promise<'ok' | 'failed' | undefined> {
    const bundle = bundleFor(app)
    if (!bringing) return bundle ? bringNow(bundle) : undefined
    // A pick with nothing to bring is still the last pick: the one waiting would turn the dial away from it.
    dropWaiting()
    if (!bundle) return undefined
    return new Promise((answer) => { waiting = { bundle, answer } })
  }

  async function open(target: OpenTarget): Promise<boolean> {
    const own = paneOn(target)
    const bundle = mac ? target.bundle : undefined
    const shown = own ? await own.adapter.focus(own.pane) : false
    if (own && shown === true) {
      // A pane that comes before its app still needs its app at the front; one instead of it (the Claude app's link)
      // brought the app itself.
      if (bundle && own.adapter.tap === 'before') await forward(bundle)
      return true
    }
    if (!bundle) return false
    // The Claude app's link is undocumented and may change with any release: the app still comes forward. Which app
    // only, never its session, pane or handle. A pane refused has said so already.
    if (own && !shown) deps.log(`[device] open · ${own.adapter.id} · fallback`)
    return forward(bundle)
  }

  return {
    can,
    async open(agentId, target) {
      // A tapped notice turns the dial to its own app: a pick waiting would turn it away again.
      dropWaiting()
      if (!can(target) || running.has(agentId)) return false
      running.add(agentId)
      try {
        return await open(target)
      } finally {
        running.delete(agentId)
      }
    },
    // A tap on a Harness agent with no window, which turns the dial to Harness's ring: it drops a pick waiting, as `open`.
    desktop: mac ? () => { dropWaiting(); return forward(HARNESS_BUNDLE) } : undefined,
    bring: mac ? bring : undefined,
  }
}
