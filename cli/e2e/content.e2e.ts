/**
 * What a message says reaches the engine exactly as one prompt, for Claude Code and Codex. Messages come
 * from the apps, the phone, hn and other agents, and an agent's words can carry text from anywhere
 * (a web page it read, a file it opened): emoji joined into one glyph, right-to-left text, tabs, shell
 * metacharacters, and terminal control sequences. The daemon pastes a message into the engine's pane as
 * one bracketed paste, then presses Enter. A message must arrive whole and as one prompt, and nothing
 * in it may act as keystrokes: in particular the paste's own end marker (ESC [201~), which would end
 * the paste early and turn the rest into typing, and a carriage return inside it.
 *
 * Measured: tmux 3.7c defangs control characters inside a bracketed paste itself (the engine receives
 * ESC as the two characters `^[`), but 3.2a and 3.3a, what Ubuntu 22.04 and Debian 12 ship, pass ESC
 * through raw: there the end marker ended the paste after `hello` and the engine ran `!exit` as typed
 * input. The daemon now makes every control but tab and newline visible before it pastes
 * (lib/pasteText.ts), so a message reads the same on every tmux. This test holds that on whichever tmux
 * is first on PATH.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
type Row = Record<string, any>

const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
async function create(d: IsolatedDaemon, client: LocalClient, engine: Engine, folder: string): Promise<Row> {
  const cwd = join(d.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${folder} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
}
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** The fake engines running for this daemon: an engine-titled process under one of its launch shells. */
function engines(d: IsolatedDaemon): number {
  const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3].trim() }))
  const launchers = new Set(table.filter((p) => p.command.includes(join(d.root, 'bin'))).map((p) => p.pid))
  return table.filter((p) => /^(claude|codex)(?:\s|$)/.test(p.command) && launchers.has(p.ppid)).length
}

const ESC = '\x1b'
// `!exit` ends the fake engine: if any of these leaks out of its paste as typing, the engine is gone.
const HOSTILE = [
  ['the paste\'s end marker, then a command', `hello${ESC}[201~\r!exit\r`],
  ['a carriage return mid-message, then a command', 'first line\r!exit'],
  ['an escape sequence that clears the screen', `before${ESC}[2J${ESC}[Hafter`],
] as const
const FAITHFUL = [
  'a family 👨‍👩‍👧‍👦 and a flag 🇻🇳, joined',
  'שלום עולם and مرحبا بالعالم, right to left',
  'tabs\tbetween\twords and `backticks` $(echo not run) ; | & > <',
  'combining: é ä and a zero-width​space',
] as const

describe('what a message says', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it.each(['claude', 'codex'] as const)('%s: every message arrives whole, as one prompt, and nothing in it acts as keystrokes', async (engine) => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
    await d.start()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `content-${engine}`)

    for (const text of FAITHFUL) {
      const started = client.next(isTurn('turn_started', agent.id), 45_000, `turn_started (${text})`)
      const ended = client.next(isTurn('turn_ended', agent.id), 45_000, `turn_ended (${text})`)
      client.send('message', { agentId: agent.id, content: text })
      expect((await started).payload?.userMessage, 'arrives exactly as sent').toBe(text)
      await ended
    }
    for (const [what, text] of HOSTILE) {
      const from = client.frames.length
      client.send('message', { agentId: agent.id, content: text })
      await client.waitFor((frame) => isTurn('turn_ended', agent.id)(frame) && client.frames.indexOf(frame) >= from, 45_000, `the turn for ${what}`)
      // Longer than two reconcile passes, so an engine that typing made exit is seen to be gone.
      await sleep(12_000)
      expect(engines(d), `${what}: the engine process is still running`).toBe(1)
      const starts = client.frames.slice(from).filter(isTurn('turn_started', agent.id))
      expect(starts, `${what}: one prompt, not two`).toHaveLength(1)
      if (text.includes('!exit')) expect(String(starts[0].payload?.userMessage), `${what}: the whole message is the one prompt`).toContain('!exit')
      const now = await row(client, agent.id)
      expect(now?.status, `${what}: the engine is still there`).toBe('active')
      expect(now?.engine, `${what}: the pane still runs the engine`).toBe(engine)
    }
    client.close()
  }, 240_000)
})
