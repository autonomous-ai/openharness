/**
 * Each session's engine state: a live parser, and the normalizer (an engine with a
 * transcript file) or reader (an engine with a database) that folds every other engine's history.
 * One table instead of fourteen maps, so the questions asked of all of them — does this session have
 * any, is its turn open, forget it, close its turn, stop the pollers — each have one answer.
 *
 * The maps themselves stay public: attach and ingest create each engine's entry their own way, lazily
 * for the file engines and never from ingest for the database readers.
 *
 * Moved out of `runForeground` (the core boundary, step 4: docs/design/2026-10-03-harnessd.md).
 */
import type { AgyNormalizer } from '../../engines/agy/normalizer.js'
import type { AmpNormalizer } from '../../engines/amp/normalizer.js'
import type { LiveState } from '../../engines/facets/live.js'
import type { CommandCodeNormalizer } from '../../engines/commandcode/normalizer.js'
import type { CopilotNormalizer } from '../../engines/copilot/normalizer.js'
import type { CursorNormalizer } from '../../engines/cursor/normalizer.js'
import type { DevinReader } from '../../engines/devin/reader.js'
import type { GrokNormalizer } from '../../engines/grok/normalizer.js'
import type { HermesReader } from '../../engines/hermes/reader.js'
import type { KiloReader } from '../../engines/kilo/reader.js'
import type { MuseNormalizer } from '../../engines/muse/normalizer.js'
import type { OpencodeReader } from '../../engines/opencode/reader.js'
import type { PiNormalizer } from '../../engines/pi/normalizer.js'

export function createSessionNormalizers() {
  // Per-session web turn-lifecycle state; the device mirror keeps its own state + recap.
  const liveParsers = new Map<string, LiveState>()
  const cursorNormalizers = new Map<string, CursorNormalizer>()
  const opencodeReaders = new Map<string, OpencodeReader>()
  const kiloReaders = new Map<string, KiloReader>()
  const piNormalizers = new Map<string, PiNormalizer>()
  const museNormalizers = new Map<string, MuseNormalizer>()
  const ampNormalizers = new Map<string, AmpNormalizer>()
  const grokNormalizers = new Map<string, GrokNormalizer>()
  const agyNormalizers = new Map<string, AgyNormalizer>()
  const copilotNormalizers = new Map<string, CopilotNormalizer>()
  const hermesReaders = new Map<string, HermesReader>()
  const devinReaders = new Map<string, DevinReader>()
  const commandcodeNormalizers = new Map<string, CommandCodeNormalizer>()

  /** Whether this session's engine state says a turn is open right now, whichever engine it is. */
  const sessionTurnState = (sessionId: string): boolean | undefined =>
    liveParsers.get(sessionId)?.turnOpen
      ?? cursorNormalizers.get(sessionId)?.turnOpen
      ?? opencodeReaders.get(sessionId)?.turnOpen
      ?? kiloReaders.get(sessionId)?.turnOpen
      ?? piNormalizers.get(sessionId)?.turnOpen
      ?? museNormalizers.get(sessionId)?.turnOpen
      ?? ampNormalizers.get(sessionId)?.turnOpen
      ?? grokNormalizers.get(sessionId)?.turnOpen
      ?? agyNormalizers.get(sessionId)?.turnOpen
      ?? copilotNormalizers.get(sessionId)?.turnOpen
      ?? hermesReaders.get(sessionId)?.turnOpen
      ?? devinReaders.get(sessionId)?.turnOpen
      ?? commandcodeNormalizers.get(sessionId)?.turnOpen
  const sessionTurnOpen = (sessionId: string): boolean => sessionTurnState(sessionId) ?? false

  /** Whether any engine state exists for this session: an attach that finds some is not a first one. */
  const hasState = (sessionId: string): boolean =>
    liveParsers.has(sessionId)
      || cursorNormalizers.has(sessionId)
      || opencodeReaders.has(sessionId)
      || kiloReaders.has(sessionId)
      || piNormalizers.has(sessionId)
      || museNormalizers.has(sessionId)
      || ampNormalizers.has(sessionId)
      || grokNormalizers.has(sessionId)
      || agyNormalizers.has(sessionId)
      || copilotNormalizers.has(sessionId)
      || hermesReaders.has(sessionId)
      || devinReaders.has(sessionId)
      || commandcodeNormalizers.has(sessionId)

  /** Drop all of a forgotten session's engine state, stopping its database readers' pollers. */
  const forget = (sessionId: string): void => {
    liveParsers.delete(sessionId)
    cursorNormalizers.delete(sessionId)
    opencodeReaders.get(sessionId)?.stop()
    opencodeReaders.delete(sessionId)
    kiloReaders.get(sessionId)?.stop()
    kiloReaders.delete(sessionId)
    piNormalizers.delete(sessionId)
    museNormalizers.delete(sessionId)
    ampNormalizers.delete(sessionId)
    grokNormalizers.delete(sessionId)
    agyNormalizers.delete(sessionId)
    copilotNormalizers.delete(sessionId)
    hermesReaders.get(sessionId)?.stop()
    hermesReaders.delete(sessionId)
    devinReaders.get(sessionId)?.stop()
    devinReaders.delete(sessionId)
    commandcodeNormalizers.delete(sessionId)
  }

  /** Mark the session's turn closed in whichever engine holds it (a cancel). What a closing
   *  normalizer returns is not emitted: a cancel sends no turn end. */
  const closeTurns = (sessionId: string): void => {
    liveParsers.get(sessionId)?.closeTurn('cancel')
    cursorNormalizers.get(sessionId)?.closeTurn()
    opencodeReaders.get(sessionId)?.closeTurn()
    kiloReaders.get(sessionId)?.closeTurn()
    piNormalizers.get(sessionId)?.closeTurn()
    museNormalizers.get(sessionId)?.closeTurn()
    ampNormalizers.get(sessionId)?.closeTurn()
    grokNormalizers.get(sessionId)?.closeTurn()
    agyNormalizers.get(sessionId)?.closeTurn()
    copilotNormalizers.get(sessionId)?.closeTurn()
    hermesReaders.get(sessionId)?.closeTurn()
    devinReaders.get(sessionId)?.closeTurn()
    commandcodeNormalizers.get(sessionId)?.closeTurn()
  }

  /** Stop every database reader's poller (shutdown, and the handoff to an update). */
  const stopPollers = (): void => {
    for (const r of opencodeReaders.values()) r.stop()
    for (const r of kiloReaders.values()) r.stop()
    for (const r of hermesReaders.values()) r.stop()
    for (const r of devinReaders.values()) r.stop()
  }

  return {
    liveParsers, cursorNormalizers, opencodeReaders, kiloReaders, piNormalizers,
    museNormalizers, ampNormalizers, grokNormalizers, agyNormalizers, copilotNormalizers, hermesReaders,
    devinReaders, commandcodeNormalizers,
    sessionTurnState, sessionTurnOpen, hasState, forget, closeTurns, stopPollers,
  }
}

export type SessionNormalizers = ReturnType<typeof createSessionNormalizers>
