/**
 * A tap on an agent outside Harness brings it forward (docs/specs/2026-11-13-device-claude-orca.md): its own pane, where
 * its app has a way in that asks for no new permission, and on macOS the app itself, by its bundle id. Here is only what
 * every app shares: each pane, and whether it comes before its app, instead of it or after it, is its adapter's
 * (adapter.ts). Every value came from a hook: a bundle is one of the apps below, a pane is checked by its adapter, and
 * each command runs with no shell, every value one argument.
 */
import type { HostAdapter, Pane } from './adapter.js'
import { APP_BUNDLES } from './hostDetect.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'

/** Every app a tap brings forward. Alacritty is known by its bundle id alone: no other hint names it. Only one of these
 *  ever reaches `open`, never a hint's own value. */
const BUNDLES: ReadonlySet<string> = new Set([...Object.values(APP_BUNDLES), 'org.alacritty'])
/** `open`'s own path, so no `open` earlier on PATH runs instead. */
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
}

export function createOpenActions(deps: OpenDeps): {
  can(target: OpenTarget): boolean
  open(agentId: string, target: OpenTarget): Promise<boolean>
} {
  const mac = deps.platform === 'darwin'
  // One command at a time per agent: a second tap while the first runs would only bring the same app forward twice.
  const running = new Set<string>()

  // The target's pane, when the opener holds its adapter, which brings it forward before or instead of its app and can
  // here (the Claude app's link is macOS's). One that comes after its app is the source's to raise once the app came
  // (observed.ts focus).
  const paneOn = (target: OpenTarget): { adapter: HostAdapter; pane: Pane } | undefined => {
    const pane = target.pane
    const adapter = pane && deps.adapters.find((known) => known.id === pane.adapter)
    return adapter && adapter.tap !== 'after' && adapter.canFocus(pane) ? { adapter, pane } : undefined
  }
  const can = (target: OpenTarget): boolean => !!paneOn(target) || (mac && !!target.bundle)
  const forward = async (bundle: string): Promise<boolean> => (await deps.run(OPEN, ['-b', bundle], RUN_TIMEOUT_MS)).code === 0

  async function open(target: OpenTarget): Promise<boolean> {
    const own = paneOn(target)
    const bundle = mac ? target.bundle : undefined
    if (own && await own.adapter.focus(own.pane)) {
      // A pane that comes before its app still needs its app at the front; one instead of it (the Claude app's link)
      // brought the app itself.
      if (bundle && own.adapter.tap === 'before') await forward(bundle)
      return true
    }
    if (!bundle) return false
    // The Claude app's link is undocumented and may change with any release: the app still comes forward. Which app
    // only, never its session, pane or handle.
    if (own) deps.log(`[device] open · ${own.adapter.id} · fallback`)
    return forward(bundle)
  }

  return {
    can,
    async open(agentId, target) {
      if (!can(target) || running.has(agentId)) return false
      running.add(agentId)
      try {
        return await open(target)
      } finally {
        running.delete(agentId)
      }
    },
  }
}
