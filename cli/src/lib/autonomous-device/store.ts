import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { AgentCreationReceipts, creationFingerprint, type AgentCreationOutcome } from '../agentCreationReceipt.js'
import { readPrivateStateFile, secureStateDirectory } from '../secureState.js'
import { DeviceOperationSchema, DeviceStoreError, DeviceStoreRequestSchema, type DeviceOperation, type PrepareRequest } from './storeContract.js'

export interface StoreAgent {
  agentId: string; machineId: string; packageId: string | null; engine: string; workspace: string | null
  state: string; runtime: 'starting' | 'ready' | 'unavailable'; error?: string
}
export interface StorePackage {
  packageId: string; name: string; description: string; category: string | null; engine: string | null
  installed: boolean; catalog: boolean; verified: boolean; viewerPackageId: string | null
  installAllowed: boolean; version: string | null; broken: string | null
}
export interface DeviceStoreDependencies {
  directory: string; machineId: string
  packages(): Promise<StorePackage[]>
  install(id: string, progress: (phase: string) => void): Promise<{ ok: boolean; error?: string; detail?: string }>
  doctor(id: string): Promise<{ ok: boolean; checked: boolean; lines: string[] }>
  workspace(request: PrepareRequest['workspace'], label: string): Promise<string>
  create(packageId: string, cwd: string): Promise<AgentCreationOutcome>
  agents(): StoreAgent[]
  now?: () => number
}
const JournalSchema = z.strictObject({
  version: z.literal(1), owner: z.string(), fingerprint: z.string(), operation: DeviceOperationSchema,
})
type Journal = z.infer<typeof JournalSchema>
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const active = (op: DeviceOperation) => op.state === 'accepted' || op.state === 'running'
const bounded = (s: string) => s.slice(0, 1000)

/** A durable prepare intent is never re-executed on timeout, reconnect, or restart.
 * The existing creation receipt resolves the crash gap between spawning and journaling agentId.
 * Progress is polled through operation.get; no new transport/event delivery semantics are needed.
 */
export class AutonomousDeviceStore {
  private readonly receipts: AgentCreationReceipts
  private readonly live = new Map<string, Journal>()
  private readonly installs = new Map<string, Promise<{ ok: boolean; error?: string; detail?: string }>>()
  private readonly checks = new Map<string, { state: 'passed' | 'failed' | 'unknown'; checkedAt: number; version: string | null; lines: string[] }>()
  private readonly revoked = new Set<string>()
  private readonly workspaces = new Map<string, string>()
  private readonly now: () => number
  constructor(private readonly deps: DeviceStoreDependencies) {
    this.receipts = new AgentCreationReceipts(join(deps.directory, 'creations'))
    this.now = deps.now ?? Date.now
  }
  private file(id: string) { return join(this.deps.directory, `${id}.json`) }
  private save(row: Journal, exclusive = false): void {
    secureStateDirectory(this.deps.directory)
    const file = this.file(row.operation.operationId)
    const target = exclusive ? file : `${file}.${randomUUID()}.tmp`
    let opened = false
    try {
      const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      opened = true
      try { writeFileSync(fd, JSON.stringify(row)); fsyncSync(fd) } finally { closeSync(fd) }
      if (!exclusive) renameSync(target, file)
      const dir = openSync(this.deps.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { fsyncSync(dir) } finally { closeSync(dir) }
    } finally { if (!exclusive && opened) rmSync(target, { force: true }) }
  }
  private read(id: string): Journal | null {
    if (this.live.has(id)) return this.live.get(id)!
    try {
      const row = JournalSchema.parse(JSON.parse(readPrivateStateFile(this.file(id), 32_768)))
      if (row.operation.operationId !== id || row.operation.machineId !== this.deps.machineId) throw new Error('Journal identity mismatch')
      return row
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new DeviceStoreError('STORAGE_FAILED', 'Preparation state cannot be read safely. Inspect this machine; do not retry with a new key.')
    }
  }
  private change(row: Journal, patch: Partial<DeviceOperation>): void {
    const next = { ...row, operation: { ...row.operation, ...patch, updatedAt: this.now() } }
    this.save(next) // persist before exposing progress or advancing to another side effect
    row.operation = next.operation
  }
  private action(row: Journal, code: string, message: string, guidance: string): void {
    this.change(row, { state: 'needs_user_action', error: { code, message: bounded(message) }, guidance })
  }
  private authorized(row: Journal): void {
    if (this.revoked.has(row.operation.operationId)) throw new DeviceStoreError('REVOKED', 'Pairing was revoked. No further preparation steps will run.')
  }
  revoke(deviceId: string): void {
    for (const row of this.live.values()) if (row.owner === hash(deviceId)) this.revoked.add(row.operation.operationId)
  }

  private lastPreparation(packageId: string) {
    const op = [...this.live.values()].map(r => r.operation).filter(o => o.packageId === packageId).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    return op ? { state: op.state, phase: op.phase, error: op.error, updatedAt: op.updatedAt } : null
  }
  private async listing() {
    return (await this.deps.packages()).map(p => ({ ...p,
      // Descriptive evidence, not a claim that the engine/app is logged in or usable.
      capabilities: { source: 'package_metadata' as const, description: p.description, category: p.category },
      requirements: { engine: p.engine, viewerPackageId: p.viewerPackageId, applications: null,
        note: 'Application requirements are not structured in the manifest. Preparation runs package and viewer doctors.' },
      lastPreparation: this.lastPreparation(p.packageId),
      installation: this.installs.has(p.packageId) ? 'installing' : p.broken ? 'broken' : p.installed ? 'installed' : 'not_installed',
      readiness: { ...(p.installed && this.checks.get(p.packageId)?.version === p.version ? this.checks.get(p.packageId) : undefined),
        state: !p.installed ? 'not_installed' : p.broken ? 'failed' : this.checks.get(p.packageId)?.version === p.version ? this.checks.get(p.packageId)!.state : 'unknown',
        scope: 'package_doctor', engineAuthentication: 'unknown', taskSuccess: 'unknown' },
    }))
  }
  async request(deviceId: string, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const parsed = DeviceStoreRequestSchema.safeParse(raw)
    if (!parsed.success) throw new DeviceStoreError('INVALID_REQUEST', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 1000))
    const req = parsed.data
    if (req.type === 'operation.get') return { operation: this.get(deviceId, req.operationId) }
    if (req.type === 'agent.prepare') {
      if (req.machineId !== this.deps.machineId) throw new DeviceStoreError('MACHINE_MISMATCH', 'Only the paired machine is available')
      return this.prepare(deviceId, req)
    }
    const packages = await this.listing()
    if (req.type === 'store.inspect') {
      const item = packages.find(p => p.packageId === req.packageId)
      if (!item) throw new DeviceStoreError('PACKAGE_NOT_FOUND', 'Package is not in the catalog or installed on this machine')
      const candidates = this.deps.agents().filter(a => a.packageId === req.packageId)
      return { machineId: this.deps.machineId, package: item, candidates: candidates.slice(0, 5), candidatesTruncated: candidates.length > 5 }
    }
    const terms = (req.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const matches = packages.filter(p => terms.every(t => `${p.packageId} ${p.name} ${p.description} ${p.category ?? ''}`.toLowerCase().includes(t)))
    return { machineId: this.deps.machineId, packages: matches.slice(req.offset, req.offset + req.limit),
      nextOffset: req.offset + req.limit < matches.length ? req.offset + req.limit : null }
  }
  private prepare(deviceId: string, req: PrepareRequest): Record<string, unknown> {
    const owner = hash(deviceId)
    const operationId = hash(`${deviceId}\0${req.idempotencyKey}`)
    const fingerprint = creationFingerprint({ ...req, requestId: null })
    const prior = this.read(operationId)
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new DeviceStoreError('IDEMPOTENCY_CONFLICT', 'Key already belongs to different preparation parameters')
      return { status: 'duplicate', operation: this.get(deviceId, operationId) }
    }
    if ([...this.live.values()].filter(r => active(r.operation)).length >= 4) throw new DeviceStoreError('BACKPRESSURE', 'Four preparations are already running; poll their operations')
    const at = this.now()
    const row: Journal = { version: 1, owner, fingerprint, operation: { operationId, machineId: this.deps.machineId,
      packageId: req.packageId, state: 'accepted', phase: 'accepted', createdAt: at, updatedAt: at,
      agentId: null, workspace: null, error: null, guidance: null, doctor: [], taskDispatched: false, engineAuthentication: 'unknown' } }
    try { this.save(row, true) } catch { throw new DeviceStoreError('STORAGE_FAILED', 'Could not reserve preparation. Retry only with the same key.') }
    this.live.set(operationId, row)
    // Detach before any network, doctor or process work. A transport timeout cannot cancel this job.
    void Promise.resolve().then(() => this.run(row, req)).catch(error => {
      try {
        this.action(row, error instanceof DeviceStoreError ? error.code : 'PREPARATION_UNCONFIRMED',
          error instanceof Error ? error.message : 'Preparation could not be confirmed',
          'Inspect the operation and Harness on this machine before starting a new preparation. Do not automatically retry with a new key.')
      } catch {
        row.operation = { ...row.operation, state: 'needs_user_action', error: { code: 'STORAGE_FAILED', message: 'Progress could not be persisted; inspect this machine before retrying.' } }
      }
    }).finally(() => {
      for (const [cwd, owner] of this.workspaces) if (owner === operationId) this.workspaces.delete(cwd)
    })
    return { status: 'accepted', operation: structuredClone(row.operation) }
  }
  private async run(row: Journal, req: PrepareRequest): Promise<void> {
    this.authorized(row)
    this.change(row, { state: 'running', phase: 'install' })
    let pkg = (await this.deps.packages()).find(p => p.packageId === req.packageId)
    this.authorized(row)
    if (!pkg) { this.change(row, { state: 'failed', error: { code: 'PACKAGE_NOT_FOUND', message: 'Package is not available on this machine' } }); return }
    if (!pkg.installed) {
      if (!pkg.installAllowed) {
        this.action(row, 'PACKAGE_REVIEW_REQUIRED', 'This package or a dependency requires local review before executing its setup.', 'Review and install it in Harness Store on this machine, then deliberately submit a new preparation key.'); return
      }
      let installing = this.installs.get(pkg.packageId)
      if (!installing) {
        // Store's own lock also covers installs/updates originating outside this facade.
        installing = this.deps.install(pkg.packageId, phase => {
          if (phase === 'clone' || phase === 'setup' || phase === 'doctor') {
            if (row.operation.phase !== phase) this.change(row, { phase })
          }
        }).finally(() => this.installs.delete(req.packageId))
        this.installs.set(pkg.packageId, installing)
      }
      const result = await installing
      this.authorized(row)
      if (!result.ok) {
        this.action(row, result.error ?? 'INSTALL_FAILED', result.detail ?? 'Installation failed', 'Open this package in Harness Store on this machine and resolve the reported install/setup/doctor error. A new key is a deliberate new attempt.'); return
      }
      pkg = (await this.deps.packages()).find(p => p.packageId === req.packageId)
      if (!pkg?.installed) throw new DeviceStoreError('INSTALL_UNCONFIRMED', 'Installation returned without a usable installed package')
    }
    if (pkg.broken) { this.action(row, 'PACKAGE_BROKEN', pkg.broken, 'Repair this installation in Harness Store.'); return }
    this.authorized(row)
    this.change(row, { phase: 'doctor' })
    const doctor = await this.deps.doctor(req.packageId)
    this.authorized(row)
    const lines = doctor.lines.slice(-10).map(l => l.slice(0, 400))
    this.checks.set(req.packageId, { state: !doctor.ok ? 'failed' : doctor.checked ? 'passed' : 'unknown', checkedAt: this.now(), version: pkg.version, lines })
    this.change(row, { doctor: lines })
    if (!doctor.ok) { this.action(row, 'DEPENDENCY_NOT_READY', lines.join('\n') || 'A package or viewer doctor failed', 'Resolve the doctor findings on this machine, then submit a new preparation key.'); return }
    this.change(row, { phase: 'workspace' })
    const cwd = await this.deps.workspace(req.workspace, pkg.name)
    this.authorized(row)
    // Never repurpose or materialize over another live session's project.
    if (this.workspaces.has(cwd) || this.deps.agents().some(a => a.workspace === cwd)) {
      this.action(row, 'WORKSPACE_IN_USE', 'A live agent already uses this workspace', 'Inspect Store candidates and explicitly use that agent with turn.send, or prepare a new workspace.'); return
    }
    this.workspaces.set(cwd, row.operation.operationId)
    this.change(row, { phase: 'create', workspace: cwd })
    const result = await this.receipts.run(row.operation.operationId, row.fingerprint, async () => {
      this.authorized(row)
      return this.deps.create(req.packageId, cwd)
    })
    if (result.state === 'created') {
      this.change(row, { phase: 'launch', agentId: result.agentId, guidance: 'Waiting for the native engine conversation. Open this agent in Harness if login or trust prompts need attention.' })
    } else if (result.state === 'failed') {
      this.action(row, result.error, result.detail ?? result.error, 'Open Harness on this machine to resolve the engine/workspace error.'); return
    } else {
      this.action(row, 'CREATION_UNCONFIRMED', 'Agent creation may have executed; it will not be repeated', 'Inspect existing agents on this machine before starting anything else.'); return
    }
    this.authorized(row)
    this.refreshRuntime(row)
  }
  private refreshRuntime(row: Journal): void {
    if (!row.operation.agentId || (row.operation.state !== 'running' && row.operation.state !== 'ready'
      && !['ENGINE_ACTION_REQUIRED', 'AGENT_UNAVAILABLE'].includes(row.operation.error?.code ?? ''))) return
    const agent = this.deps.agents().find(a => a.agentId === row.operation.agentId)
    if (agent?.packageId !== row.operation.packageId || agent?.workspace !== row.operation.workspace) {
      this.action(row, 'AGENT_UNAVAILABLE', 'The prepared agent is missing or its package/workspace changed', 'Inspect this agent in Harness; preparation never changes an existing session.'); return
    }
    if (agent.runtime === 'ready') {
      if (row.operation.state !== 'ready') this.change(row, { state: 'ready', phase: 'complete', error: null, guidance: null })
    } else if (agent.runtime === 'starting' && row.operation.state === 'ready') {
      this.change(row, { state: 'running', phase: 'launch', guidance: 'The engine is starting again; wait for its native conversation before sending a task.' })
    } else if (agent.runtime === 'unavailable' || this.now() - row.operation.updatedAt > 10 * 60_000) {
      this.action(row, 'ENGINE_ACTION_REQUIRED', agent.error ?? 'Engine launch is not ready; login, trust or installation may require interaction.', 'Open the returned agent in Harness and complete its engine prompts. Do not create another agent automatically.')
    }
  }
  get(deviceId: string, operationId: string): DeviceOperation {
    const row = this.read(operationId)
    if (!row || row.owner !== hash(deviceId)) throw new DeviceStoreError('OPERATION_NOT_FOUND', 'No preparation for this device has that ID')
    if (active(row.operation) && !this.live.has(operationId)) {
      const receipt = this.receipts.status(operationId)
      if (receipt.state === 'created' && row.operation.workspace) {
        this.change(row, { agentId: receipt.agentId, phase: 'launch', state: 'running' })
        this.live.set(operationId, row)
      } else {
        this.action(row, 'RECOVERY_REQUIRED', 'Daemon restarted during preparation; no install or creation will be replayed.', 'Inspect Harness and the workspace on this machine. Retry this same key to read its status; only deliberately use a new key after reconciling any side effects.')
      }
    }
    this.refreshRuntime(row)
    return structuredClone(row.operation)
  }
}
