/** Explicit cleanup uses each owning daemon's open-tab guard and durable Close path. */
import { randomUUID } from 'node:crypto'
import { machinesReport, request } from './bridge.mjs'

export async function previewCleanup({ includeRemote = true, reportMachines = machinesReport, rpc = request } = {}) {
  const report = await reportMachines()
  if (report.error) throw new Error(report.error)
  const answers = await Promise.all(report.machines.filter(m => includeRemote || m.current).map(async machine => {
    if (!machine.online) return { problem: { machine: machine.name, error: 'Offline. Kept unchanged.' } }
    try {
      const reply = await rpc(machine.machineId, 'agents_cleanup_preview', {}, { timeoutMs: 60_000 })
      if (reply.version !== 1 || !Array.isArray(reply.agents)) throw new Error('Update Harness on this machine to use cleanup.')
      const rows = reply.agents.map(agent => {
        if (!agent || typeof agent.agentId !== 'string' || !agent.agentId || typeof agent.sessionId !== 'string'
          || typeof agent.createdAt !== 'string' || !Number.isFinite(Date.parse(agent.createdAt))) throw new Error('Could not read this machine’s cleanup preview.')
        return { id: JSON.stringify([machine.machineId, agent.agentId]), machineId: machine.machineId, machine: machine.name,
          agentId: agent.agentId, sessionId: agent.sessionId, createdAt: agent.createdAt,
          name: String(agent.name || agent.agentId), activity: agent.activity ?? 'unknown' }
      })
      return { rows, kept: Number.isSafeInteger(reply.kept) && reply.kept >= 0 ? reply.kept : 0 }
    } catch (error) { return { problem: { machine: machine.name,
      error: error.code === 'UNSUPPORTED' ? 'Update Harness on this machine to use cleanup.' : error.message } } }
  }))
  return { rows: answers.flatMap(a => a.rows ?? []), kept: answers.reduce((n, a) => n + (a.kept ?? 0), 0),
    problems: answers.flatMap(a => a.problem ? [a.problem] : []) }
}

export async function closeHidden(row, { rpc = request } = {}) {
  const receipt = { id: row.id, name: row.name, machine: row.machine, action: 'close' }
  try {
    const reply = await rpc(row.machineId, 'agent_close', { agentId: row.agentId, sessionId: row.sessionId,
      createdAt: row.createdAt, mode: 'now', onlyIfHidden: true }, { timeoutMs: 60_000 })
    return { ...receipt, ok: reply.closed === true,
      detail: reply.closed === true ? 'Closed. History kept.' : reply.detail || reply.error || 'Close was not confirmed. Refresh to check.' }
  } catch (error) { return { ...receipt, ok: false, detail: error.message } }
}

/** Only server-held preview targets can be submitted. Repeated clicks read the same result. */
export function cleanupReviews({ preview = previewCleanup, close = closeHidden, now = Date.now } = {}) {
  const reviews = new Map()
  return {
    async preview() {
      const plan = await preview()
      const reviewId = randomUUID()
      for (const [id, review] of reviews) if (now() - review.at > 30 * 60_000) reviews.delete(id)
      if (reviews.size >= 10) reviews.delete(reviews.keys().next().value)
      reviews.set(reviewId, { at: now(), rows: new Map(plan.rows.map(row => [row.id, row])), results: new Map() })
      return { ...plan, reviewId }
    },
    async close(reviewId, id) {
      const review = reviews.get(reviewId), row = review?.rows.get(id)
      if (!row || now() - review.at > 30 * 60_000) throw Object.assign(new Error('Refresh the cleanup preview and try again.'), { code: 'INVALID_REVIEW' })
      if (!review.results.has(id)) review.results.set(id, Promise.resolve().then(() => close(row)))
      return review.results.get(id)
    },
  }
}
