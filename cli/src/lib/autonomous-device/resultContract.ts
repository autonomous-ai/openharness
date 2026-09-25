import { z } from 'zod'
const id = z.string().min(1)
const member = z.strictObject({ deliveryId: id, idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) })
const correlation = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('input'), inputs: z.array(member).length(1), engineTurnId: id.optional() }),
  z.strictObject({ scope: z.literal('group'), inputs: z.array(member).min(2).max(64), engineTurnId: id.optional() }),
])
export const DeviceResultPayloadSchema = z.strictObject({
  serverInstanceId: id, resultId: id, correlation,
  outcome: z.enum(['completed', 'failed', 'cancelled']), fullText: z.string().min(1),
})
export const DeviceResultSchema = z.strictObject({
  type: z.literal('event'), kind: z.literal('turn.result'), agentId: id,
  serverInstanceId: id.optional(), machineId: id.optional(), eventId: z.number().int().positive().optional(),
  payload: DeviceResultPayloadSchema,
})
