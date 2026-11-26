#!/usr/bin/env node
/**
 * The bundled OpenCode, driven through the running daemon as the phone's Chat UI drives it (vm.py runs this as `me` on
 * the installed system). OpenCode 2.4.1 came in with 0.1.18 and broke both halves unseen (MSI, 2026-11-26): its answers
 * moved out of its messages, so Chat UI showed the question alone, and its pickers were drawn anew, so no model switch
 * landed. Nothing here makes a model call off the machine: a provider of its own on loopback answers every chat "42".
 *
 *   1. `agent_create` an OpenCode agent in a project whose `opencode.json` adds that provider, with `low` and `high`
 *      variants;
 *   2. `agent_update` it to that model, then to its `high` variant: what the model sheet sends;
 *   3. `message` it a question: the answer must arrive live (`text_delta`) and read back from `session_get`.
 *
 * Writes what it saw to the file named by its argument, and exits non-zero at the first thing that did not happen.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2]
const report = { checks: [], screens: {} }
const save = () => writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
/** Ends the check; the agent and its project are still taken away (below). */
function fail(why) {
  throw new Error(why)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what, test, ms) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await test()
    if (value) return value
    if (Date.now() > deadline) fail('Timed out waiting for ' + what)
    await sleep(250)
  }
}

// The provider: OpenAI's streamed chat shape, one answer, after the seconds a real model takes. An answer in 46 ms came
// before the daemon had bound the new session, which then read the turn as long over and never told of it (MSI,
// 2026-11-26).
const server = createServer((request, response) => {
  request.resume()
  request.on('end', async () => {
    await sleep(3_000)
    const id = 'chatcmpl-harness-check'
    const created = Math.floor(Date.now() / 1000)
    const chunk = (choices, usage) => response.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'stub', choices, ...(usage ? { usage } : {}) }) + '\n\n')
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }])
    chunk([{ index: 0, delta: { content: '42' }, finish_reason: null }])
    chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])
    chunk([], { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
    response.end('data: [DONE]\n\n')
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

// The daemon, as this computer's owner: its loopback API takes the credential in its own data folder.
const data = join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'harness/cli/data')
const credential = { 'X-Harness-Local': readFileSync(join(data, 'hook-credential'), 'utf8').trim() }
const status = await (await fetch('http://127.0.0.1:18473/api/status', { headers: credential })).json()
const socket = new WebSocket('ws://127.0.0.1:18473/api/local-ws', { headers: credential })
const frames = []
socket.onmessage = (message) => {
  try { frames.push(JSON.parse(message.data)) } catch { /* not a frame */ }
}
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('The daemon refused its local socket')) })
const send = (type, payload) => socket.send(JSON.stringify({ type, payload }))
async function request(type, payload, ms) {
  const requestId = randomUUID()
  const since = frames.length
  send(type, { requestId, ...payload })
  const reply = await until(type, () => frames.slice(since).find((frame) => frame.type === type + '_result' && frame.payload?.requestId === requestId), ms)
  return reply.payload
}
send('machine_select', { machineId: status.machineId, localProtocolVersion: 1 })
await until('the daemon to take this client', () => frames.some((frame) => frame.type === 'connected'), 15_000)

// OpenCode keeps the models picked last, each one's variant, and what was asked, for every agent after: given back as
// they were, so the computer's next OpenCode does not open on a provider that left with this check.
const opencodeState = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'opencode')
const kept = Object.fromEntries(['model.json', 'prompt-history.jsonl'].map((name) => {
  try { return [name, readFileSync(join(opencodeState, name))] } catch { return [name, null] }
}))

// A folder never used before: OpenCode 2.4's shared service keeps what it read of a folder's config, and a folder made
// again under a name it had seen read as having none (MSI, 2026-11-26).
const project = join(homedir(), 'projects', 'opencode-daemon-check-' + randomUUID().slice(0, 8))
mkdirSync(project, { recursive: true })
writeFileSync(join(project, 'opencode.json'), JSON.stringify({
  provider: {
    'harness-check': {
      npm: '@ai-sdk/openai-compatible', name: 'Harness Check',
      options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'harness-check' },
      models: { stub: { name: 'Check Stub', variants: { low: {}, high: {} } } },
    },
  },
}))

let agentId = null
try {
const created = await request('agent_create', { engine: 'opencode', cwd: project }, 90_000)
if (created.error || !created.agent?.id) fail('OpenCode was not created: ' + JSON.stringify(created).slice(0, 300))
agentId = created.agent.id
const row = async () => (await request('agents_list', { includeStopped: true }, 30_000)).agents.find((agent) => agent.id === agentId)
const pane = (await until('OpenCode to start', async () => {
  const agent = await row()
  return agent?.status === 'active' && agent.launch?.state === 'ready' && agent.tmuxPane ? agent : null
}, 90_000)).tmuxPane
// The size of a screen someone watches it on. Nobody watches this one, and in tmux's 80×13 OpenCode 2.4 had no room
// for the row a filter leaves under its picker's title (MSI, 2026-11-26).
execFileSync('tmux', ['resize-window', '-t', pane, '-x', '120', '-y', '40'])
const screen = () => execFileSync('tmux', ['capture-pane', '-p', '-t', pane], { encoding: 'utf8' })
const footer = () => screen().split('\n').map((line) => line.trim()).reverse().find((line) => /\b(Build|Plan)\b[^·]* · /.test(line)) ?? ''
await until('OpenCode to draw its composer', () => footer(), 60_000)
report.screens.started = footer()

async function select(model, effort, shows) {
  const reply = await request('agent_update', {
    agentId, selectedModel: `runtime-v1:${encodeURIComponent(agentId)}:opencode:${encodeURIComponent(model)}@${effort}`,
  }, 90_000)
  report.screens[`${model}@${effort}`] = footer()
  if (reply.error) fail(`Switching to ${model}@${effort} was refused: ${reply.error}; the footer says ${footer()}`)
  if (!shows.test(footer())) fail(`Switching to ${model}@${effort} left the footer at ${footer()}`)
}
await select('harness-check/stub', 'auto', /Check Stub Harness Check$/)
report.checks.push('agent_update switches the bundled OpenCode to another provider\'s model through its own picker')
await select('harness-check/stub', 'high', /Check Stub Harness Check · high$/)
report.checks.push('agent_update moves the bundled OpenCode to a variant through its variant picker')

const since = frames.length
send('message', { agentId, content: 'What is six times seven? Reply with digits only.', mode: 'auto' })
await until('the turn to end', () => frames.slice(since).some((frame) => frame.type === 'turn_ended' && frame.agentId === agentId), 90_000)
  .catch((error) => fail(`${error.message}; frames ${JSON.stringify(frames.slice(since).map((frame) => frame.type))}; the screen shows:\n${screen()}`))
const live = frames.slice(since).filter((frame) => frame.type === 'text_delta' && frame.agentId === agentId)
  .map((frame) => frame.payload?.content ?? '').join('')
report.live = live
if (!live.includes('42')) fail('The answer never arrived live; the screen shows:\n' + screen())
report.checks.push('The bundled OpenCode\'s answer arrives live as the daemon\'s text_delta')
const sessionId = (await row())?.sessionId
if (!sessionId) fail('The agent has no session after its first turn')
const page = await request('session_get', { sessionId, limit: 80 }, 30_000)
const said = (type) => (page.events ?? []).filter((event) => event.type === type).map((event) => event.payload?.content ?? '').join('\n')
report.history = { asked: said('user_message'), answered: said('text_delta') }
if (!report.history.asked.includes('six times seven') || !report.history.answered.includes('42')) {
  fail('session_get did not read back the question and its answer: ' + JSON.stringify(page).slice(0, 500))
}
report.checks.push('session_get reads the bundled OpenCode\'s question and answer back')
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
} finally {
  if (agentId) await request('agent_delete', { agentId }, 60_000).catch(() => undefined)
  rmSync(project, { recursive: true, force: true })
  for (const [name, bytes] of Object.entries(kept)) {
    if (bytes) writeFileSync(join(opencodeState, name), bytes)
    else rmSync(join(opencodeState, name), { force: true })
  }
  socket.close()
  server.close()
  save()
}
if (report.error) {
  console.error(report.error)
  process.exit(1)
}
