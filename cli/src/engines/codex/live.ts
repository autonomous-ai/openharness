import { randomUUID } from 'node:crypto'
import type { EngineLive } from '../facets/live.js'
import { codexAttachRules } from './attach.js'
import { CodexNormalizer, codexTaskError } from './normalizer.js'
import { codexSubagentResolverFor } from './subagent.js'

export const live: EngineLive = {
  attachRules: codexAttachRules,
  create(session) {
    const normalizer = new CodexNormalizer('live', codexSubagentResolverFor(session.codexHome))
    const generation = randomUUID()
    let turn = 0
    let openedAt: number | undefined
    return {
      engine: session.engine,
      get turnOpen() { return normalizer.turnOpen },
      ingest(line) {
        const events = normalizer.ingest(line)
        const at = normalizer.at
        for (const event of events) if (event.type === 'turn_started') { turn++; openedAt = at }
        const failure = codexTaskError(line)
        return { events, ...(failure === null ? {} : { failure }), ...(at === undefined ? {} : { at }) }
      },
      snapshot: () => ({ identity: `${generation}:${turn}`, turnOpen: normalizer.turnOpen, continued: false,
        ...(openedAt === undefined ? {} : { openedAt }) }),
      closeTurn: () => { normalizer.closeTurn() },
      windowStart: (offset) => { normalizer.thinkingPrefix = `thinking-codex-${offset.toString(36)}-` },
    }
  },
}
