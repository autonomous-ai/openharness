// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT), where it was
// `nixfredWiring.ts`. Ported here without the device firmware frames, Orca watch mode or Hermes parts.

/**
 * The fleet controls, wired as one object the daemon calls at a handful of points. Everything here is
 * built from pure modules (lib/attention, ...) so the daemon's own files change as little as possible:
 *
 *   attention   turn/question/cancel taps → `attention` frames to local windows, `GET /api/attention`
 *   stop-all    cancel every agent turn on this machine (`POST /api/stop-all`, `harness stop-all`)
 *   gate        tool-start → policy verdict (Claude PreToolUse permissionDecision), `harness gate`
 *   spend       submit → pause when caps are hit; ledger persisted per day, `harness spend`
 *   caps        GPU, load, power, heat, lid, toolchains; whether this machine should take a job
 *   subs        every AI plan's weekly use against an even pace, `harness subs`, `GET /api/subscriptions`
 *   dispatch    a bounded job to a linked machine over the daemon's own E2EE relay, `harness dispatch`
 *   clip        clipboard or a file to a linked machine, sealed end to end, `harness clip push`
 *   commands    the `harness <command>` local API behind `POST /api/fleet`
 */
import { existsSync, mkdirSync, promises as fsp, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { AttentionTracker, summarizeAttention, type AttentionRow } from '../lib/attention.js'
import { DEFAULT_POLICY, evaluateToolCall, parsePolicy, type ActionPolicy, type GateVerdict } from '../lib/actionPolicy.js'
import { DEFAULT_CAPS, decideSpend, emptyLedger, parseCaps, recordUsage, type BrakeVerdict, type SpendCaps, type SpendLedger } from '../lib/spendBrake.js'
import { gateHookInstalled, installGateHook, uninstallGateHook } from '../lib/hooks.js'
import { decidePlacement, describeCapabilities, readMachineCapabilities, type MachineCapabilities, type PlacementRequest } from '../lib/machineCapabilities.js'
import { describeSubscriptions, SubscriptionsService, type ProviderId } from './subscriptions/index.js'
import { nodeSubscriptionsDeps } from './subscriptions/nodeDeps.js'
import { DISPATCH_RESULT_TYPE, createRemoteAgentBackend, jobPrompt, type DispatchResult, type JobSpec, type MachineLink, type WireFrame } from './remoteOrchestratorBackend.js'

export interface FleetSessionLike {
  agentId: string
  sessionId: string
  engine: string
  active: boolean
  tmuxPane?: string
  cwd?: string
  transcriptPath?: string
  model?: string | null
  name: string
}

export interface FleetControlDeps {
  dataDir?: string
  machineId: () => string
  machineName: () => string
  sessions: () => FleetSessionLike[]
  /** Push a frame to every local window (desktop). */
  sendLocal: (frame: { type: string; payload: Record<string, unknown> }) => void
  /** Push an error message frame to the web for one agent. */
  sendError: (agentId: string, sessionId: string, message: string) => void
  cancelAgent: (agentId: string, confirmed: boolean) => Promise<boolean>
  tokenUsage: (s: FleetSessionLike) => { totalTokens: number | null } | null
  hookPort: () => number
  now?: () => number
  /** Write to this machine's clipboard (default: wl-copy, xclip or pbcopy, whichever is present). */
  clipWrite?: (text: string) => Promise<void>
  /** Where pushed files land (default ~/Downloads/harness-drop or HARNESS_DROP_DIR). */
  dropDir?: string
}

/** A live, E2EE-terminated link to one linked machine, as the daemon's relay pool hands it out. */
export interface RelayLink {
  send(frame: WireFrame): Promise<void>
  onFrame(cb: (frame: WireFrame) => void): () => void
  close(): void
}

export interface DispatchRecord {
  id: string
  machineId: string
  job: JobSpec
  startedAt: number
  finishedAt: number | null
  agentId: string | null
  result: DispatchResult | null
  error: string | null
}

const DISPATCH_RESULT_RE = /DISPATCH_RESULT:\s*(\{[\s\S]*\})/

/**
 * Turn a relay link into the MachineLink the dispatcher library expects, and synthesize the
 * `dispatch_result` frame from the worker's own text: the remote agent prints one
 * `DISPATCH_RESULT: {json}` line, which arrives here as text_delta events; at turn_ended for that
 * agent the line is parsed and re-emitted as if the worker had sent a result frame. No new wire type,
 * no worker-side change, and the relay never sees the plaintext.
 */
export function machineLinkFromRelay(machineId: string, link: RelayLink): MachineLink & { close(): void } {
  const text = new Map<string, string>()
  const listeners = new Set<(f: WireFrame) => void>()
  const emit = (f: WireFrame): void => { for (const cb of listeners) cb(f) }
  const off = link.onFrame((frame) => {
    const p = frame.payload ?? {}
    const agentId = typeof p.agentId === 'string' ? p.agentId : ''
    if (frame.type === 'text_delta' && agentId && typeof p.content === 'string') {
      text.set(agentId, ((text.get(agentId) ?? '') + p.content).slice(-20_000))
    } else if (frame.type === 'turn_ended' && agentId) {
      const m = DISPATCH_RESULT_RE.exec(text.get(agentId) ?? '')
      text.delete(agentId)
      if (m) {
        let parsed: Record<string, unknown> = {}
        try { parsed = JSON.parse(m[1]!) as Record<string, unknown> } catch { parsed = { summary: 'DISPATCH_RESULT line was not valid JSON', ok: false } }
        emit({ type: DISPATCH_RESULT_TYPE, payload: { agentId, ...parsed } })
      }
    }
    emit(frame)
  })
  return {
    machineId,
    send: (frame) => { void link.send(frame) },
    onFrame: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    close: () => { off(); link.close() },
  }
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return null }
}
function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, file)
}

export class FleetControl {
  readonly attention: AttentionTracker
  protected readonly dataDir: string
  protected readonly now: () => number
  private policy: ActionPolicy
  private caps: SpendCaps
  private ledger: SpendLedger
  private capsCache: { at: number; value: MachineCapabilities } | null = null
  /** Subscription meters (ported from Burn Bar): weekly used, banked, reset, next plan to use. */
  readonly subs: SubscriptionsService
  private subsTimer: NodeJS.Timeout | null = null
  private relayLink: ((machineId: string) => Promise<RelayLink>) | null = null
  private readonly dispatches = new Map<string, DispatchRecord>()

  /** Installed by the daemon once its relay pool exists (it is built after this object). */
  setRelayLink(fn: (machineId: string) => Promise<RelayLink>): void { this.relayLink = fn }

  constructor(protected readonly deps: FleetControlDeps) {
    this.now = deps.now ?? Date.now
    this.dataDir = deps.dataDir ?? env.ADAPTER_DATA_DIR
    mkdirSync(this.dataDir, { recursive: true })
    this.attention = new AttentionTracker(this.now)
    this.policy = this.loadPolicy()
    this.caps = this.loadCaps()
    this.ledger = readJson<SpendLedger>(this.file('spend-ledger.json')) ?? emptyLedger(this.now())
    this.attention.onChange(() => this.pushAttention())
    // Subscription meters: one pass a minute (each network provider is asked at most every 4 min), so
    // the attention payload's compact block stays fresh for the bar; HARNESS_SUBS_WATCH=0 turns it off.
    this.subs = new SubscriptionsService(nodeSubscriptionsDeps(this.dataDir))
    if (process.env.HARNESS_SUBS_WATCH !== '0' && !process.env.VITEST) {
      this.subsTimer = setInterval(() => { void this.pollSubscriptions() }, Number(process.env.HARNESS_SUBS_MS) || 60_000)
      this.subsTimer.unref()
      setTimeout(() => { void this.pollSubscriptions() }, 2_000).unref()
    }
  }

  /** Collect every enabled subscription. Never throws. */
  async pollSubscriptions(force = false): Promise<unknown> {
    try {
      return await this.subs.collect(force)
    } catch (e) {
      console.log(`[subs] collect failed: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  protected file(name: string): string { return join(this.dataDir, name) }

  // ── attention ───────────────────────────────────────────────────────────────────────────────────

  snapshot(): AttentionRow[] { return this.attention.snapshot(this.deps.sessions(), this.deps.machineName()) }

  attentionPayload(): Record<string, unknown> {
    // Each agent carries the name of the first policy lane its name matches (planner, publisher ...),
    // so the bar can show the role beside the state.
    const lanes = this.policy.lanes ?? []
    const agents = this.snapshot().map((row) => {
      const spent = this.ledger.agents[row.agentId]
      const cap = this.caps.enabled ? this.caps.perAgentUsd : null
      // Spend rides on the row so the bar can draw it as the ring's outer arc: fraction of the
      // per-agent cap when one is set, else null (no arc).
      const spend = spent ? { usd: Number(spent.usd.toFixed(2)), tokens: spent.input + spent.output, fraction: cap ? Math.min(1.5, spent.usd / cap) : null } : null
      return { ...row, lane: lanes.find((l) => { try { return new RegExp(l.agent, 'i').test(row.name) } catch { return false } })?.name ?? null, spend }
    })
    return { machineId: this.deps.machineId(), hostname: this.deps.machineName(), at: this.now(), summary: summarizeAttention(agents), agents, subscriptions: this.subs?.compact() ?? null }
  }

  /** Every local window hears each real transition; the bar widget polls `GET /api/attention` instead. */
  protected pushAttention(): void {
    this.deps.sendLocal({ type: 'attention', payload: this.attentionPayload() })
  }

  // ── gate ────────────────────────────────────────────────────────────────────────────────────────

  private loadPolicy(): ActionPolicy {
    const raw = readJson<unknown>(this.file('action-policy.json'))
    if (raw === null) return DEFAULT_POLICY
    const parsed = parsePolicy(raw)
    if (parsed.ok) return parsed.policy
    console.error(`[gate] action-policy.json ignored: ${parsed.problems.join('; ')}`)
    return DEFAULT_POLICY
  }

  /** A tool call is about to run: classify it. Only reached when `harness gate install` added the hook. */
  gate(sessionId: string, agentId: string, toolName: string, input: unknown): GateVerdict {
    const agentName = this.deps.sessions().find((s) => s.agentId === agentId)?.name ?? ''
    const verdict = evaluateToolCall(this.policy, toolName, input, agentName)
    if (verdict.decision !== 'allow') {
      console.log(`[gate] ${agentId} ${sessionId} ${toolName} → ${verdict.decision} (${verdict.rule})`)
      if (verdict.decision === 'ask') this.attention.question(agentId, true, verdict.reason)
    }
    return verdict
  }

  gateStatus(): Record<string, unknown> {
    return { installed: gateHookInstalled(), enabled: this.policy.enabled, rules: this.policy.rules.length, file: this.file('action-policy.json'), fileExists: existsSync(this.file('action-policy.json')) }
  }

  gateInit(): string { const f = this.file('action-policy.json'); if (!existsSync(f)) writeJson(f, DEFAULT_POLICY); this.policy = this.loadPolicy(); return f }

  // ── spend ───────────────────────────────────────────────────────────────────────────────────────

  private loadCaps(): SpendCaps {
    const raw = readJson<unknown>(this.file('spend-caps.json'))
    if (raw === null) return DEFAULT_CAPS
    const parsed = parseCaps(raw)
    if (parsed.ok) return parsed.caps
    console.error(`[spend] spend-caps.json ignored: ${parsed.problems.join('; ')}`)
    return DEFAULT_CAPS
  }

  /** Record what this agent has used so far, then decide whether its next turn may run. */
  spendCheck(s: FleetSessionLike): BrakeVerdict {
    const usage = this.deps.tokenUsage(s)
    const total = usage?.totalTokens ?? 0
    // The engines report a total; treat a fifth as output, which is where most of the money goes.
    this.ledger = recordUsage(this.ledger, { agentId: s.agentId, model: s.model ?? null, input: Math.round(total * 0.8), output: Math.round(total * 0.2), now: this.now() })
    writeJson(this.file('spend-ledger.json'), this.ledger)
    const verdict = decideSpend(this.caps, this.ledger, s.agentId)
    if (verdict.action !== 'run') console.log(`[spend] ${s.agentId} ${verdict.action}: ${verdict.reason}`)
    if (verdict.action === 'pause') {
      this.attention.question(s.agentId, false, `spend brake: ${verdict.reason}`)
      this.deps.sendError(s.agentId, s.sessionId, `Spend brake ${verdict.reason}. Raise the cap with "harness spend set" to continue.`)
    }
    return verdict
  }

  spendStatus(): Record<string, unknown> {
    return { caps: this.caps, day: this.ledger.day, agents: Object.values(this.ledger.agents).map((a) => ({ agentId: a.agentId, model: a.model, tokens: a.input + a.output, usd: Number(a.usd.toFixed(4)) })) }
  }

  spendSet(patch: Partial<SpendCaps>): SpendCaps {
    // Setting a cap is asking for the brake: the default is off (subscription users pay no list price).
    const setsCap = ['perAgentUsd', 'perAgentTokens', 'perDayUsd', 'perDayTokens'].some((k) => typeof (patch as Record<string, unknown>)[k] === 'number')
    const next = { ...this.caps, ...(setsCap && patch.enabled === undefined ? { enabled: true } : {}), ...patch, version: 1 as const }
    const parsed = parseCaps(next)
    if (!parsed.ok) throw new Error(parsed.problems.join('; '))
    this.caps = parsed.caps
    writeJson(this.file('spend-caps.json'), this.caps)
    return this.caps
  }

  // ── machine capabilities ───────────────────────────────────────────────────────────────────────

  async capabilities(maxAgeMs = 30_000): Promise<MachineCapabilities> {
    if (this.capsCache && this.now() - this.capsCache.at < maxAgeMs) return this.capsCache.value
    const value = await readMachineCapabilities()
    this.capsCache = { at: this.now(), value }
    return value
  }

  placement(req: PlacementRequest): Promise<{ ok: boolean; reasons: string[]; caps: string }> {
    return this.capabilities().then((caps) => ({ ...decidePlacement(caps, req), caps: describeCapabilities(caps) }))
  }

  // ── clipboard and file drop between paired machines ────────────────────────────────────────────

  private async clipWrite(text: string): Promise<void> {
    if (this.deps.clipWrite) return this.deps.clipWrite(text)
    const { spawn } = await import('node:child_process')
    const candidates: Array<[string, string[]]> = process.platform === 'darwin' ? [['pbcopy', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]]
    for (const [cmd, args] of candidates) {
      const ok = await new Promise<boolean>((resolve) => {
        const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] })
        child.on('error', () => resolve(false))
        child.on('exit', (code) => resolve(code === 0))
        child.stdin.end(text)
      })
      if (ok) return
    }
    throw new Error('no clipboard tool (wl-copy, xclip or pbcopy) worked')
  }

  /** A paired machine pushed text or a file here. Text goes to the clipboard; a file lands in the drop folder. */
  async clipReceive(push: { text?: string; file?: { name: string; base64: string }; from: string }): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
    try {
      if (push.file) {
        const dir = this.deps.dropDir ?? process.env.HARNESS_DROP_DIR ?? join(process.env.HOME ?? '/tmp', 'Downloads', 'harness-drop')
        await fsp.mkdir(dir, { recursive: true })
        // Basename only, then a conservative character set, then no leading dots: a name can never
        // climb out of the drop folder or hide as a dotfile.
        const base = push.file.name.split(/[\\/]/).filter(Boolean).pop() ?? 'file'
        const safe = base.replace(/[^\w.@ -]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file'
        let target = join(dir, safe)
        for (let i = 1; existsSync(target); i += 1) target = join(dir, safe.replace(/(\.[^.]*)?$/, `-${i}$1`))
        await fsp.writeFile(target, Buffer.from(push.file.base64, 'base64'))
        console.log(`[clip] file from ${push.from} -> ${target}`)
        return { ok: true, detail: target }
      }
      if (push.text !== undefined) {
        await this.clipWrite(push.text)
        console.log(`[clip] text from ${push.from}: ${push.text.length} chars`)
        return { ok: true, detail: `${push.text.length} chars on the clipboard` }
      }
      return { ok: false, error: 'CLIP_EMPTY' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Push text or a file to a linked machine over the relay link; waits for its reply. */
  async clipPush(machineId: string, push: { text?: string; file?: { name: string; base64: string } }, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    if (!this.relayLink) throw new Error('clip push is not available: no relay link')
    const link = await this.relayLink(machineId)
    const requestId = `clip-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    try {
      const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error(`no reply from ${machineId} in ${timeoutMs} ms`)) }, timeoutMs)
        const off = link.onFrame((f) => {
          if (f.type === 'clip_push_result' && f.payload.requestId === requestId) { clearTimeout(timer); off(); resolve(f.payload) }
        })
      })
      await link.send({ type: 'clip_push', payload: { requestId, ...push, from: this.deps.machineName() } })
      const out = await reply
      console.log(`[clip] push to ${machineId}: ${push.file ? push.file.name : `${push.text?.length ?? 0} chars`} -> ${String(out.error ?? out.detail ?? 'ok')}`)
      return out
    } finally { link.close() }
  }

  // ── fleet dispatcher ───────────────────────────────────────────────────────────────────────────

  /** Hand a bounded job to a linked machine; returns at once with a record that fills in as it runs. */
  async dispatch(machineId: string, job: JobSpec): Promise<DispatchRecord> {
    if (!this.relayLink) throw new Error('dispatch is not available: no relay link')
    const id = `d-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    job = { ...job, machineId }
    const record: DispatchRecord = { id, machineId, job, startedAt: this.now(), finishedAt: null, agentId: null, result: null, error: null }
    this.dispatches.set(id, record)
    console.log(`[dispatch] ${id} -> ${machineId}: ${job.brief.slice(0, 120)}`)
    void (async () => {
      let link: (MachineLink & { close(): void }) | null = null
      try {
        link = machineLinkFromRelay(machineId, await this.relayLink!(machineId))
        const backend = createRemoteAgentBackend(link, { now: this.now })
        const created = await backend.create({ engine: job.engine, cwd: job.repo, prompt: jobPrompt(job), branchName: job.branchName, ...(job.dsh ? { dsh: job.dsh } : {}) })
        record.agentId = created.agentId
        record.result = await backend.awaitResult(created.agentId, { timeoutMs: job.timeoutMs ?? 60 * 60 * 1000 })
      } catch (err) {
        record.error = err instanceof Error ? err.message : String(err)
      } finally {
        record.finishedAt = this.now()
        link?.close()
        console.log(`[dispatch] ${id} done: ${(record.error ?? record.result?.summary ?? '').slice(0, 300)}`)
        void fsp.appendFile(this.file('dispatches.jsonl'), JSON.stringify(record) + '\n').catch(() => {})
      }
    })()
    return record
  }

  // ── panic stop ─────────────────────────────────────────────────────────────────────────────────

  async stopAll(exceptAgentId: string | null): Promise<{ cancelled: string[] }> {
    const cancelled: string[] = []
    for (const s of this.deps.sessions()) {
      if (!s.active || s.agentId === exceptAgentId) continue
      try { if (await this.deps.cancelAgent(s.agentId, true)) cancelled.push(s.agentId) } catch { /* next */ }
      this.attention.cancelled(s.agentId)
    }
    console.log(`[fleet] panic stop: cancelled ${cancelled.length} agent(s), kept ${exceptAgentId ?? 'none'}`)
    return { cancelled }
  }

  // ── the local command surface (`POST /api/fleet`) ──────────────────────────────────────────────

  async command(action: string, args: Record<string, unknown>): Promise<unknown> {
    const str = (k: string): string => (typeof args[k] === 'string' ? args[k] as string : '')
    switch (action) {
      case 'attention': return this.attentionPayload()
      case 'stop-all': return this.stopAll(str('except') || null)
      case 'gate-status': return this.gateStatus()
      case 'gate-init': return { file: this.gateInit() }
      case 'gate-install': return { result: installGateHook(this.deps.hookPort()), ...this.gateStatus() }
      case 'gate-uninstall': return { result: uninstallGateHook(), ...this.gateStatus() }
      case 'gate-reload': this.policy = this.loadPolicy(); return this.gateStatus()
      case 'spend-status': return this.spendStatus()
      case 'spend-set': {
        const patch: Partial<SpendCaps> = {}
        for (const k of ['perAgentUsd', 'perAgentTokens', 'perDayUsd', 'perDayTokens', 'warnAt'] as const) {
          if (args[k] === null) patch[k] = null as never
          else if (typeof args[k] === 'number') patch[k] = args[k] as never
        }
        if (typeof args.enabled === 'boolean') patch.enabled = args.enabled
        return { caps: this.spendSet(patch) }
      }
      case 'capabilities': return { ...(await this.capabilities(0)), line: describeCapabilities(await this.capabilities()) }
      case 'placement': return this.placement(args as PlacementRequest)
      case 'subs': { const r = await this.subs.collect(args.force === true || args.force === 'true'); return { ...r, lines: describeSubscriptions(r) } }
      case 'dispatch': {
        const job: JobSpec = { machineId: str('machine'), brief: str('brief'), repo: str('repo'), engine: str('engine') || 'claude', branchName: str('branch') || `dispatch/${this.now().toString(36)}`, ...(str('dsh') ? { dsh: str('dsh') } : {}) }
        if (!job.brief || !job.repo || !str('machine')) throw new Error('dispatch needs machine, repo and brief')
        return this.dispatch(str('machine'), job)
      }
      case 'dispatches': return { dispatches: [...this.dispatches.values()].sort((a, b) => b.startedAt - a.startedAt) }
      case 'clip-push': {
        const file = args.file && typeof args.file === 'object' ? args.file as { name: string; base64: string } : undefined
        const text = typeof args.text === 'string' ? args.text : undefined
        if (!str('machine') || (!file && text === undefined)) throw new Error('clip-push needs machine and text or file')
        return this.clipPush(str('machine'), { ...(text !== undefined ? { text } : {}), ...(file ? { file } : {}) })
      }
      case 'subs-set': {
        const on = args.enabled === true || args.enabled === 'on' || args.enabled === 'true'
        await this.subs.setEnabled(str('id') as ProviderId, on)
        const r = await this.subs.collect(true)
        return { ...r, lines: describeSubscriptions(r) }
      }
      default: throw new Error(`unknown fleet action: ${action}`)
    }
  }
}

export type { AttentionRow, GateVerdict, BrakeVerdict }
