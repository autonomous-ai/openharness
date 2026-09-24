import { z } from 'zod'
import { DSH_ID_RE } from '../../dsh/manifest.js'

/** Device Store v1. Strict, deliberately smaller than the desktop/admin API. */
export const DEVICE_STORE_CAPABILITIES = ['store.list', 'store.inspect', 'agent.prepare', 'operation.get'] as const
const requestId = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/)
const packageId = z.string().max(129).regex(DSH_ID_RE)
const safeText = z.string().min(1).max(4096).regex(/^[^\x00-\x1f\x7f]+$/)
export const WorkspaceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('new'), name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).optional() }),
  z.strictObject({ kind: z.literal('existing'), path: safeText.regex(/^\//, 'Absolute path required') }),
])
export const DeviceStoreRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('store.list'), requestId, query: z.string().max(200).optional(), offset: z.number().int().min(0).max(25000).default(0), limit: z.number().int().min(1).max(10).default(10) }),
  z.strictObject({ type: z.literal('store.inspect'), requestId, packageId }),
  z.strictObject({ type: z.literal('agent.prepare'), requestId, machineId: z.string().min(1).max(200), packageId,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), workspace: WorkspaceSchema }),
  z.strictObject({ type: z.literal('operation.get'), requestId, operationId: z.string().regex(/^[a-f0-9]{64}$/) }),
])
export type PrepareRequest = Extract<z.infer<typeof DeviceStoreRequestSchema>, { type: 'agent.prepare' }>
export const DeviceOperationSchema = z.strictObject({
  operationId: z.string().regex(/^[a-f0-9]{64}$/), machineId: z.string(), packageId: z.string(),
  state: z.enum(['accepted', 'running', 'ready', 'failed', 'needs_user_action']),
  phase: z.enum(['accepted', 'install', 'clone', 'setup', 'doctor', 'workspace', 'create', 'launch', 'complete']),
  createdAt: z.number(), updatedAt: z.number(), agentId: z.string().nullable(), workspace: z.string().nullable(),
  error: z.strictObject({ code: z.string(), message: z.string() }).nullable(),
  guidance: z.string().nullable(), doctor: z.array(z.string()).max(10),
  taskDispatched: z.literal(false),
  engineAuthentication: z.literal('unknown'),
})
export type DeviceOperation = z.infer<typeof DeviceOperationSchema>
export class DeviceStoreError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export const StoreAgentSchema = z.strictObject({
  agentId: z.string(), machineId: z.string(), packageId: z.string().nullable(), engine: z.string(),
  workspace: z.string().nullable(), state: z.string(), runtime: z.enum(['starting', 'ready', 'unavailable']), error: z.string().optional(),
})
export const StorePackageSchema = z.strictObject({
  packageId: z.string(), name: z.string(), description: z.string(), category: z.string().nullable(), engine: z.string().nullable(),
  installed: z.boolean(), catalog: z.boolean(), verified: z.boolean(), viewerPackageId: z.string().nullable(),
  installAllowed: z.boolean(), version: z.string().nullable(), broken: z.string().nullable(),
  capabilities: z.strictObject({ source: z.literal('package_metadata'), description: z.string(), category: z.string().nullable() }),
  requirements: z.strictObject({ engine: z.string().nullable(), viewerPackageId: z.string().nullable(), applications: z.null(), note: z.string() }),
  installation: z.enum(['installing', 'installed', 'not_installed', 'broken']),
  lastPreparation: z.strictObject({ state: DeviceOperationSchema.shape.state, phase: DeviceOperationSchema.shape.phase,
    error: DeviceOperationSchema.shape.error, updatedAt: z.number() }).nullable(),
  readiness: z.strictObject({ state: z.enum(['unknown', 'not_installed', 'passed', 'failed']), scope: z.literal('package_doctor'),
    engineAuthentication: z.literal('unknown'), taskSuccess: z.literal('unknown'), checkedAt: z.number().optional(),
    version: z.string().nullable().optional(), lines: z.array(z.string()).max(10).optional() }),
})
export const DeviceStoreResultSchema = z.union([
  z.strictObject({ type: z.literal('store.list_result'), requestId, machineId: z.string(), packages: z.array(StorePackageSchema).max(10), nextOffset: z.number().int().nullable() }),
  z.strictObject({ type: z.literal('store.inspect_result'), requestId, machineId: z.string(), package: StorePackageSchema, candidates: z.array(StoreAgentSchema).max(5), candidatesTruncated: z.boolean() }),
  z.strictObject({ type: z.literal('agent.prepare_result'), requestId, status: z.enum(['accepted', 'duplicate']), operation: DeviceOperationSchema }),
  z.strictObject({ type: z.literal('operation.get_result'), requestId, operation: DeviceOperationSchema }),
  z.strictObject({ type: z.enum(['store.list_result', 'store.inspect_result', 'agent.prepare_result', 'operation.get_result']), requestId: z.unknown().optional(),
    error: z.strictObject({ code: z.string(), message: z.string() }) }),
])
