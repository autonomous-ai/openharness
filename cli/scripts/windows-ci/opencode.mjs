#!/usr/bin/env node
/**
 * OpenCode through the installed daemon, for the Windows workflow's install job (B5.12). B4.12 found OpenCode cannot
 * run on Windows on Arm (outcome C), and B4.15 handed the check that its plugin binds a pane's conversation to x64.
 * It speaks to the daemon's loopback WebSocket, as cli/scripts/windows-pty-e2e/driver.mts does, because `harness new`
 * and `harness ps` do not show a session id. Nothing signs in: a signed-out daemon serves under this computer's id.
 *
 *   node opencode.mjs bind <folder>      create an OpenCode harness in <folder> with a first message and wait up to
 *                                        three minutes for its sessionId. Prints "bound" or "not bound" and why;
 *                                        exits 0 when bound, 1 when not.
 *   node opencode.mjs refused <folder>   the create must be refused with ENGINE_LAUNCH_REFUSED and B4.12's sentence
 *                                        (lib/windows/launch.ts windowsEngineUnavailable), and leave no harness.
 *
 * PORT is the daemon's port (18473 by default). Uses the installed daemon's existing local credential.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const ARM_SENTENCE = 'OpenCode does not run on Windows on Arm yet: its Arm build stops before its screen opens. Use another engine on this computer.'
const PROMPT = 'Reply with the single word ok.'
const BIND_MS = 180_000

const [mode, folder] = process.argv.slice(2)
if (!['bind', 'refused'].includes(mode) || !folder) {
  console.error('usage: node opencode.mjs bind|refused <folder>')
  process.exit(2)
}
const root = join(homedir(), '.harness')
const port = process.env.PORT || '18473'
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const say = (line) => console.log(`[opencode] ${line}`)

/** Run 39362659040 reached a live daemon but its TCP upgrade now requires this user's local credential. */
function installedCredential() {
  const file = join(root, 'cli', 'data', 'hook-credential')
  try {
    const info = lstatSync(file)
    if (!info.isFile() || info.size > 128) throw new Error('invalid credential file')
    const value = readFileSync(file, 'utf8').trim()
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('invalid credential value')
    return value
  } catch {
    throw new Error(`Cannot read a valid local credential at ${file}; check the installed daemon.`)
  }
}

/** The loopback socket, selected as this computer: requests answered by their `<type>_result` frame. */
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/local-ws`, { headers: { 'X-Harness-Local': installedCredential() } })
  const frames = []
  const waiters = []
  ws.onmessage = (event) => {
    if (typeof event.data !== 'string') return
    const frame = JSON.parse(event.data)
    frames.push(frame)
    for (const waiter of [...waiters]) if (waiter.test(frame)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.done(frame) }
  }
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.on('error', reject) })
  const wait = (test, ms, what) => new Promise((resolve, reject) => {
    const hit = frames.find(test)
    if (hit) return resolve(hit)
    const timer = setTimeout(() => reject(new Error(`no ${what} within ${ms} ms`)), ms)
    waiters.push({ test, done: (frame) => { clearTimeout(timer); resolve(frame) } })
  })
  const send = (type, payload) => ws.send(JSON.stringify({ type, payload }))
  const machineId = readFileSync(join(root, 'computer-id'), 'utf8').trim()
  send('machine_select', { machineId, localProtocolVersion: 1 })
  await wait((frame) => frame.type === 'connected', 15_000, 'connected')
  const rpc = async (type, payload = {}, ms = 60_000) => {
    const requestId = randomUUID()
    send(type, { requestId, ...payload })
    return (await wait((frame) => frame.type === `${type}_result` && frame.payload?.requestId === requestId, ms, `${type}_result`)).payload
  }
  return { rpc, close: () => ws.close() }
}

/** The last lines of the newest OpenCode log, and Harness's lines about OpenCode: why it did not bind. */
function why() {
  const lines = []
  const logs = join(homedir(), '.local', 'share', 'opencode', 'log')
  if (existsSync(logs)) {
    const newest = readdirSync(logs).map((name) => join(logs, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
    if (newest) lines.push(`--- ${newest} (last 25 lines)`, ...readFileSync(newest, 'utf8').trimEnd().split('\n').slice(-25))
  } else lines.push(`--- no OpenCode log folder at ${logs}`)
  const harnessLog = join(root, 'cli', 'data', 'harness.log')
  if (existsSync(harnessLog)) {
    const about = readFileSync(harnessLog, 'utf8').split('\n').filter((line) => /opencode/i.test(line)).slice(-25)
    lines.push(`--- ${harnessLog} (its last 25 lines about OpenCode)`, ...about)
  }
  return lines.join('\n')
}

const daemon = await connect()
try {
  const created = await daemon.rpc('agent_create', { engine: 'opencode', cwd: folder, bypassPermission: false, ...(mode === 'bind' ? { prompt: PROMPT } : {}) }, 120_000)
  if (mode === 'refused') {
    const agents = (await daemon.rpc('agents_list', { includeStopped: true })).agents ?? []
    const left = agents.filter((agent) => agent.engine === 'opencode')
    say(`create answered ${created.error ?? 'no error'}: ${created.detail ?? JSON.stringify(created).slice(0, 400)}`)
    if (created.error !== 'ENGINE_LAUNCH_REFUSED' || created.detail !== ARM_SENTENCE) {
      say(`FAIL expected ENGINE_LAUNCH_REFUSED with "${ARM_SENTENCE}"`)
      process.exitCode = 1
    } else if (left.length) {
      say(`FAIL the refusal left ${left.length} OpenCode harness(es): ${left.map((agent) => agent.id).join(', ')}`)
      process.exitCode = 1
    } else say('ok   refused before a pane opened, with B4.12\'s sentence; no OpenCode harness is listed')
  } else if (created.error) {
    say(`not bound: the create was refused, ${created.error} ${created.detail ?? ''}`)
    console.log(why())
    process.exitCode = 1
  } else {
    const id = created.agent.id
    say(`created ${id} (launch ${created.agent.launch?.state ?? 'unknown'}) with the first message "${PROMPT}"`)
    const until = Date.now() + BIND_MS
    let row
    while (Date.now() < until) {
      row = ((await daemon.rpc('agents_list', { includeStopped: true })).agents ?? []).find((agent) => agent.id === id)
      if (row?.sessionId) break
      await sleep(2_000)
    }
    if (row?.sessionId) say(`bound: ${id} has session ${row.sessionId} (status ${row.status}, launch ${row.launch?.state})`)
    else {
      say(`not bound within ${BIND_MS / 1000} s: ${row ? `status ${row.status}, launch ${row.launch?.state}, pane ${row.tmuxPane}` : 'the harness is no longer listed'}`)
      console.log(why())
      process.exitCode = 1
    }
    const deleted = await daemon.rpc('agent_delete', { agentId: id }, 60_000).catch((error) => ({ error: error.message }))
    say(`deleted ${id}: ${JSON.stringify(deleted).slice(0, 200)}`)
  }
} finally { daemon.close() }
