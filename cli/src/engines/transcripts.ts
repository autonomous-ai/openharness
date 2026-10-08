import type { EngineTranscript } from './facets/transcript.js'
import { transcript as claude } from './claude/transcript.js'
import { transcript as codex } from './codex/transcript.js'

/** Only for explicit inline compatibility and tests. Supervised core uses the reader port. */
export function engineTranscriptFor(engine: string): EngineTranscript | undefined {
  const transcripts = { claude, codex }
  return Object.hasOwn(transcripts, engine) ? transcripts[engine as keyof typeof transcripts] : undefined
}
