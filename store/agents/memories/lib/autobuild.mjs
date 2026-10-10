/**
 * About You without being asked: when a build is due (lib/due.mjs), the pane gives its own agent the
 * turn "Build my About You and use it in every agent", as if the person had typed it.
 *
 * So the build runs on the agent and model the person chose for this Memories harness, shows in its
 * chat like any turn, and stops when they stop it. The pane never calls a model itself.
 *
 * It asks only an idle agent — never one that is working, starting or waiting on the person — and at
 * most once every two hours, recorded in the workspace, so a build that fails or is stopped is not
 * retried in a loop. A pane with no agent of its own (the agent was closed) asks nothing.
 */

import { readFileSync, realpathSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { buildRequest, due } from './due.mjs'

export const PACKAGE_ID = 'autonomous/memories'
export const RETRY_MS = 2 * 60 * 60 * 1000
const READY = new Set(['idle', 'done'])

const real = (path) => { try { return realpathSync(path) } catch { return path } }

function readMark(workspace) {
  try { return JSON.parse(readFileSync(join(workspace, '.harness', 'memories-autobuild.json'), 'utf8')) } catch { return {} }
}

function writeMark(workspace, mark) {
  const dir = join(workspace, '.harness')
  mkdirSync(dir, { recursive: true })
  const temporary = join(dir, `.memories-autobuild.${process.pid}.tmp`)
  writeFileSync(temporary, JSON.stringify(mark, null, 2) + '\n')
  renameSync(temporary, join(dir, 'memories-autobuild.json'))
}

/** This workspace's own Memories agent among a machine's agents, or null. */
export function ownAgent(agents, workspace) {
  const here = real(workspace)
  const folder = (agent) => agent?.project?.cwd ?? agent?.cwd
  return (agents ?? []).find((agent) => agent?.dsh === PACKAGE_ID && agent.status !== 'stopped' && typeof folder(agent) === 'string' && real(folder(agent)) === here) ?? null
}

/**
 * One check. `local` is this machine's id; `request` and `send` are the bridge's (lib/bridge.mjs).
 * Returns what it did, for the pane and the tests: `{ sent, reason }`.
 */
export async function checkAutobuild({ snapshot, workspace, local, request, send, now = Date.now() }) {
  if (!workspace || !local) return { sent: false, reason: 'no workspace or machine' }
  const state = due(snapshot, { now })
  if (!state.due) return { sent: false, reason: state.reason }
  const mark = readMark(workspace)
  if (mark.sentAt && now - mark.sentAt < RETRY_MS) return { sent: false, reason: 'asked recently' }
  const reply = await request(local, 'agents_list', { includeStopped: false, monitor: true })
  const agent = ownAgent(reply?.agents, workspace)
  if (!agent) return { sent: false, reason: 'no agent in this workspace' }
  const activity = agent.monitor?.activityKnown ? agent.monitor.activity : null
  if (!READY.has(activity)) return { sent: false, reason: `agent is ${activity ?? 'not ready'}` }
  const content = buildRequest(state, { deliveryOff: Boolean(snapshot?.delivery?.choseOff) })
  await send(local, 'message', { agentId: agent.id, content })
  writeMark(workspace, { sentAt: now, agentId: agent.id, first: state.first, reason: state.reason })
  return { sent: true, reason: state.reason, content }
}
