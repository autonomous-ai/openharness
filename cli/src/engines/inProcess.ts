/**
 * The code of the twelve engines besides Claude Code and Codex, loaded in the core's process only once one of
 * their sessions needs it (docs/design/2026-10-08-other-engines-out-of-core.md). An engine nobody runs costs
 * the core nothing: from the lean bundle each `import()` here is a file of its own, which Node reads only when
 * it is imported (build-bundle.mjs, `splitting`).
 *
 * This is the one file that `import()`s their code. src/architecture.spec.ts does not follow an `import()`
 * written here, and follows one written anywhere else.
 *
 * A module that cannot load (its file gone from the bundle, or its top level throwing) is caught once, logged
 * once, and answered `null` for the life of the process: never rethrown, never retried, since a file that
 * failed to import fails again until an update or a restart. Each caller answers `null` as it answers an engine
 * it has no code for, so a failed import costs those engines and never the core, Claude Code or Codex, which
 * never come here.
 */
import type { ScreenReading } from './facets/screen.js'
import { terminalScreen } from './kit/screen.js'
import { isTerminalEngine, type AgentEngine, type ProcessEngine } from './types.js'

/** The engines whose code the core loads only when one of their sessions needs it. */
export const OTHER_ENGINES = ['opencode', 'cursor', 'kilo', 'devin', 'hermes', 'amp', 'agy', 'grok', 'copilot', 'commandcode', 'muse', 'pi'] as const satisfies readonly ProcessEngine[]
export type OtherEngine = (typeof OTHER_ENGINES)[number]
export function isOtherEngine(engine: string): engine is OtherEngine { return (OTHER_ENGINES as readonly string[]).includes(engine) }

/** What the core may load, each the root of a file of its own in the bundle. */
const MODULES = {
  /** Their pane and dialog readers, the twelve in one: lib/legacyScreen.ts with lib/legacyPane.ts,
   *  lib/questionPane.ts and the eight `askQuestion.ts`. A pane is read on every poll of one of their sessions. */
  screens: () => import('../lib/legacyScreen.js'),
}
export type InProcessModules = { [Name in keyof typeof MODULES]: Awaited<ReturnType<(typeof MODULES)[Name]>> }

export interface InProcessLoader<Modules> {
  /** The module, once loaded, or `null` when it could not be: imported once, whoever asks. */
  load<Name extends keyof Modules>(name: Name): Promise<Modules[Name] | null>
  /** The module now: loaded, `null` when it could not be, or `undefined` while it is loading. Asking starts it. */
  loaded<Name extends keyof Modules>(name: Name): Modules[Name] | null | undefined
}

export function createInProcessLoader<Modules>(modules: { [Name in keyof Modules]: () => Promise<Modules[Name]> },
  log: (line: string) => void): InProcessLoader<Modules> {
  const started = new Map<keyof Modules, { now: unknown; done: Promise<unknown> }>()
  const load = <Name extends keyof Modules>(name: Name): Promise<Modules[Name] | null> => {
    let entry = started.get(name)
    if (!entry) {
      const fresh: { now: unknown; done: Promise<unknown> } = { now: undefined, done: Promise.resolve() }
      // Through `then`, so that a loader which throws before it returns its promise is caught the same way.
      fresh.done = Promise.resolve().then(() => modules[name]()).then((module) => { fresh.now = module; return module }, (error: unknown) => {
        fresh.now = null
        log(`[engine ${String(name)}] unavailable · ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ')}`)
        return null
      })
      started.set(name, fresh)
      entry = fresh
    }
    return entry.done as Promise<Modules[Name] | null>
  }
  return {
    load,
    loaded: (name) => {
      const entry = started.get(name)
      if (!entry) void load(name)
      return entry?.now as Modules[typeof name] | null | undefined
    },
  }
}

const loader = createInProcessLoader<InProcessModules>(MODULES, (line) => console.error(line))
export const loadEngine = loader.load
export const engineLoaded = loader.loaded

/**
 * Starts loading what a session of `engine` reads, as the session enters the registry (lib/registry.ts
 * `onEnter`): so that nothing it does later, a close's or a message's look at its pane among them, waits for an
 * import. Claude Code, Codex and the terminal load nothing.
 */
export function preloadEngine(engine: AgentEngine): void {
  if (isOtherEngine(engine)) void loadEngine('screens')
}

/**
 * A pane of a session whose screen no worker reads, read in the core's process (core/engines/screens.ts
 * `inline`): the terminal's with the kit alone, the other engines' with their readers. `undefined`, which the
 * core reads as an unreadable screen, when their readers could not load, and for any engine not theirs.
 */
export async function inProcessScreen(engine: AgentEngine, capture: string | null): Promise<ScreenReading | undefined> {
  if (isTerminalEngine(engine)) return terminalScreen(capture)
  if (!isOtherEngine(engine)) return undefined
  return (await loadEngine('screens'))?.legacyScreen(engine, capture)
}
