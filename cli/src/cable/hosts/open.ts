/**
 * A tap on an agent outside Harness brings it forward (docs/specs/2026-11-13-device-claude-orca.md): first its own pane,
 * where its app has a way in that asks for no new permission (Orca, WezTerm, herdr, the Claude app), then on macOS the
 * app itself, by its bundle id. Every value came from a hook, so each is checked against its own form here, and each
 * command runs with no shell, every value one argument.
 */
import { APP_BUNDLES } from './hostDetect.js'
import { ORCA_HANDLE, RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'
import type { PaneSwitch } from './types.js'

/** Every app a tap brings forward. Alacritty is known by its bundle id alone: no other hint names it. Only one of these
 *  ever reaches `open`, never a hint's own value. */
const BUNDLES: ReadonlySet<string> = new Set([...Object.values(APP_BUNDLES), 'org.alacritty'])
/** `open`'s own path, so no `open` earlier on PATH runs instead. */
export const OPEN = '/usr/bin/open'
const APP_WEZTERM = '/Applications/WezTerm.app/Contents/MacOS/wezterm'
const WEZTERM_PANE = /^[0-9]{1,9}$/
/** herdr's pane id, `w1:p1` (its own guide). */
const HERDR_PANE = /^w[0-9]{1,9}:p[0-9]{1,9}$/
/** The check the Claude app makes of a session its `claude://code/continue` link names (read in the app, 2026-11-14). */
const CLAUDE_SESSION = /^local_[A-Za-z0-9-]{1,64}$/

export interface Pane {
  app: 'orca' | 'wezterm' | 'herdr' | 'claude'
  id: string
}

/** What a tap can open of an agent: its app, by bundle id, and its own pane in it. */
export interface OpenTarget {
  bundle?: string
  pane?: Pane
}

/** From one hook event's hints and the host they name: the app the agent's own window belongs to wins over the host's. */
export function openTarget(host: string, hints: Readonly<Record<string, string>>): OpenTarget {
  const own = hints.__CFBundleIdentifier
  const bundle = own && BUNDLES.has(own) ? own : APP_BUNDLES[host]
  const pane = paneOf(hints)
  return { ...(bundle ? { bundle } : {}), ...(pane ? { pane } : {}) }
}

/** The nearest pane a command can focus, in the order detectHost reads its hosts. */
function paneOf(hints: Readonly<Record<string, string>>): Pane | undefined {
  const { HERDR_PANE_ID: herdr, WEZTERM_PANE: wezterm, ORCA_TERMINAL_HANDLE: orca, CLAUDE_CODE_HOST_SESSION_ID: session } = hints
  if (herdr && HERDR_PANE.test(herdr)) return { app: 'herdr', id: herdr }
  if (wezterm && WEZTERM_PANE.test(wezterm)) return { app: 'wezterm', id: wezterm }
  if (orca && ORCA_HANDLE.test(orca)) return { app: 'orca', id: orca }
  // The link is the Claude app's: a session id another app's agent carries opens no link.
  if (hints.__CFBundleIdentifier === APP_BUNDLES.claude && session && CLAUDE_SESSION.test(session)) return { app: 'claude', id: session }
  return undefined
}

export interface OpenDeps extends OrcaDeps {
  /** Orca's own switch (orca.ts), one command at a time with the words typed into that terminal. */
  orcaSwitch(handle: string): Promise<boolean>
  log(line: string): void
}

export function createOpenActions(deps: OpenDeps): {
  can(target: OpenTarget): boolean
  open(agentId: string, target: OpenTarget): Promise<boolean>
  claudeShow(agentId: string, session: string): Promise<PaneSwitch>
} {
  const mac = deps.platform === 'darwin'
  // One command at a time per agent: a second tap while the first runs would only bring the same app forward twice.
  const running = new Set<string>()
  // A rest's link at a time per agent, in a set of its own: a tap is not refused while a rest's link runs, nor a rest
  // while a tap runs, and two opens of one link do no harm.
  const showing = new Set<string>()

  // `open` and the Claude app's link are macOS's: elsewhere only a pane's own command runs.
  const paneOn = (target: OpenTarget): Pane | undefined => (target.pane && (mac || target.pane.app !== 'claude') ? target.pane : undefined)
  const can = (target: OpenTarget): boolean => !!paneOn(target) || (mac && !!target.bundle)
  const exitsZero = async (file: string, args: string[]): Promise<boolean> => (await deps.run(file, args, RUN_TIMEOUT_MS)).code === 0
  const forward = (bundle: string): Promise<boolean> => exitsZero(OPEN, ['-b', bundle])

  function focus(pane: Pane): Promise<boolean> {
    switch (pane.app) {
      case 'orca':
        return deps.orcaSwitch(pane.id)
      case 'claude':
        return exitsZero(OPEN, [`claude://code/continue?session=${pane.id}`])
      case 'wezterm': {
        const wezterm = deps.onPath('wezterm') ?? (mac && deps.exists(APP_WEZTERM) ? APP_WEZTERM : null)
        return wezterm ? exitsZero(wezterm, ['cli', 'activate-pane', '--pane-id', pane.id]) : Promise.resolve(false)
      }
      case 'herdr': {
        const herdr = deps.onPath('herdr')
        return herdr ? exitsZero(herdr, ['agent', 'focus', pane.id]) : Promise.resolve(false)
      }
    }
  }

  async function open(target: OpenTarget): Promise<boolean> {
    const pane = paneOn(target)
    const bundle = mac ? target.bundle : undefined
    if (pane && await focus(pane)) {
      // The link brings the Claude app forward itself; any other pane's app still has to come to the front.
      if (bundle && pane.app !== 'claude') await forward(bundle)
      return true
    }
    if (!bundle) return false
    // The Claude app's link is undocumented and may change with any release: the app still comes forward. Which app
    // only, never its session, pane or handle.
    if (pane) deps.log(`[device] open · ${pane.app} · fallback`)
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
    // A rest of the dial shows the session in the app, which is already in front: a link that fails brings no app
    // forward, and its outcome is the swipe's own count. The id came from a hook, so its form is checked here too.
    async claudeShow(agentId, session) {
      if (!mac || !CLAUDE_SESSION.test(session)) return 'failed'
      if (showing.has(agentId)) return 'busy'
      showing.add(agentId)
      try {
        return (await focus({ app: 'claude', id: session })) ? 'ok' : 'failed'
      } finally {
        showing.delete(agentId)
      }
    },
  }
}
