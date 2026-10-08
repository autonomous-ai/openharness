import { randomUUID } from 'node:crypto'
import type { EngineLive, LiveParser } from '../facets/live.js'
import { claudeAttachRules } from './attach.js'
import { lineToEvents, newTurnState } from './normalize.js'

function create(session: Parameters<EngineLive['create']>[0]): LiveParser {
  const state = newTurnState()
  const generation = randomUUID()
  return {
    engine: session.engine,
    get turnOpen() { return state.turnOpen },
    ingest: (line) => ({ events: lineToEvents(line, state) }),
    snapshot: () => ({ identity: `${generation}:${state.opened ?? 0}`, turnOpen: state.turnOpen, continued: state.continued === true }),
    closeTurn(reason) {
      state.turnOpen = false
      // A cancel has historically kept tool links and pending calls; a relaunch or Stop clears them.
      if (reason !== 'cancel') state.pendingTools.clear()
    },
    windowStart: (offset) => { state.thinkingPrefix = `thinking-live-${offset.toString(36)}-` },
  }
}

export const live: EngineLive = { create, attachRules: claudeAttachRules }
