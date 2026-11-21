/**
 * Tier A's fake Claude app and fake ChatGPT app (docs/plans/2026-11-21-dial-app-eval-design.md, "The fake apps react to
 * links"): they watch the commands the devices run, and a moment after one opens a session's link the app shows that
 * session, as the real app does, and says so: the Claude app's mod sends its attach, and the ChatGPT app's window title,
 * which the watch reads only for the app in front and with Accessibility, becomes the thread's Codex name. A session the
 * scenario marks resumable it also starts: its process, its start hook and, for Claude, the mod's open inbox poll
 * (sessions.ts startSession). Installed after the world's own rules, so a link the scenario says fails is answered 1
 * there and opens nothing.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionDef } from '../types.js'
import { startSession } from './steps/sessions.js'
import { windowSteps } from './steps/window.js'
import type { TierAWorld } from './world.js'

/** How long an app takes to show and resume what a link opens. */
const OPEN_MS = 500
/** The scenarios whose ChatGPT app has no Accessibility, so no window title reaches the watch: the catalog's world has
 *  no field for it, and X3 says it in its title. */
const NO_ACCESSIBILITY: ReadonlySet<string> = new Set(['X3'])

/** The link the devices make for a session (cable/hosts/claudeApp.ts, codexApp.ts): only the whole link opens it. */
const linkOf = (s: SessionDef): string => (s.app === 'claude' ? `claude://code/continue?session=${s.localId}` : `codex://threads/${s.id}`)

/** The session a command's link names, whichever opener runs it (open, xdg-open, harness-pty open-link). */
function opened(world: TierAWorld, argv: readonly string[]): SessionDef | undefined {
  return world.scenario.sessions.find((s) => !s.ghost && argv.includes(linkOf(s)))
}

/** The thread's name as Codex keeps it, its last line in session_index.jsonl, else the scenario's title. */
function codexName(world: TierAWorld, s: SessionDef): string {
  const index = join(world.codexHome.home, 'session_index.jsonl')
  const lines = existsSync(index) ? readFileSync(index, 'utf8').split('\n').filter(Boolean) : []
  const names = lines.map((line) => JSON.parse(line) as { id: string; thread_name: string }).filter((row) => row.id === s.id)
  return names.at(-1)?.thread_name ?? s.title
}

/** What the app says of the session it shows, then the session resumed when it can be. A word the listener refuses
 *  leaves the scenario on this platform ungraded: its echo is not the app's. */
async function show(world: TierAWorld, s: SessionDef): Promise<void> {
  try {
    if (s.app === 'claude') await windowSteps.attach(world, { kind: 'attach', session: s.key })
    else if (world.front === 'chatgpt' && !NO_ACCESSIBILITY.has(world.scenario.id)) {
      await windowSteps.thread(world, { kind: 'thread', title: codexName(world, s) })
    }
  } catch {
    world.gap(`the devices refused the app's word on ${s.key}`)
  }
  // A session already running is only shown: startSession starts each once.
  if (s.resumable) await startSession(world, s.key)
}

export function installFakeApps(world: TierAWorld): void {
  // It answers nothing: the command is answered as the world's rules say, and the app reacts after it returned.
  world.answer((argv) => {
    const s = opened(world, argv)
    if (s !== undefined) setTimeout(() => { void show(world, s) }, OPEN_MS)
    return undefined
  })
}
