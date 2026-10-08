import type { EngineTranscript, HistoryAsk } from './facets/transcript.js'
import type { HistoryPage, TranscriptPager } from '../lib/transcriptPages.js'
import { pages as claudePages, transcript as claude } from './claude/transcript.js'
import { pages as codexPages, transcript as codex } from './codex/transcript.js'

/** Only for explicit inline compatibility and tests. Supervised core uses the reader port. */
export function engineTranscriptFor(engine: string): EngineTranscript | undefined {
  const transcripts = { claude, codex }
  return Object.hasOwn(transcripts, engine) ? transcripts[engine as keyof typeof transcripts] : undefined
}

/** One page of `engine`'s transcript at `path`, as that engine's reader asks the pager for it. */
export function pageOf(pager: TranscriptPager, engine: 'claude' | 'codex', path: string, ask: HistoryAsk): Promise<HistoryPage> {
  return pager.page(path, engine === 'claude' ? claudePages : codexPages, ask)
}
