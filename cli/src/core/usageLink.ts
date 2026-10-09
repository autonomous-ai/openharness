/** Usage is observational: frames read memory, and bounded requests refresh it off the control path. */
import { usageSnapshot, usageTarget, usageTargetKey, validUsage, validUsageTarget, USAGE_LIMIT, USAGE_REFRESH_MS,
  type AgentTokenUsage, type AgentUsageTarget } from '../lib/agentUsageWire.js'
export interface UsageSnapshots {
  get(target: AgentUsageTarget): AgentTokenUsage | null
  changed(target: AgentUsageTarget): void
  stop(): void
}

interface Entry {
  target: AgentUsageTarget
  value: AgentTokenUsage | null
  checked: number
  dirty: boolean
  pending: boolean
  timer?: ReturnType<typeof setTimeout>
}

export function createUsageLink(options: {
  call(payload: Record<string, unknown>): Promise<Record<string, unknown>>
  changed(target: AgentUsageTarget): void
  now?: () => number
}) {
  const entries = new Map<string, Entry>()
  const tasks = new Set<Promise<void>>()
  let epoch = 0, running = 0, stopped = false
  const now = options.now ?? Date.now
  const signal = (v: AgentTokenUsage | null) => JSON.stringify(v && [v.totalTokens, v.output, v.work])
  const remove = (id: string, entry: Entry) => {
    if (entry.timer) clearTimeout(entry.timer)
    entries.delete(id)
  }
  const drain = () => {
    if (stopped) return
    for (const [id, entry] of entries) {
      if (running >= 4) break
      if (!entry.dirty || entry.pending) continue
      entry.dirty = false; entry.pending = true; entry.checked = now()
      const generation = epoch, target = usageTarget(entry.target)
      running++
      const task = Promise.resolve().then((): Record<string, unknown> | Promise<Record<string, unknown>> => stopped ? {} : options.call({ target })).then(answer => {
        if (stopped || generation !== epoch || entries.get(id) !== entry
          || !validUsageTarget(answer.target) || usageTargetKey(answer.target) !== usageTargetKey(target) || !validUsage(answer.value)) return
        const value = usageSnapshot(answer.value)
        const changed = signal(entry.value) !== signal(value)
        entry.value = value
        if (changed) options.changed(target)
      }).catch(() => { /* A failed observation changes no session state or last good value. */ }).finally(() => {
        tasks.delete(task)
        if (generation !== epoch) return
        running--; entry.pending = false
        drain()
      })
      tasks.add(task)
    }
  }
  const interest = (source: AgentUsageTarget): Entry | null => {
    if (stopped) return null
    const target = usageTarget(source)
    if (!validUsageTarget(target)) return null
    const previous = entries.get(target.agentId)
    if (previous && usageTargetKey(previous.target) === usageTargetKey(target)) return previous
    if (previous) remove(target.agentId, previous)
    if (entries.size >= USAGE_LIMIT) {
      const oldest = entries.entries().next().value!
      remove(...oldest)
    }
    const entry: Entry = { target, value: null, checked: -Infinity, pending: false, dirty: true }
    entries.set(target.agentId, entry)
    drain()
    return entry
  }
  const refresh = (entry: Entry) => { entry.dirty = true; drain() }
  const port: UsageSnapshots = {
    get: target => interest(target)?.value ?? null,
    changed: target => {
      const previous = entries.get(target.agentId)
      const entry = interest(target)
      if (!entry || entry !== previous || entry.timer) return
      // One request per immutable target preserves order. New transcript events schedule a later
      // refresh, never discard useful progress from a read already in flight.
      if (now() - entry.checked >= USAGE_REFRESH_MS) { refresh(entry); return }
      entry.timer = setTimeout(() => {
        entry.timer = undefined
        entry.dirty = true
        drain()
      }, Math.max(500, USAGE_REFRESH_MS - (now() - entry.checked)))
      entry.timer.unref()
    },
    stop: () => {
      stopped = true; epoch++
      for (const [id, entry] of entries) remove(id, entry)
    },
  }
  const disconnected = () => {
    epoch++; running = 0
    for (const entry of entries.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = undefined; entry.pending = false; entry.dirty = false
    }
  }
  return {
    port,
    disconnected,
    /** Services receive only a copy for a current owned target. Raw registry rows may omit nullable fields. */
    readSnapshot: async (target: AgentUsageTarget, current: readonly AgentUsageTarget[]) =>
      current.some(row => usageTargetKey(row) === usageTargetKey(target)) ? usageSnapshot(port.get(target)) : null,
    connected: () => {
      disconnected()
      for (const entry of entries.values()) entry.dirty = true
      drain()
    },
    /** Deterministic observation tests only. Frames and readiness never await this. */
    settled: async () => { while (tasks.size) await Promise.all(tasks) },
  }
}
