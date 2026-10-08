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
    return {
      engine: session.engine,
      get turnOpen() { return normalizer.turnOpen },
      ingest(line) {
        const events = normalizer.ingest(line)
        for (const event of events) if (event.type === 'turn_started') turn++
        const failure = codexTaskError(line)
        return { events, ...(failure === null ? {} : { failure }) }
      },
      snapshot: () => ({ identity: `${generation}:${turn}`, turnOpen: normalizer.turnOpen, continued: false }),
      closeTurn: () => { normalizer.closeTurn() },
      windowStart: (offset) => { normalizer.thinkingPrefix = `thinking-codex-${offset.toString(36)}-` },
    }
  },
}
