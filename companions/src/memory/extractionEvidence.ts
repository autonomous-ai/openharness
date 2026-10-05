import { z } from 'zod'
import { draftSchema, evidenceSchema, MemoryError, parse, type MemoryDraft, type SourceEvent } from './types.js'

const referenceSchema = z.object({
  ref: z.string().max(40).regex(/^s\d+p\d+$/),
  paths: evidenceSchema.shape.paths,
}).strict()

// References are an inference format only. Resolve them before applying every persisted-draft
// refinement and the queue's existing source, coverage, role and authorization checks.
const referenceDraft = z.object({ ...draftSchema.shape, evidence: z.array(referenceSchema).min(1).max(16) }).strict()
export const extractionOutputSchema = z.object({ proposals: z.array(referenceDraft).max(8) }).strict()
const answerSchema = z.object({ proposals: z.array(z.object({ ...draftSchema.shape,
  evidence: z.array(z.union([referenceSchema, evidenceSchema])).min(1).max(16),
}).strict()).max(8) }).strict()

/** Keep source text byte-for-byte, including separators, and never split a UTF-16 surrogate pair. */
function excerpts(text: string): string[] {
  const parts: string[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 4_000, text.length)
    if (end < text.length) {
      // Prefer a nearby paragraph/line boundary without allowing many tiny excerpts to inflate
      // the prompt. A source of at most 32,000 characters needs at most sixteen excerpts.
      for (const separator of ['\n\n', '\n']) {
        const boundary = text.lastIndexOf(separator, end - separator.length)
        if (boundary >= start + 2_000) { end = boundary + separator.length; break }
      }
      const last = text.charCodeAt(end - 1), next = text.charCodeAt(end)
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
    }
    parts.push(text.slice(start, end))
    start = end
  }
  return parts
}

/** The source order also indexes episode boundaries; retain all original metadata and text. */
export function extractionSources(sources: readonly SourceEvent[]) {
  return sources.map(({ text, ...metadata }, sourceIndex) => ({ ...metadata,
    excerpts: excerpts(text).map((text, partIndex) => ({ ref: `s${sourceIndex}p${partIndex}`, text })),
  }))
}

export function resolveExtractionProposals(answer: unknown, sources: readonly SourceEvent[]): MemoryDraft[] {
  const references = new Map(extractionSources(sources).flatMap(source => source.excerpts.map(part => [part.ref, {
    sourceEventId: source.id, quote: part.text, ...(source.verification ? { verification: source.verification } : {}),
  }] as const)))
  const result = parse(answerSchema, answer)
  return result.proposals.map(proposal => parse(draftSchema, { ...proposal,
    evidence: proposal.evidence.map(evidence => {
      // Preserve strict exact-quote admission for previously supported raw evidence as well.
      if (!('ref' in evidence)) return evidence
      const source = references.get(evidence.ref)
      if (!source) throw new MemoryError('evidence_reference')
      return { ...source, paths: evidence.paths }
    }),
  }))
}
