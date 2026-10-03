/** The daemon owns process identity, stopping and saved runtime configuration, on every machine. */
import { randomUUID } from 'node:crypto'
import { readFile, mkdir, open as openFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { listAgents, request } from './bridge.mjs'
import { mergeRows } from './inventory.mjs'
import { stateDir } from './config.mjs'
import { normalizePolicy, protectionFor } from './policy.mjs'

const pending = new Map()
const receipt = (row, action, detail, extra = {}) => ({ id: row.id, name: row.name, action, ok: false, refused: true, detail, ...extra })
async function fresh(row, list) {
  if (!row.machineId || !row.agentId || row.online === false) throw new Error('Reconnect this machine and refresh before acting.')
  const agents = await list(row.machineId)
  const agent = agents.find(a => a.id === row.agentId)
  if (!agent) throw new Error('This harness is no longer in the daemon inventory. Refresh and try again.')
  // A stopped/reopened or rotated conversation is a different target from the one the person reviewed.
  if ((agent.sessionId || null) !== (row.sessionId || null) || (row.createdAt != null && Date.parse(agent.createdAt) !== row.createdAt)) throw new Error('This conversation changed. Refresh and review it before acting.')
  return mergeRows([agent], { machine: { machineId: row.machineId, name: row.machine }, local: row.local,
    state: { pins: row.pinned ? [row.id] : [] } })[0]
}

export async function stop(row, { policy = normalizePolicy({}), force = false, list = listAgents, rpc = request } = {}) {
  try {
    const current = await fresh(row, list)
    if (current.state === 'stopped') return receipt(row, 'stop', 'Already stopped; history retained.', { ok: true, refused: false })
    if (!current.canStop) return receipt(row, 'stop', current.unavailable || 'This harness cannot be stopped yet.')
    if (!force) {
      if (!current.activityKnown) return receipt(row, 'stop', 'Update the owning daemon before automatic cleanup; activity is unknown.')
      const guard = protectionFor(current, policy)
      if (guard) return receipt(row, 'stop', guard.why)
      if (current.lastActivity !== row.lastActivity) return receipt(row, 'stop', 'Activity changed since the cleanup preview. Review the new plan.')
    }
    const reply = await rpc(row.machineId, 'agent_delete', { agentId: row.agentId, expectedSessionId: row.sessionId || null })
    if (reply.deleted !== true) return receipt(row, 'stop', 'Stop was not confirmed. Refresh before trying again.')
    return receipt(row, 'stop', 'Stopped; history and launch configuration retained.', { ok: true, refused: false, freed: current.rssBytes })
  } catch (error) { return receipt(row, 'stop', error.message) }
}

/** Persist the intent before sending. A new viewer/CLI checks the same durable daemon receipt after
 * a lost reply, rather than issuing another open. Exclusive file creation also coalesces callers. */
async function openIntent(row) {
  const directory = stateDir(), key = createHash('sha256').update(row.id).digest('hex')
  await mkdir(directory, { recursive: true })
  // Keep the existing receipt filename so an update cannot duplicate an uncertain launch.
  const path = join(directory, 'resume-' + key + '.json')
  try {
    const file = await openFile(path, 'wx', 0o600)
    const value = { creationId: randomUUID(), agentId: row.agentId, sessionId: row.sessionId }
    try { await file.writeFile(JSON.stringify(value)) } finally { await file.close() }
    return { ...value, path, existing: false }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (value.agentId !== row.agentId || value.sessionId !== row.sessionId || typeof value.creationId !== 'string') throw new Error('An earlier open needs review before retrying.')
    return { ...value, path, existing: true }
  }
}

export function open(row, options = {}) {
  if (pending.has(row.id)) return pending.get(row.id)
  const result = openOnce(row, options).finally(() => pending.delete(row.id))
  pending.set(row.id, result)
  return result
}
async function openOnce(row, { list = listAgents, rpc = request, intent = openIntent, clearIntent = path => unlink(path).catch(() => {}) } = {}) {
  try {
    const current = await fresh(row, list)
    if (current.state !== 'stopped') return receipt(row, 'open', current.canOpen ? 'Already running.' : 'This harness is not ready to open.', { ok: current.canOpen, refused: !current.canOpen })
    if (!current.canOpen) return receipt(row, 'open', 'This harness cannot be reopened yet.')
    const operation = await intent(row)
    let reply
    if (operation.existing) reply = await rpc(row.machineId, 'agent_create_status', { creationId: operation.creationId })
    if (!operation.existing || reply.state === 'missing') {
      try { reply = await rpc(row.machineId, 'agent_resume', { agentId: row.agentId, creationId: operation.creationId }) }
      catch { reply = await rpc(row.machineId, 'agent_create_status', { creationId: operation.creationId }) }
    }
    if (reply.state === 'created' && reply.agent?.id === row.agentId) {
      await clearIntent(operation.path)
      if (reply.agent.status === 'stopped' || reply.agent.terminal?.available === false) return receipt(row, 'open', 'The earlier open completed, but this session is no longer running. Review it and try again.')
      return receipt(row, 'open', 'Opened with its saved configuration.', { ok: true, refused: false })
    }
    if (reply.state === 'failed') {
      await clearIntent(operation.path)
      return receipt(row, 'open', reply.failure?.detail || reply.failure?.code || reply.detail || reply.error || 'Open failed.')
    }
    return receipt(row, 'open', 'Open is not confirmed yet. Check again to read the same operation.', { creationId: operation.creationId, unconfirmed: true })
  } catch (error) { return receipt(row, 'open', error.message) }
}

/** Preview and deletion both stay on the owning daemon; only it knows the native storage paths. */
export async function previewDelete(row, { list = listAgents, rpc = request } = {}) {
  try {
    const current = await fresh(row, list)
    if (!current.canDelete) return receipt(row, 'delete-review', current.unavailable || 'This harness cannot be deleted yet.')
    const result = await rpc(row.machineId, 'agent_purge', {
      agentId: row.agentId, sessionId: row.sessionId, createdAt: row.createdAt, mode: 'inspect', includeWorktree: true,
    })
    if (!result.reviewId) return receipt(row, 'delete-review', 'The daemon did not confirm which session data would be deleted.')
    if (!result.choices) return receipt(row, 'delete-review', 'Update Harness on the owning machine to choose session and worktree data separately.')
    return { ...receipt(row, 'delete-review', 'Review permanent deletion.'), ...result, ok: true, refused: false }
  } catch (error) { return receipt(row, 'delete-review', error.code === 'UNSUPPORTED' ? 'Update Harness on the owning machine to enable deletion.' : error.message) }
}
export async function deleteHarness(row, { reviewId, choices, path, discardChanges = false, rpc = request } = {}) {
  try {
    if (typeof reviewId !== 'string' || !reviewId) return receipt(row, 'delete', 'Review this harness before deleting it.')
    if (!choices || typeof choices.sessionData !== 'boolean' || typeof choices.worktreeData !== 'boolean'
      || (!choices.sessionData && !choices.worktreeData)) return receipt(row, 'delete', 'Select the data to delete first.')
    const result = await rpc(row.machineId, 'agent_purge', {
      agentId: row.agentId, sessionId: row.sessionId, createdAt: row.createdAt, mode: 'delete', reviewId, choices,
      ...(choices.worktreeData ? { path, discardChanges } : {}),
    })
    if (result.deleted !== true) return receipt(row, 'delete', 'Deletion was not confirmed. Refresh before trying again.')
    return { ...receipt(row, 'delete', 'Selected data deleted.'), ...result, ok: true, refused: false }
  } catch (error) { return receipt(row, 'delete', error.message + ' Refresh to check; deletion is never retried automatically.') }
}

export async function inspectWorkspace(row, { rpc = request } = {}) {
  try {
    if (!row.machineId || !row.agentId || row.online === false) throw new Error('Reconnect this machine to check its workspace.')
    const result = await rpc(row.machineId, 'agent_worktree_delete', {
      agentId: row.agentId, sessionId: row.sessionId, createdAt: row.createdAt, mode: 'describe',
    })
    if (!result.workspace) throw new Error('The machine did not report workspace details.')
    return { ...receipt(row, 'workspace-inspect', ''), ok: true, refused: false, workspace: result.workspace }
  } catch (error) {
    return receipt(row, 'workspace-inspect', ['UNSUPPORTED', 'INVALID_DELETE_REQUEST'].includes(error.code)
      ? 'Update Harness on this machine to show worktree details.' : error.message)
  }
}

export async function worktreeAction(row, { reviewId, path, discardChanges = false, rpc = request } = {}) {
  const inspect = !reviewId
  try {
    const result = await rpc(row.machineId, 'agent_worktree_delete', { agentId: row.agentId,
      sessionId: row.sessionId, createdAt: row.createdAt, mode: inspect ? 'inspect' : 'delete',
      ...(reviewId ? { reviewId, path, discardChanges } : {}) })
    if (inspect ? !result.reviewId : result.deleted !== true) throw new Error('The worktree operation was not confirmed. Refresh before trying again.')
    return { ...receipt(row, inspect ? 'worktree-review' : 'worktree-delete', inspect ? 'Review worktree cleanup.' : 'Worktree deleted. Branch and history kept.'), ...result, ok: true, refused: false }
  } catch (error) { return receipt(row, 'worktree-delete', error.message) }
}
