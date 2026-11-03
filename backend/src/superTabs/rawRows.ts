import { Prisma } from '@prisma/client'
import { ms } from './parts/light.js'

// Rows that `aggregateRaw` returns, as Prisma's own reads return them: the id under its field name, dates as Dates, numbers
// as numbers, and a field an older document lacks as null (a list as [], a defaulted value as its default). Named-index reads
// (parts/indexed.ts) hand their callers the same rows a findMany did.

type Field = Prisma.DMMF.Field
const fieldsOf = new Map<string, readonly Field[]>()

function scalarFields(model: Prisma.ModelName): readonly Field[] {
  let fields = fieldsOf.get(model)
  if (!fields) {
    const found = Prisma.dmmf.datamodel.models.find(m => m.name === model)
    if (!found) throw new Error(`No Prisma model ${model}`)
    fields = found.fields.filter(field => field.kind === 'scalar' || field.kind === 'enum')
    fieldsOf.set(model, fields)
  }
  return fields
}

const fallback = (field: Field): unknown => {
  if (field.isList) return []
  const value = field.default
  return value !== undefined && (typeof value !== 'object' || value === null) ? value : null
}

function decode(field: Field, value: unknown): unknown {
  if (value === undefined || value === null) return value === null ? null : fallback(field)
  if (field.isList) return (value as unknown[]).map(item => decode({ ...field, isList: false }, item))
  switch (field.type) {
    case 'DateTime': return new Date(ms(value))
    case 'Int': case 'Float': return typeof value === 'number' ? value : Number((value as { $numberLong?: string; $numberDouble?: string; $numberInt?: string })
      .$numberLong ?? (value as { $numberDouble?: string }).$numberDouble ?? (value as { $numberInt?: string }).$numberInt)
    case 'BigInt': return BigInt((value as { $numberLong?: string }).$numberLong ?? String(value))
    case 'String': return typeof value === 'object' && '$oid' in (value as object) ? (value as { $oid: string }).$oid : value
    default: return value
  }
}

/** One `aggregateRaw` row of `model` as Prisma reads it, with every scalar field. */
export function prismaRow<T>(model: Prisma.ModelName, row: Record<string, unknown>): T {
  return Object.fromEntries(scalarFields(model).map(field => [field.name, decode(field, row[field.dbName ?? field.name])])) as T
}
