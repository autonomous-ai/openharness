import { claudeAttachRules } from '../engines/claude/attach.js'
import { codexAttachRules } from '../engines/codex/attach.js'
/**
 * The whole-history attach that `lib/attachTranscript.ts` replaced, kept as the oracle the end-first
 * read is checked against — by the unit suite on synthetic transcripts and by the opt-in real-data
 * suite on this computer's own (`attachTranscript.real.spec.ts`).
 */
import { CodexNormalizer, codexGoalOf, startsCodexTurn } from '../engines/codex/normalizer.js'
import { attachTranscript } from '../lib/attachTranscript.js'
import { foldTranscript, lineToEvents, newTurnState, TranscriptFold, type LiveEvent } from '../lib/normalize.js'
import type { RegisteredSession } from '../lib/registry.js'
import { RuntimeProfileManager } from '../lib/runtimeProfile.js'
import { tailFile } from '../lib/transcriptTail.js'

export type Engine = 'claude' | 'codex'

export function session(engine: Engine): RegisteredSession {
  return {
    schemaVersion: 2,
    active: true,
    sessionId: `session:${engine}`, engine, launcherId: 'h1', agentId: 'h1', boundAt: 0, transcriptPath: '/tmp/t.jsonl', projectDir: 'tmp', cwd: '/tmp',
    tmuxPane: '%1', source: null, title: null, model: null,
    runtimes: [{ backend: 'tmux', paneId: '%1' }], primaryRuntimeKey: 'tmux\u0000%1',
    cliVersion: null, processIdentity: null,
    registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
  }
}

export interface Folded {
  turnOpen: boolean
  opened: LiveEvent | undefined
  live: LiveEvent[]
  profile: { model: string | null; effort: string | null; mode: string; cliVersion: string | null }
  ingest: (line: string) => LiveEvent[]
  content: boolean
}

export function newFold(engine: Engine): { ingest: (line: string) => LiveEvent[]; turnOpen: () => boolean; name(windowStart: number): void } {
  if (engine === 'codex') {
    const normalizer = new CodexNormalizer('live', () => null)
    return {
      ingest: (line) => normalizer.ingest(line),
      turnOpen: () => normalizer.turnOpen,
      name: (windowStart) => { normalizer.thinkingPrefix = `thinking-codex-${windowStart.toString(36)}-` },
    }
  }
  const state = newTurnState()
  return {
    ingest: (line) => lineToEvents(line, state),
    turnOpen: () => state.turnOpen,
    name: (windowStart) => { state.thinkingPrefix = `thinking-live-${windowStart.toString(36)}-` },
  }
}

const profileOf = (profiles: RuntimeProfileManager, s: RegisteredSession): Folded['profile'] => {
  const { model, effort, mode, cliVersion } = profiles.getState(s.sessionId)
  return { model, effort, mode, cliVersion }
}

export async function wholeHistory(engine: Engine, file: string, live: boolean): Promise<Folded> {
  const lines = await tailFile(file, Infinity)
  const s = session(engine)
  const profiles = new RuntimeProfileManager()
  profiles.hydrate(s, lines)
  // As attachSessionNow does next: Claude's effort comes from its settings, whatever the transcript said.
  await profiles.ingestConfig(s, true)
  const fold = newFold(engine)
  const out = foldTranscript(fold.ingest, lines, fold.turnOpen, { live })
  return {
    turnOpen: out.turnOpen,
    opened: out.history.findLast((event) => event.type === 'turn_started'),
    live: out.live,
    profile: profileOf(profiles, s),
    ingest: fold.ingest,
    content: lines.length > 0,
  }
}

export async function fromTheEnd(engine: Engine, file: string, live: boolean, end?: number): Promise<Folded & { next: number }> {
  const s = session(engine)
  const profiles = new RuntimeProfileManager()
  const fold = newFold(engine)
  const stream = new TranscriptFold(fold.ingest, fold.turnOpen, live)
  const fields = (line: string) => profiles.transcriptFields(s, line)
  const profile = profiles.beginHydrate(s)
  // As attachSessionNow does: the staged profile, ids named for the window, then Claude's settings.
  const read = await attachTranscript(file, engine === 'codex' ? codexAttachRules(fields) : claudeAttachRules(fields), {
    start: (span) => fold.name(span.turnFrom),
    profile: (line) => profile.ingest(line),
    fold: (line) => stream.push(line),
  }, { fromStart: live, end })
  profile.commit()
  await profiles.ingestConfig(s, true)
  const out = stream.finish()
  return {
    turnOpen: out.turnOpen,
    opened: out.history.findLast((event) => event.type === 'turn_started'),
    live: out.live,
    profile: profileOf(profiles, s),
    ingest: fold.ingest,
    content: read.content,
    next: read.next,
  }
}

/** Thinking ids number the blocks from wherever a fold starts; everything else must match exactly. */
export function canonical(events: LiveEvent[]): unknown[] {
  const ids = new Map<string, string>()
  return events.map((event) => {
    const payload = event.payload as Record<string, unknown>
    if (typeof payload.thinkingId !== 'string') return event
    if (!ids.has(payload.thinkingId)) ids.set(payload.thinkingId, `thinking#${ids.size}`)
    return { ...event, payload: { ...payload, thinkingId: ids.get(payload.thinkingId) } }
  })
}

/**
 * The one documented divergence beyond thinking ids: an ordinary opener does not look back for the goal
 * before it, so the first goal turn after it reads as that goal's submission. Applied only when the
 * attach-time opener is ordinary and a goal came before it — anywhere else the events must be equal.
 */
export function goalForgotten(records: string[], cut: number, events: LiveEvent[]): LiveEvent[] {
  const before = records.slice(0, cut)
  const opener = before.findLastIndex(startsCodexTurn)
  if (opener < 0 || codexGoalOf(before[opener]) !== null || !before.slice(0, opener).some((line) => codexGoalOf(line) !== null)) return events
  let done = false
  return events.map((event) => {
    if (done || event.type !== 'turn_started') return event
    const message = event.payload.userMessage
    if (!message.startsWith('/goal ') && !message.startsWith('Continuing goal: ')) return event
    done = true
    return { ...event, payload: { userMessage: message.replace(/^Continuing goal: /, '/goal ') } }
  })
}
