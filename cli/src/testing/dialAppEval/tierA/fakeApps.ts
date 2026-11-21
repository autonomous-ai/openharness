/**
 * Tier A's fake Claude app and fake ChatGPT app (docs/plans/2026-11-21-dial-app-eval-design.md, "The fake apps react to
 * links"): they watch the commands the devices run, and a link for a session the scenario marks resumable starts that
 * session as the real app resumes it: its process, its start hook and, for Claude, the mod's open inbox poll
 * (sessions.ts startSession). Installed after the world's own rules, so a link the scenario says fails is answered 1
 * there and resumes nothing.
 */
import type { SessionDef, SessionKey } from '../types.js'
import { startSession } from './steps/sessions.js'
import type { TierAWorld } from './world.js'

/** The link the devices make for a session (cable/hosts/claudeApp.ts, codexApp.ts): only the whole link opens it. */
const linkOf = (s: SessionDef): string => (s.app === 'claude' ? `claude://code/continue?session=${s.localId}` : `codex://threads/${s.id}`)

/** The resumable session a command's link names, whichever opener runs it (open, xdg-open, harness-pty open-link). */
function resumed(world: TierAWorld, argv: readonly string[]): SessionKey | undefined {
  return world.scenario.sessions.find((s) => s.resumable && !s.ghost && argv.includes(linkOf(s)))?.key
}

export function installFakeApps(world: TierAWorld): void {
  world.answer((argv) => {
    const key = resumed(world, argv)
    if (key === undefined) return undefined
    // A session already running is only brought forward: startSession starts each once.
    void startSession(world, key)
    return { code: 0 }
  })
}
