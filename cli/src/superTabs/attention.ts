/**
 * Which of this machine's Super Tab members wait on a person, for the Harness Pro cabled to it: an assignment the agent
 * runs here that needs a decision (`needs_human`) or is stuck (`blocked`). Read off the host roster the host polls each
 * second anyway (backend superTabs/store.ts `hostTabs`, its `attention`), so nothing more is asked of the backend; a
 * backend from before it sends no `attention`, and nothing is raised.
 *
 * The roster is the whole truth each time: the set is handed to the core whole (`core.superTabs.attention`), which
 * raises what is new and closes what is gone (superTabs/inCore/attention.ts). A status that moves on, a new attempt, a
 * removed agent, a paused or deleted tab: each is a row that no longer says so, and its alert closes.
 */
import { createHash } from 'node:crypto'
import { SUPER_TAB_REQUEST_PREFIX, type SuperTabAttention } from '../core/api.js'
import { identifier, object } from './wire.js'

/**
 * One id per assignment and status: the same wait raised again (a restart, a replay) is the same question, and the
 * other status is a new one. The Pro drops a `question.close` id of 64 bytes or more, so a long assignment id is hashed.
 */
export function attentionRequestId(assignmentId: string, status: string): string {
  const key = /^[A-Za-z0-9_-]{1,40}$/.test(assignmentId) ? assignmentId : createHash('sha256').update(assignmentId).digest('hex').slice(0, 32)
  return `${SUPER_TAB_REQUEST_PREFIX}${key}:${status}`
}

/** The Pro shows at most 48 bytes of the tab's name; cut on a character, never inside one. */
function cut(text: string, bytes: number): string {
  let out = ''
  for (const char of text) {
    if (Buffer.byteLength(out + char) > bytes) break
    out += char
  }
  return out
}

/**
 * The waits among the roster's rows for agents live on this machine (`live`: the core has that harness). One per
 * agent: an agent owns one active assignment at a time (backend `AGENT_BUSY`), and the first row wins otherwise.
 */
export function attentionOf(rows: unknown[], machineId: string, live: (harnessId: string) => boolean): SuperTabAttention[] {
  const out = new Map<string, SuperTabAttention>()
  for (const item of rows) {
    const row = object(item), agent = object(row.agent), wait = object(row.attention)
    if (row.paused === true || !identifier(row.tabId) || !identifier(agent.harnessId) || agent.machineId !== machineId) continue
    if (!identifier(wait.assignmentId) || (wait.status !== 'needs_human' && wait.status !== 'blocked')) continue
    if (out.has(agent.harnessId) || !live(agent.harnessId)) continue
    const said = typeof wait.result === 'string' ? wait.result.trim().slice(0, 300) : ''
    const stuck = wait.status === 'blocked'
    out.set(agent.harnessId, {
      agentId: agent.harnessId,
      requestId: attentionRequestId(wait.assignmentId, wait.status),
      superTab: cut(typeof row.tabName === 'string' && row.tabName.trim() ? row.tabName.trim() : 'Super Tab', 48),
      attention: stuck ? 'stuck' : 'decision',
      // What the device reads first. Stuck says so in words too: a dial that predates `attention` shows the text alone.
      text: stuck ? `Stuck: ${said || 'needs help to go on'}` : said || 'Needs your decision',
    })
  }
  return [...out.values()]
}
