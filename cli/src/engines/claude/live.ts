import { randomUUID } from 'node:crypto'
import type { EngineLive, LiveParser } from '../facets/live.js'
import { claudeAttachRules } from './attach.js'
import { lineToEvents, newTurnState } from './normalize.js'

/** The record's own time (Claude Code's `timestamp`), epoch ms, or undefined when it has none. */
function writtenAt(line: string): number | undefined {
  try {
    const at = Date.parse((JSON.parse(line) as { timestamp?: unknown }).timestamp as string)
    return Number.isSafeInteger(at) ? at : undefined
  } catch { return undefined }
}

function create(session: Parameters<EngineLive['create']>[0]): LiveParser {
  const state = newTurnState()
  const generation = randomUUID()
  let openedAt: number | undefined
  return {
    engine: session.engine,
    get turnOpen() { return state.turnOpen },
    ingest: (line) => {
      const before = state.opened
      const events = lineToEvents(line, state)
      if (state.opened !== before) openedAt = writtenAt(line)
      return { events }
    },
    snapshot: () => ({ identity: `${generation}:${state.opened ?? 0}`, turnOpen: state.turnOpen, continued: state.continued === true,
      ...(openedAt === undefined ? {} : { openedAt }) }),
    closeTurn(reason) {
      state.turnOpen = false
      // A cancel has historically kept tool links and pending calls; a relaunch or Stop clears them.
      if (reason !== 'cancel') state.pendingTools.clear()
    },
    windowStart: (offset) => { state.thinkingPrefix = `thinking-live-${offset.toString(36)}-` },
  }
}

export const live: EngineLive = { create, attachRules: claudeAttachRules }
