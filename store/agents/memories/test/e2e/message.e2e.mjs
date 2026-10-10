#!/usr/bin/env node
/**
 * The pane's way of asking its own agent for a build, end to end on this computer's real daemon: a turn
 * sent over the local bridge as a tool (lib/bridge.mjs `send`, exactly what lib/autobuild.mjs uses) must
 * start a turn in that agent and get an answer.
 *
 *   node --disable-warning=ExperimentalWarning test/e2e/message.e2e.mjs
 *
 * It creates one plain Claude Code harness in a throwaway folder, sends it a one-line request whose
 * answer is a random word, waits for the agent to go from working back to idle, reads the answer from
 * the session index, and deletes the harness (and its transcript) again. One short model call.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeBridges, machinesReport, request, send } from '../../lib/bridge.mjs'

const word = `memories-pong-${randomBytes(3).toString('hex')}`
const folder = mkdtempSync(join(tmpdir(), 'memories-message-'))
const steps = []
const step = (name, ok, detail = '') => { steps.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let local = null
let agentId = null
let sessionId = null
try {
  local = (await machinesReport()).machines.find((machine) => machine.current)?.machineId
  step('the local daemon answers on the bridge', Boolean(local))
  const created = await request(local, 'agent_create', { engine: 'claude', cwd: folder, dsh: null, creationId: randomUUID(), bypassPermission: false }, { timeoutMs: 90_000 })
  agentId = created.agent?.id ?? null
  step('a throwaway Claude Code harness is created', Boolean(agentId), created.error ?? '')

  const activity = async () => {
    const list = await request(local, 'agents_list', { includeStopped: false, monitor: true })
    const agent = list.agents.find((row) => row.id === agentId)
    sessionId = agent?.sessionId ?? sessionId
    return agent?.monitor?.activityKnown ? agent.monitor.activity : null
  }
  let state = null
  for (let i = 0; i < 60 && !['idle', 'done'].includes(state); i++) { await wait(2000); state = await activity() }
  step('it starts and is idle', ['idle', 'done'].includes(state), String(state))

  await send(local, 'message', { agentId, content: `Reply with exactly this word and nothing else: ${word}` })
  let worked = false
  for (let i = 0; i < 90; i++) {
    await wait(2000)
    state = await activity()
    if (state === 'working') worked = true
    if (worked && ['idle', 'done'].includes(state)) break
  }
  step('the sent turn makes it work, then finish', worked && ['idle', 'done'].includes(state), String(state))

  let answer = ''
  for (let i = 0; i < 15 && !answer.includes(word); i++) {
    await wait(2000)
    const hits = await request(local, 'session_search', { query: word, limit: 3 }).catch(() => ({}))
    answer = JSON.stringify(hits)
  }
  step('its answer has the word', answer.includes(word), word)
} catch (error) {
  step('the run itself', false, error instanceof Error ? error.message : String(error))
} finally {
  if (agentId && local) { try { await send(local, 'agent_delete', { agentId }); await wait(3000) } catch { /* reported below */ } }
  if (sessionId) {
    const transcripts = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', folder.replace(/[^A-Za-z0-9]/g, '-'))
    if (existsSync(transcripts)) rmSync(transcripts, { recursive: true, force: true })
  }
  rmSync(folder, { recursive: true, force: true })
  closeBridges()
}
const failed = steps.filter((ok) => !ok).length
console.log(`${steps.length - failed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
