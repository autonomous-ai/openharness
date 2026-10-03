// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

/**
 * The fleet dispatcher's building block: an orchestrator-shaped backend (create, send, cancel,
 * agent) that runs on ANOTHER linked machine over the existing E2EE relay session. It speaks the
 * wire types the daemon already has (`agent_create`, `message`, `cancel`, `session_get`) plus one
 * new one the worker side emits when a dispatched job finishes: `dispatch_result`.
 *
 * `MachineLink` is the seam: the daemon wires it to a RemoteRelayPool session; tests script it.
 */
import { decidePlacement, type MachineCapabilities, type PlacementRequest } from '../lib/machineCapabilities.js'

export interface WireFrame { type: string; payload: Record<string, unknown> }

export interface MachineLink {
  machineId: string
  send(frame: WireFrame): void
  onFrame(cb: (frame: WireFrame) => void): () => void
}

export interface RemoteCreateInput {
  engine: string
  cwd: string
  prompt: string
  dsh?: string
  branchName?: string
  creationId?: string
}

export interface DispatchResult {
  agentId: string
  branch?: string
  diffStat?: string
  summary: string
  ok: boolean
}

export interface RemoteAgentBackend {
  machineId: string
  create(input: RemoteCreateInput): Promise<{ agentId: string }>
  send(agentId: string, text: string): Promise<void>
  cancel(agentId: string): Promise<void>
  agent(agentId: string): Promise<{ status: string; summary?: string } | null>
  awaitResult(agentId: string, opts?: { timeoutMs?: number }): Promise<DispatchResult>
  close(): void
}

export interface BackendOptions {
  timeoutMs?: number
  requestId?: () => string
  now?: () => number
}

/** The worker side emits this when a dispatched agent reports done. Exported so the daemon reuses it. */
export const DISPATCH_RESULT_TYPE = 'dispatch_result'

class Timeout extends Error { constructor(what: string, ms: number) { super(`${what} timed out after ${ms} ms`) } }

export function createRemoteAgentBackend(link: MachineLink, opts: BackendOptions = {}): RemoteAgentBackend {
  const timeoutMs = opts.timeoutMs ?? 30_000
  let seq = 0
  const nextId = opts.requestId ?? (() => `rq-${link.machineId}-${++seq}`)
  const pending = new Map<string, { resolve: (p: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const results = new Map<string, DispatchResult>()
  const waiters = new Map<string, Array<(r: DispatchResult) => void>>()

  const off = link.onFrame((frame) => {
    if (frame.type === DISPATCH_RESULT_TYPE) {
      const p = frame.payload
      const agentId = String(p.agentId ?? '')
      if (!agentId) return
      const r: DispatchResult = {
        agentId, summary: String(p.summary ?? ''), ok: p.ok !== false,
        ...(typeof p.branch === 'string' ? { branch: p.branch } : {}),
        ...(typeof p.diffStat === 'string' ? { diffStat: p.diffStat } : {}),
      }
      results.set(agentId, r)
      for (const w of waiters.get(agentId) ?? []) w(r)
      waiters.delete(agentId)
      return
    }
    if (!frame.type.endsWith('_result')) return
    const rid = frame.payload.requestId
    const key = typeof rid === 'string' ? rid : typeof frame.payload.creationId === 'string' ? frame.payload.creationId : ''
    const p = key ? pending.get(key) : undefined
    if (!p) return
    pending.delete(key)
    clearTimeout(p.timer)
    if (typeof frame.payload.error === 'string') p.reject(new Error(`${frame.type}: ${frame.payload.error}`))
    else p.resolve(frame.payload)
  })

  const rpc = (type: string, payload: Record<string, unknown>, key: string): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(key); reject(new Timeout(type, timeoutMs)) }, timeoutMs)
      pending.set(key, { resolve, reject, timer })
      link.send({ type, payload })
    })

  return {
    machineId: link.machineId,
    async create(input) {
      const creationId = input.creationId ?? nextId()
      const requestId = nextId()
      const payload: Record<string, unknown> = { requestId, creationId, engine: input.engine, cwd: input.cwd, prompt: input.prompt, ...(input.dsh ? { dsh: input.dsh } : {}), ...(input.branchName ? { branchName: input.branchName } : {}) }
      // Correlate by requestId first; a daemon that echoes only creationId still matches.
      const p = rpc('agent_create', payload, requestId)
      pending.set(creationId, pending.get(requestId)!)
      const res = await p
      pending.delete(creationId)
      const agentId = typeof res.agentId === 'string' ? res.agentId : typeof res.id === 'string' ? res.id : ''
      if (!agentId) throw new Error('agent_create_result carried no agentId')
      return { agentId }
    },
    async send(agentId, text) { link.send({ type: 'message', payload: { agentId, content: text } }) },
    async cancel(agentId) { link.send({ type: 'cancel', payload: { agentId } }) },
    async agent(agentId) {
      const requestId = nextId()
      try {
        const res = await rpc('session_get', { requestId, agentId }, requestId)
        const status = typeof res.status === 'string' ? res.status : 'unknown'
        return { status, ...(typeof res.summary === 'string' ? { summary: res.summary } : {}) }
      } catch { return null }
    },
    awaitResult(agentId, o = {}) {
      const done = results.get(agentId)
      if (done) return Promise.resolve(done)
      const ms = o.timeoutMs ?? timeoutMs
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.set(agentId, (waiters.get(agentId) ?? []).filter((w) => w !== onResult))
          reject(new Timeout(`dispatch_result for ${agentId}`, ms))
        }, ms)
        const onResult = (r: DispatchResult) => { clearTimeout(timer); resolve(r) }
        waiters.set(agentId, [...(waiters.get(agentId) ?? []), onResult])
      })
    },
    close() {
      off()
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('link closed')) }
      pending.clear()
    },
  }
}

export interface JobSpec {
  brief: string
  repo: string
  branchName: string
  engine: string
  machineId: string
  dsh?: string
  timeoutMs?: number
}

/** The worker-side brief: what the remote agent is told, and how it is told to report back. */
export function jobPrompt(job: JobSpec): string {
  return [
    `You are a dispatched worker on machine ${job.machineId}. Work only inside this worktree on branch ${job.branchName}.`,
    '', '## Brief', job.brief, '',
    '## When done',
    'Commit your work on this branch. Then print exactly one line starting with DISPATCH_RESULT: followed by JSON',
    '{"summary": "<one paragraph: what changed, what is left, open questions>"}. Do not push.',
  ].join('\n')
}

export async function dispatchJob(backend: RemoteAgentBackend, job: JobSpec): Promise<DispatchResult> {
  const { agentId } = await backend.create({ engine: job.engine, cwd: job.repo, prompt: jobPrompt(job), branchName: job.branchName, ...(job.dsh ? { dsh: job.dsh } : {}) })
  return backend.awaitResult(agentId, { timeoutMs: job.timeoutMs ?? 60 * 60 * 1000 })
}

export interface Candidate { machineId: string; caps: MachineCapabilities }

/** Machines that can take the job, best first (most free VRAM, then lowest load). */
export function placementFilter(candidates: Candidate[], req: PlacementRequest): Array<Candidate & { reasons: string[] }> {
  const ok = candidates
    .map((c) => ({ ...c, ...decidePlacement(c.caps, req) }))
    .filter((c) => c.ok)
    .map(({ ok: _ok, ...c }) => c)
  const freeVram = (c: Candidate) => Math.max(0, ...c.caps.gpus.map((g) => g.vramTotalMb - g.vramUsedMb))
  const loadPerCore = (c: Candidate) => (c.caps.cpu.cores ? c.caps.cpu.load1 / c.caps.cpu.cores : 0)
  return ok.sort((a, b) => freeVram(b) - freeVram(a) || loadPerCore(a) - loadPerCore(b))
}
