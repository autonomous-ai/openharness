// The desktop owns identity and emotions; USB only renders this bounded state.
// Never forward this message to a machine relay or the account backend.
export const COMPANION_EMOTIONS = [
  'content', 'curious', 'bored', 'playful', 'working', 'focused', 'happy', 'excited',
  'proud', 'relieved', 'frustrated', 'angry', 'sad', 'tired', 'exhausted',
  'attentive', 'asleep', 'offline', 'listening', 'affectionate', 'hatching',
] as const
export type CompanionEmotion = typeof COMPANION_EMOTIONS[number]
export interface CompanionFeeling {
  emotion: CompanionEmotion; reason: string; intensity: number
  reactionId?: string; remainingMs?: number
}
export interface CompanionState {
  v: 1; window: string; epoch: number; revision: number
  enabled: boolean; foreground: boolean
  phase?: 'egg' | 'hatching' | 'creature'; motion?: boolean
  feeling?: CompanionFeeling
  creature?: { uid: string; id: 'tim'; seed: number; name: string; version: string; shiny: boolean }
  egg?: { kind: string; stage: string; uid?: string }
}
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
const integer = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max
const word = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && /^[a-zA-Z0-9_:.\/-]+$/.test(v)
export const companionWindow = (v: unknown): v is string => word(v, 80)

export function parseCompanionState(value: unknown): CompanionState | null {
  const p = object(value)
  if (!p || p.v !== 1 || !companionWindow(p.window) ||
      !integer(p.epoch, 0x7fffffff) || !integer(p.revision, Number.MAX_SAFE_INTEGER) ||
      typeof p.enabled !== 'boolean' || typeof p.foreground !== 'boolean') return null
  const state: CompanionState = { v: 1, window: p.window, epoch: p.epoch,
    revision: p.revision, enabled: p.enabled, foreground: p.foreground }
  if (!p.enabled) return state
  if (typeof p.phase !== 'string' || !['egg', 'hatching', 'creature'].includes(p.phase) || typeof p.motion !== 'boolean') return null
  const f = object(p.feeling)
  if (!f || !COMPANION_EMOTIONS.includes(f.emotion as CompanionEmotion) ||
      !word(f.reason, 48) || !integer(f.intensity, 3) || f.intensity < 1) return null
  const feeling: CompanionFeeling = { emotion: f.emotion as CompanionEmotion,
    reason: f.reason, intensity: f.intensity }
  if (f.reactionId !== undefined) {
    if (!word(f.reactionId, 256) || !integer(f.remainingMs, 30_000)) return null
    feeling.reactionId = f.reactionId
    feeling.remainingMs = f.remainingMs
  }
  state.phase = p.phase as CompanionState['phase']
  state.motion = p.motion
  state.feeling = feeling
  if (p.phase === 'creature' || p.creature !== undefined) {
    const c = object(p.creature)
    if (!c || c.id !== 'tim' || !word(c.uid, 64) || !integer(c.seed, 0xffffffff) ||
        typeof c.name !== 'string' || !/^[\x20-\x7e]{1,24}$/.test(c.name) ||
        typeof c.version !== 'string' || !['0.1', '1.0', '2.0'].includes(c.version) || typeof c.shiny !== 'boolean') return null
    state.creature = { uid: c.uid, id: 'tim', seed: c.seed, name: c.name,
      version: c.version as string, shiny: c.shiny }
  }
  if (p.phase === 'egg' || p.phase === 'hatching') {
    const e = object(p.egg)
    if (!e || !word(e.kind, 24) || typeof e.stage !== 'string' || !['p0', 'p1', 'p2', 'p3', 'p4', 'rock',
      'burst', 'tumble', 'open', 'hatchling'].includes(e.stage)) return null
    state.egg = { kind: e.kind, stage: e.stage as string }
    if (e.uid !== undefined) {
      if (!word(e.uid, 64)) return null
      state.egg.uid = e.uid
    }
  }
  return state
}

interface Entry { conn: string; state: CompanionState; expires?: number }

/** Owns no timers or app state. Socket liveness removes disconnected windows. */
export class DesktopCompanion {
  private readonly windows = new Map<string, Entry>()
  private readonly retired = new Set<string>()
  private selected: string | null = null
  private serial = 0
  constructor(private readonly changed: () => void, private readonly now = Date.now) {}

  update(conn: string, raw: unknown): boolean {
    const state = parseCompanionState(raw)
    if (!state || this.retired.has(conn)) return false
    const previous = this.windows.get(state.window)
    if (previous && (state.revision <= previous.state.revision ||
      state.epoch < previous.state.epoch)) return false
    if (previous && previous.conn !== conn) {
      this.retired.add(previous.conn)
      if (this.retired.size > 64) this.retired.delete(this.retired.values().next().value!)
    }
    if (!previous && this.windows.size >= 8) return false
    const reaction = state.feeling?.reactionId
    const sameReaction = reaction && reaction === previous?.state.feeling?.reactionId &&
      state.epoch === previous.state.epoch
    const expires = reaction ? Math.min(this.now() + (state.feeling?.remainingMs ?? 0),
      sameReaction ? previous?.expires ?? Infinity : Infinity) : undefined
    this.windows.set(state.window, { conn, state, expires })
    if (!this.selected || (state.foreground && !previous?.state.foreground)) this.selected = state.window
    if (this.selected === state.window) { this.serial++; this.changed() }
    return true
  }

  focus(window: unknown): void {
    if (!companionWindow(window) || !this.windows.has(window) || this.selected === window) return
    this.selected = window
    this.serial++
    this.changed()
  }

  disconnect(conn: string): void {
    let removed = false
    for (const [id, entry] of this.windows) {
      if (entry.conn !== conn) continue
      this.windows.delete(id)
      if (this.selected === id) { this.selected = null; removed = true }
    }
    if (removed) { this.serial++; this.changed() }
  }

  snapshot(): CompanionState & { serial: number } {
    const entry = this.selected ? this.windows.get(this.selected) : undefined
    if (!entry) return { v: 1, window: 'none', epoch: 0, revision: 0,
      enabled: false, foreground: false, serial: this.serial }
    const state = structuredClone(entry.state)
    if (state.feeling?.reactionId) state.feeling.remainingMs = Math.max(0,
      Math.min(30_000, (entry.expires ?? this.now()) - this.now()))
    return { ...state, serial: this.serial }
  }

  actionTarget(raw: Record<string, unknown>): {conn:string;state:CompanionState} | null {
    const entry=this.selected?this.windows.get(this.selected):undefined
    if(!entry||!entry.state.enabled||raw.window!==entry.state.window||raw.epoch!==entry.state.epoch)return null
    const target=raw.action==='hatch'?entry.state.egg?.uid:entry.state.creature?.uid
    if(!target||target!==raw.target)return null
    if(raw.action==='hatch'&&(entry.state.phase!=='egg'||entry.state.egg?.stage!=='p4'))return null
    return {conn:entry.conn,state:entry.state}
  }
}
