/** Validate diagnostic context independently of the serializer that produced it. No inference. */
import { z } from 'zod'
import { canonical } from './admission.js'
import { redact } from '../pair/learn/guard.js'
import { MemoryError, scopeSchema, verificationSchema, type MemoryRecord, type RecallRequest, type SourceEvent } from './types.js'

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/)
const count = z.number().int().nonnegative().safe()
const item = z.object({ id, revision: count.positive() })
const summaryPacket = z.object({ type: z.literal('coding_memory_context'), items: z.array(item).max(6) })
const sourcesPacket = z.object({
  type: z.literal('coding_memory_sources'), version: z.literal(1), notice: z.string().min(1).max(2_000),
  items: z.array(item.extend({ scope: scopeSchema, sourceIds: z.array(id).min(1).max(16) }).strict()).max(6),
  sources: z.array(z.object({ id, engine: id, role: z.enum(['user', 'assistant', 'tool', 'reference', 'derived']),
    observedAt: count, verification: verificationSchema.optional(),
    excerpts: z.array(z.object({ text: z.string().min(1).max(4_000),
      fields: z.array(z.string().min(2).max(200)).min(1).max(3_072) }).strict()).min(1).max(96),
  }).strict()).max(96),
}).strict()
const packetSchema = z.discriminatedUnion('type', [summaryPacket, sourcesPacket])
const fail = (): never => { throw new MemoryError('invalid_recall_context') }
function unique(values: string[]): void { if (new Set(values).size !== values.length) fail() }
const sameSet = (left: string[], right: string[]) => canonical([...left].sort()) === canonical([...new Set(right)].sort())

export function reviewRecallContext(input: {
  text: string; records: MemoryRecord[]; declaredFormat?: RecallRequest['format']; capturedSources?: SourceEvent[]
  originals: Array<{ id: string; projectId: string | null; role: SourceEvent['role']; text: string }>
}) {
  if (!input.text) return { items: [], format: input.declaredFormat ?? null }
  let packet: z.infer<typeof packetSchema>
  try { packet = packetSchema.parse(JSON.parse(input.text)) } catch { return fail() }
  const format = packet.type === 'coding_memory_context' ? 'summary' as const : 'source_excerpts' as const
  if (input.declaredFormat && input.declaredFormat !== format) fail()
  unique(packet.items.map(row => row.id))
  const records = packet.items.map(row => {
    const record = input.records.find(record => record.id === row.id && record.revision === row.revision)
    return record ?? fail()
  })
  if (packet.type === 'coding_memory_sources') {
    if (!input.capturedSources) fail()
    unique(input.capturedSources!.map(row => row.id))
    unique(packet.sources.map(row => row.id))
    if (!sameSet(packet.sources.map(row => row.id), records.flatMap(record => record.evidence.map(e => e.sourceEventId)))) fail()
    for (const row of packet.items) {
      const record = records.find(record => record.id === row.id)!
      unique(row.sourceIds)
      if (canonical(row.scope) !== canonical(record.scope)
        || !sameSet(row.sourceIds, record.evidence.map(e => e.sourceEventId))) fail()
    }
    for (const source of packet.sources) {
      const captured = input.capturedSources!.find(row => row.id === source.id)
      const original = input.originals.find(row => row.id === source.id)
      if (!captured || !original || captured.role !== original.role || captured.projectId !== original.projectId
        || captured.text !== redact(original.text) || source.role !== captured.role || source.engine !== captured.engine
        || source.observedAt !== captured.observedAt || canonical(source.verification ?? null) !== canonical(captured.verification ?? null)) fail()
      const evidence = records.flatMap(record => record.evidence).filter(row => row.sourceEventId === source.id)
      unique(source.excerpts.map(excerpt => excerpt.text))
      if (!sameSet(source.excerpts.map(excerpt => excerpt.text), evidence.map(row => row.quote))) fail()
      for (const excerpt of source.excerpts) {
        unique(excerpt.fields)
        if (!captured!.text.includes(excerpt.text)
          || !sameSet(excerpt.fields, evidence.filter(row => row.quote === excerpt.text).flatMap(row => row.paths))) fail()
      }
    }
  }
  return { items: packet.items, format }
}
