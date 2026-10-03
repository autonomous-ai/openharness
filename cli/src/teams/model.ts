import { z } from 'zod'

export const TEAM_PROTOCOL = 'team.v1'
export const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
export const OperationId = z.string().regex(/^[a-f0-9]{32}$/)
export const MemberName = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/, 'Use letters, numbers, hyphens, or underscores.')
export const Address = z.object({ machineId: Id, agentId: Id })
export type Address = z.infer<typeof Address>
export const MemberSpec = Address.extend({ name: MemberName, role: z.string().trim().max(600).default('') })
export type MemberSpec = z.infer<typeof MemberSpec>
export const Receipt = z.object({
  id: z.string().regex(/^team:[a-f0-9]{32}:[a-f0-9]{32}:(intro|question|answer|consult)$/),
  state: z.enum(['pending', 'queued', 'submitted', 'delivered', 'started', 'received', 'unknown', 'rejected', 'cancelled']),
  reason: z.string().max(600).optional(),
  updatedAt: z.number(),
})
export type Receipt = z.infer<typeof Receipt>
export const Member = MemberSpec.extend({
  id: OperationId,
  key: z.string().regex(/^[a-f0-9]{64}$/),
  joinedAt: z.number(),
  enabled: z.boolean(),
  introduction: Receipt,
  introductionExpiresAt: z.number().optional(),
})
export type Member = z.infer<typeof Member>
export const Evidence = z.array(z.string().trim().min(1).max(1024)).max(16).default([])
export const QuestionSpec = z.object({
  id: OperationId,
  from: OperationId,
  to: z.string().trim().min(1).max(128),
  text: z.string().trim().min(1).max(8000),
  context: z.string().max(8000).default(''),
  parentId: OperationId.optional(),
  ttlMs: z.number().int().min(10_000).max(86_400_000).default(900_000),
  notify: z.boolean().default(true),
})
export type QuestionSpec = z.infer<typeof QuestionSpec>
export const Exchange = QuestionSpec.extend({
  to: OperationId,
  origin: z.enum(['owner', 'agent']),
  state: z.enum(['pending', 'answered', 'expired', 'cancelled']),
  createdAt: z.number(),
  expiresAt: z.number(),
  delivery: Receipt,
  answer: z.object({
    text: z.string().min(1).max(16000),
    evidence: Evidence,
    author: OperationId,
    origin: z.enum(['owner', 'agent']),
    at: z.number(),
    late: z.boolean(),
  }).optional(),
  continuation: Receipt.optional(),
})
export type Exchange = z.infer<typeof Exchange>
export const Consultation = z.object({
  id: OperationId,
  memberId: OperationId,
  createdAt: z.number(),
  receipt: Receipt,
})
export type Consultation = z.infer<typeof Consultation>
export const Team = z.object({
  protocol: z.literal(TEAM_PROTOCOL),
  id: OperationId,
  machineId: Id,
  creationHash: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(''),
  state: z.enum(['active', 'paused', 'archived']),
  revision: z.number().int().min(1),
  createdAt: z.number(),
  updatedAt: z.number(),
  channel: z.object({ tabId: Id, deskRevision: z.number().int().nonnegative(), closed: z.boolean().default(false) }).optional(),
  members: z.array(Member).max(512),
  exchanges: z.array(Exchange).max(500),
  consultations: z.array(Consultation).max(500).default([]),
})
export type Team = z.infer<typeof Team>
export const CreateTeam = z.object({
  id: OperationId,
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(''),
  members: z.array(MemberSpec).min(2).max(32),
})

export const Delivery = z.object({
  id: Receipt.shape.id,
  agentId: Id,
  text: z.string().min(1).max(24000).refine(value => Buffer.byteLength(value, 'utf8') <= 24000, 'Notice must fit in 24 KB.'),
  expiresAt: z.number().int().positive(),
  channel: z.boolean().optional(),
})
export type Delivery = z.infer<typeof Delivery>
export type DeliveryAction = 'send' | 'status' | 'cancel' | 'consume' | 'hold' | 'release'
export interface MemberRuntime { name: string; engine: string; available: boolean; reason?: string; cwd?: string; branch?: string }
export type Actor = { kind: 'owner' } | { kind: 'member'; key: string }
export class TeamError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
export function requireTeam(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new TeamError(code, message)
}
export const sameAddress = (a: Address, b: Address): boolean => a.machineId === b.machineId && a.agentId === b.agentId
export const isTerminalReceipt = (r: Receipt): boolean => ['received', 'started', 'rejected', 'cancelled'].includes(r.state)
