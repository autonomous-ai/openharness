/**
 * What the person has said yes to (daemons/BRAIN.md, "Security"): the autonomy level this daemon acts at,
 * and the pair.jsonc rules it runs. Both can be changed by something other than the person — the zoo op
 * `zoo.autonomy` goes through the daemon's loopback proxy (any local process that sets `x-adapter-local`
 * can send it), a guest window's `daemon_presence { autonomy }`, a process that writes pair.jsonc — so a
 * change that lets the daemon do MORE takes effect only once the person confirms it at a window:
 *
 *   autonomy  a level above `suggest` (act-on-key, act-within-rules) that was not confirmed before waits
 *             for `daemon_confirm { kind: 'autonomy', nonce }` from a window that displayed the request;
 *             until then the daemon stays at the level it had. Lowering, and watch -> suggest, apply at once.
 *   rules     a pair.jsonc with rules, `"model": true` or anything in `learn` turned on (borrow, export,
 *             agentsMd: daemons/LEARNING.md) whose exact text was not confirmed before waits for
 *             `daemon_confirm { kind: 'rules', nonce }`; until then the file confirmed before applies
 *             (nothing, the first time). A file with nothing in it (or a broken one) applies at once.
 *
 * A confirmed level holds only under the consent it was given in (the zoo's `consent.at`, the `epoch`): once
 * the person has answered the consent question again — withdrawn it and given it back, even while this
 * daemon was not reading — the old yes is void, whatever raised the dial since, and the daemon steps down to
 * `suggest` until they confirm again. A level they took back is never raised again by the yes that follows.
 *
 * Every change is announced (`onEvent`, spoken as a daemon_say). What was confirmed is kept in
 * `ADAPTER_DATA_DIR/pair/confirmed.json` (0600) so a daemon restart does not ask again. A same-user process
 * can write that file too; it can also drive tmux directly — the gate keeps the daemon from being the way
 * such a process reaches further (another machine never takes more than an allow-class answer from here).
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { AUTONOMY_LEVELS, isAutonomy, type Autonomy } from './floor.js'
import { EMPTY_PAIR_CONFIG, type PairConfig } from './rules.js'
import { statusText, type DaemonAction } from './protocol.js'

export type ConfirmKind = 'autonomy' | 'rules'

/** A change waiting for the person's yes, as daemon_state `confirms` lists it and a daemon_say asks it. */
export interface ConfirmRequest {
  id: string
  kind: ConfirmKind
  nonce: string
  line: string
  /** Exactly what a yes turns on: the level and what it lets the daemon do, or the whole pair.jsonc. */
  detail: string
  actions: DaemonAction[]
  at: number
  /** On autonomy: the level asked for. */
  level?: Autonomy
}

export type GateEvent =
  | { type: 'asked'; request: ConfirmRequest }
  | { type: 'changed'; kind: ConfirmKind; line: string }
  | { type: 'dropped'; request: ConfirmRequest; reason: 'declined' | 'replaced' }

export interface GateDeps {
  /** Where confirmations are kept (0600); null keeps them in memory only. */
  file: string | null
  onEvent: (event: GateEvent) => void
  now?: () => number
  newNonce?: () => string
}

const rank = (level: Autonomy): number => AUTONOMY_LEVELS.indexOf(level)
const SUGGEST = rank('suggest')

const WHAT: Record<Autonomy, string> = {
  watch: 'it only watches and tells you; nothing is done for you',
  suggest: 'it proposes, and every action waits for your key',
  'act-on-key': 'it drives harnesses it started without asking (the floor still holds); the rest wait for your key',
  'act-within-rules': 'as act-on-key, and it answers allow-class prompts by your pair.jsonc rules on this machine',
}

const CONFIRM_ACTIONS: DaemonAction[] = [{ key: 'y', label: 'confirm', choice: 'y' }, { key: 'n', label: 'keep it as it is', choice: 'n' }]

export const hashConfig = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Whether pair.jsonc turns on anything the daemon would not do without it. */
const asksForMore = (c: PairConfig): boolean =>
  c.rules.length > 0 || c.model || !!c.learn && (c.learn.borrow || c.learn.export.length > 0 || c.learn.agentsMd.length > 0)

/** What a pair.jsonc turns on, in a few words: `2 rules, model on, learn borrow + export claude`. */
export function configSummary(c: PairConfig): string {
  const learn = c.learn ? [
    ...(c.learn.borrow ? ['borrow'] : []),
    ...(c.learn.export.length ? [`export ${c.learn.export.join('+')}`] : []),
    ...(c.learn.agentsMd.length ? [`AGENTS.md in ${c.learn.agentsMd.length} project${c.learn.agentsMd.length === 1 ? '' : 's'}`] : []),
  ] : []
  return [`${c.rules.length} rule${c.rules.length === 1 ? '' : 's'}`, `model ${c.model ? 'on' : 'off'}`, ...(learn.length ? [`learn ${learn.join(' + ')}`] : [])].join(', ')
}

/**
 * Which daemon is paired, and the level asked for, from the account's zoo (when it is known) or a guest
 * window's presence. Nothing is watched until the person said yes on the first-day consent screen: until
 * then there is no pair (the sensor stays off) and the dial asks for `watch`.
 */
export function pairingFrom(zoo: { known: boolean; pair: string | null; autonomy: Autonomy; consent: boolean; consentAt?: string | null },
  guest: { pair: string | null; autonomy: Autonomy | null; consent: boolean }, fallback: Autonomy): { pair: string | null; autonomy: Autonomy; consented: boolean; epoch: string | null } {
  const consented = zoo.known ? zoo.consent : guest.consent
  // The consent a confirmation belongs to: the zoo's answer's time. A guest window's has none.
  const epoch = zoo.known ? zoo.consentAt ?? null : null
  if (!consented) return { pair: null, autonomy: 'watch', consented, epoch }
  return zoo.known ? { pair: zoo.pair, autonomy: zoo.autonomy, consented, epoch } : { pair: guest.pair, autonomy: guest.autonomy ?? fallback, consented, epoch }
}

/** What was confirmed, and under which consent (`epoch`: the zoo's `consent.at` when it was given). */
interface Saved { autonomy: Autonomy | null; rules: string | null; epoch: string | null }

export class PairGate {
  private requested: Autonomy
  private level: Autonomy
  private saved: Saved = { autonomy: null, rules: null, epoch: null }
  private pending = new Map<ConfirmKind, ConfirmRequest & { config?: PairConfig; hash?: string }>()
  private active: PairConfig = EMPTY_PAIR_CONFIG
  private activeHash: string | null = null
  private seenHash: string | null = null
  private readonly now: () => number
  private readonly newNonce: () => string

  constructor(private readonly deps: GateDeps, initial: Autonomy = 'watch') {
    this.now = deps.now ?? Date.now
    this.newNonce = deps.newNonce ?? (() => randomBytes(9).toString('base64url'))
    this.requested = initial
    this.level = initial
    this.load()
  }

  /** The level the daemon acts at right now. */
  autonomy(): Autonomy { return this.level }

  /** The level the zoo (or a guest window) asks for, which waits for a yes when it is a step up. */
  requestedAutonomy(): Autonomy { return this.requested }

  /** What is waiting for the person's yes. */
  requests(): ConfirmRequest[] {
    return [...this.pending.values()].map(({ config: _c, hash: _h, ...request }) => request)
  }

  // ── autonomy ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * The zoo's (or a guest window's) level changed, or was read again. `keepConfirmed`: the level is held
   * down by something other than the person's dial (no consent yet, the zoo unreadable for a moment), so
   * what they confirmed before still stands when it comes back. `epoch`: the consent this level is asked
   * under (pairingFrom); a different one from the consent a yes was given in voids that yes.
   */
  setRequested(level: Autonomy, opts: { keepConfirmed?: boolean; epoch?: string | null } = {}): void {
    this.requested = level
    if (!opts.keepConfirmed && opts.epoch !== undefined && opts.epoch !== this.saved.epoch) this.newConsent(opts.epoch, level)
    const waiting = this.pending.get('autonomy')
    if (rank(level) <= rank(this.level) || rank(level) <= SUGGEST || this.saved.autonomy === level) {
      if (waiting) this.drop('autonomy', 'replaced')
      // The person lowered it below what they confirmed: raising it again asks again.
      if (!opts.keepConfirmed && this.saved.autonomy && rank(level) < rank(this.saved.autonomy)) {
        this.saved.autonomy = rank(level) > SUGGEST ? level : null
        this.save()
      }
      this.apply(level)
      return
    }
    if (waiting?.level === level) return
    if (waiting) this.drop('autonomy', 'replaced')
    const nonce = this.newNonce()
    const request: ConfirmRequest = {
      id: `confirm:autonomy:${nonce}`, kind: 'autonomy', nonce, level, at: this.now(), actions: CONFIRM_ACTIONS,
      line: `[y/n] let your daemon act at ${level}? it stays at ${this.level} until you say yes`,
      detail: `autonomy ${this.level} -> ${level}\n${level}: ${WHAT[level]}.\nThe floor holds at every level: nothing is deleted, restarted, forked or bypassed; a push, force, rm -rf, sudo, deploy, publish, drop or merge is never approved; only a one-time yes to an allow-class prompt.`,
    }
    this.pending.set('autonomy', request)
    this.deps.onEvent({ type: 'asked', request })
  }

  /**
   * The person answered the consent question again since what was confirmed here (or this is the first
   * consent seen): every yes to a level, and every request still waiting, belonged to the old answer. The
   * daemon steps down to what needs no yes (`level` itself when that is what is asked); setRequested then
   * asks again for anything above it.
   */
  private newConsent(epoch: string | null, level: Autonomy): void {
    this.saved = { ...this.saved, autonomy: null, epoch }
    this.save()
    if (this.pending.has('autonomy')) this.drop('autonomy', 'replaced')
    if (rank(this.level) > SUGGEST) this.apply(rank(level) <= SUGGEST ? level : 'suggest')
  }

  private apply(level: Autonomy): void {
    if (level === this.level) return
    const was = this.level
    this.level = level
    this.deps.onEvent({ type: 'changed', kind: 'autonomy', line: `autonomy ${was} -> ${level}: ${WHAT[level]}.` })
  }

  // ── rules ────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The rules to run: pair.jsonc as last read (`loaded`), once the person confirmed that exact text. Called
   * wherever the config is read; a file seen before costs nothing.
   */
  rules(loaded: { config: PairConfig; text: string | null }): PairConfig {
    const hash = loaded.text === null ? 'missing' : hashConfig(loaded.text)
    if (hash === this.seenHash) return this.active
    this.seenHash = hash
    const config = loaded.config
    const nothing = !!config.error || !asksForMore(config)
    if (nothing || hash === this.saved.rules) {
      if (this.pending.has('rules')) this.drop('rules', 'replaced')
      this.useRules(config, hash)
      return this.active
    }
    if (this.pending.get('rules')?.hash === hash) return this.active
    if (this.pending.has('rules')) this.drop('rules', 'replaced')
    const nonce = this.newNonce()
    const request = {
      id: `confirm:rules:${nonce}`, kind: 'rules' as const, nonce, at: this.now(), actions: CONFIRM_ACTIONS, config, hash,
      line: `[y/n] use pair.jsonc as it is now? ${configSummary(config)}; until you say yes, ${asksForMore(this.active) ? 'what you confirmed before' : 'none of it'}`,
      detail: `pair.jsonc (${configSummary(config)}):\n${loaded.text ?? ''}`,
    }
    this.pending.set('rules', request)
    const { config: _c, hash: _h, ...shown } = request
    this.deps.onEvent({ type: 'asked', request: shown })
    return this.active
  }

  private useRules(config: PairConfig, hash: string): void {
    if (hash === this.activeHash) return
    const had = this.active
    this.active = config
    this.activeHash = hash
    if (!asksForMore(had) && !asksForMore(config)) return
    this.deps.onEvent({ type: 'changed', kind: 'rules', line: `pair.jsonc now applies here: ${configSummary(config)}.` })
  }

  // ── the person's answer ──────────────────────────────────────────────────────────────────────────

  /** `daemon_confirm { kind, nonce, accept }`, already checked to come from a window that showed it. */
  confirm(kind: string, nonce: string, accept: boolean): { ok: true; kind: ConfirmKind } | { ok: false; error: string; detail?: string } {
    if (kind !== 'autonomy' && kind !== 'rules') return { ok: false, error: 'UNKNOWN_KIND' }
    const request = this.pending.get(kind)
    if (!request || request.nonce !== nonce) return { ok: false, error: 'STALE_CONFIRM', detail: 'That request is no longer waiting.' }
    if (!accept) { this.drop(kind, 'declined'); return { ok: true, kind } }
    this.pending.delete(kind)
    if (kind === 'autonomy' && request.level) {
      this.saved.autonomy = request.level
      this.save()
      this.apply(request.level)
    } else if (kind === 'rules' && request.config && request.hash) {
      this.saved.rules = request.hash
      this.save()
      this.useRules(request.config, request.hash)
    }
    return { ok: true, kind }
  }

  private drop(kind: ConfirmKind, reason: 'declined' | 'replaced'): void {
    const request = this.pending.get(kind)
    if (!request) return
    this.pending.delete(kind)
    const { config: _c, hash: _h, ...shown } = request
    this.deps.onEvent({ type: 'dropped', request: shown, reason })
  }

  // ── what was confirmed, across restarts ──────────────────────────────────────────────────────────

  private load(): void {
    const file = this.deps.file
    if (!file) return
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<Saved>
      this.saved = {
        autonomy: isAutonomy(value.autonomy) ? value.autonomy : null,
        rules: typeof value.rules === 'string' && /^([a-f0-9]{64}|missing)$/.test(value.rules) ? value.rules : null,
        epoch: typeof value.epoch === 'string' && value.epoch.length <= 64 ? value.epoch : null,
      }
    } catch { /* nothing confirmed yet */ }
  }

  private save(): void {
    const file = this.deps.file
    if (!file) return
    try {
      if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.saved), { mode: 0o600 })
      renameSync(tmp, file)
    } catch (err) {
      console.warn(`[pair] could not keep what was confirmed: ${statusText(err instanceof Error ? err.message : String(err), 120)}`)
    }
  }
}
