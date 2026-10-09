/** Agy's real attach, private daemon/home/tmux, and its recorded transcript/footer shapes. */
import { appendFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

let daemon: IsolatedDaemon | undefined
let client: LocalClient | undefined
afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })

it('an idle Agy pane settles old history and still follows the next live turn', async () => {
  const d = daemon = await IsolatedDaemon.create()
  onTestFailed(() => console.log(d.log()))
  d.env.AGY_PATH = join(d.root, 'bin', 'agy')
  d.env.AGY_HOME = join(d.root, 'agy')
  // Nothing invokes an installed engine. The process and pane are real, including discovery.
  writeFileSync(d.env.AGY_PATH, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('1.1.14'); process.exit(0) }
if (process.argv.includes('models')) { console.log('gemini-3.7-flash-high\\tGemini 3.7 Flash (High)'); process.exit(0) }
process.title = 'agy'
require('node:fs').writeFileSync(${JSON.stringify(join(d.root, 'agy.pid'))}, String(process.pid))
console.log('Old answer\\n>\\n? for shortcuts                    Gemini 3.7 Flash · high')
setInterval(() => {}, 1000)
`, { mode: 0o755 })
  const cwd = join(d.projectsDir, 'agy'); mkdirSync(cwd, { recursive: true })
  const sessionId = 'a9510000-0000-4000-8000-000000000001'
  const transcriptPath = join(d.env.AGY_HOME, 'brain', sessionId, '.system_generated', 'logs', 'transcript_full.jsonl')
  mkdirSync(dirname(transcriptPath), { recursive: true })
  const step = (type: string, index: number, content: string) => JSON.stringify({ type, step_index: index, status: 'DONE', content }) + '\n'
  writeFileSync(transcriptPath, step('USER_INPUT', 0, '<USER_REQUEST>Old prompt</USER_REQUEST>') + step('PLANNER_RESPONSE', 1, 'Old answer'))
  const old = new Date(Date.now() - 600_000); utimesSync(transcriptPath, old, old)
  await d.start()
  const c = client = await LocalClient.connect(d)
  const created = await c.request('agent_create', { engine: 'agy', cwd, bypassPermission: true }, 60_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  const agentId: string = created.agent.id
  const pane = String(created.agent.terminal?.runtimes?.[0]?.paneId ?? created.agent.tmuxPane)
  await until('the private Agy pane to be idle', async () => (await d.capture(pane)).includes('? for shortcuts') || null, 15_000, 100)
  const callerPid = Number(readFileSync(join(d.root, 'agy.pid'), 'utf8'))
  const hook = async (path: string, extra: Record<string, unknown> = {}) => {
    const response = await fetch(`http://127.0.0.1:${d.port}/api/hook/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-harness-hook-token': d.hookCredential() },
      body: JSON.stringify({ engine: 'agy', sessionId, tmuxPane: pane, cwd, transcriptPath, callerPid, ...extra }),
    })
    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.ignored, JSON.stringify(body)).not.toBe(true)
    return body
  }
  await hook('session-start', { hookEvent: 'SessionStart' })
  await until('Agy history to attach', () => d.log().includes('attached · engine=agy') || null, 30_000, 100)
  const rows = async () => (await c.request('agents_list', {})).agents as Array<Record<string, any>>
  const attached = (await rows()).find(row => row.id === agentId)
  expect(attached?.sessionId).toBe(sessionId)
  expect(attached?.activity?.state).not.toBe('working')
  expect(c.frames.filter(frame => frame.type === 'turn_started' && frame.agentId === agentId)).toHaveLength(0)
  const history = await c.request('session_get', { sessionId: agentId, limit: 10 })
  expect(history.error, JSON.stringify(history)).toBeUndefined()
  expect(JSON.stringify(history.events)).toContain('Old answer')

  const started = c.next(frame => frame.type === 'turn_started' && frame.agentId === agentId, 15_000, 'the next live Agy turn')
  appendFileSync(transcriptPath, step('USER_INPUT', 2, '<USER_REQUEST>New prompt</USER_REQUEST>'))
  expect((await started).replay).toBeFalsy()
  const ended = c.next(frame => frame.type === 'turn_ended' && frame.agentId === agentId, 15_000, 'the live Agy Stop')
  appendFileSync(transcriptPath, step('PLANNER_RESPONSE', 3, 'New answer'))
  await hook('turn-stop', { hookEvent: 'Stop' })
  await ended
  expect(d.coresStarted()).toBe(1)
}, 90_000)
