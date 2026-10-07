/**
 * What the dial and the windows hear of each turn's recap, compared with another build's. The recaps moved
 * out of the core into a service of their own (services/recaps.ts, in the edge host), and the dial's
 * firmware, the desktop and the phone were written against the cards and recaps a released daemon sends:
 * moving them must not change one. A daemon of that build (`COMPAT_FROM`, its bundled `cli.js`) and one of
 * this checkout's bundle run the same scenario with a fake dial on a pseudo-terminal (harness/fakeDial.ts),
 * which is a device watching, and a window on the local socket: a turn on Claude Code and on Codex, a
 * question the window answers, a turn held and cancelled, and `agent_recent`.
 *
 * Compared: every turn card the dial heard (`turn.*`, `summary`), by type and shape, and its recap text
 * and whether it rang; every `turn_summary` and `turn_summary_pending` a window heard, by shape, and the
 * recap it carried and whether it was a notification; and what `agent_recent` answered. A difference
 * listed in CHANGED is on purpose, with why; TIMING lists what one run may hear and the other not.
 *
 * Skipped unless COMPAT_FROM names a bundle, as e2e/compat.e2e.ts is. `COMPAT_REPORT=<file>` writes both
 * sides, for reading.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { FakeDial, type DialMessage } from './harness/fakeDial.js'

const FROM = process.env.COMPAT_FROM

/** Differences on purpose, by key, each with why. */
const CHANGED: Record<string, string> = {}

/** Types that one run may hear and the other not, by timing alone, each with why. */
const TIMING: Record<string, string> = {
  // The working card's activity line is read from the pane's footer while a turn runs: a fast fake turn
  // can end before the first read.
  'dial turn.activity': 'read from the pane while a turn runs; a fast turn can end first',
}

type Engine = 'claude' | 'codex'

/** A value's shape: its keys, all the way down; arrays as the shapes of their items. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return [...new Set(value.map((item) => JSON.stringify(shape(item))))].sort()
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape((value as Record<string, unknown>)[key])]))
  }
  return typeof value
}

interface Heard {
  shapes: Map<string, Set<string>>
  values: Record<string, unknown>
}

function hear(into: Heard, key: string, value: unknown): void {
  const shapes = into.shapes.get(key) ?? new Set<string>()
  shapes.add(JSON.stringify(shape(value)))
  into.shapes.set(key, shapes)
}

/** One build's daemon, a dial and a window through the scenario; what both heard. */
async function scenario(scriptPath: string | undefined, label: string): Promise<Heard> {
  const dial = await FakeDial.open()
  const daemon = await IsolatedDaemon.create({ ...(scriptPath ? { scriptPath } : {}), env: { CABLE_DISABLE: 'false', HARNESSD_TEST_DIAL_PORT: dial.path } })
  onTestFailed(() => { console.log(`---- ${label} daemon log\n${daemon.log().split('\n').slice(-120).join('\n')}\n---- the dial heard\n${dial.messages.map((m) => m.t).join(' ')}`) })
  const heard: Heard = { shapes: new Map(), values: {} }
  try {
    await daemon.start()
    const window = await LocalClient.connect(daemon)
    await dial.greet()
    const agents: Record<Engine, string> = { claude: '', codex: '' }
    for (const engine of ['claude', 'codex'] as const) {
      const cwd = join(daemon.projectsDir, `recaps-compat-${engine}`)
      mkdirSync(cwd, { recursive: true })
      const created = await window.request('agent_create', { engine, cwd, bypassPermission: true }, 60_000)
      agents[engine] = created.agent.id
      await until(`the ${engine} agent to bind`, async () => ((await window.request('agents_list', {})).agents as Array<Record<string, unknown>>)
        .find((agent) => agent.id === created.agent.id)?.sessionId || null, 45_000, 500)
    }
    window.send('app_panes', { agentIds: Object.values(agents), foreground: true })
    for (const engine of ['claude', 'codex'] as const) {
      const agentId = agents[engine]
      // A turn: the dial's working card, then its recap; the window's recap.
      const since = dial.messages.length
      const summary = window.next((f) => f.type === 'turn_summary' && f.agentId === agentId, 45_000, `${engine}'s turn_summary`)
      window.send('message', { agentId, content: `tell me about the ${engine} narwhal` })
      const card = await dial.next((m) => m.t === 'summary' && m.agentId === agentId && !m.restore, 45_000, `${engine}'s summary card`, since)
      const frame = await summary
      heard.values[`${engine} card`] = { recap: card.recap, text: card.text, silent: card.silent ?? false, quiet: card.quiet ?? false }
      heard.values[`${engine} recap`] = { summary: frame.payload?.summary, notified: !!frame.payload?.notification }
      // A question: asked, answered from the window; the turn's end does not ring "done" over it twice.
      const asked = window.next((f) => f.type === 'commander_question' && f.agentId === agentId, 45_000, `${engine}'s question`)
      const answered = window.next((f) => f.type === 'turn_summary' && f.agentId === agentId, 60_000, `${engine}'s turn_summary after a question`)
      window.send('message', { agentId, content: '!ask' })
      const question = (await asked).payload ?? {}
      const replied = window.next((f) => f.type === 'question_response_result' && f.payload?.requestId === question.requestId, 45_000, `${engine}'s answer`)
      window.send('question_response', { requestId: question.requestId, agentId, answers: { [question.questions[0].q]: 'Coffee' } })
      const reply = (await replied).payload ?? {}
      heard.values[`${engine} answered`] = { ok: reply.ok ?? null, error: reply.error ?? null }
      const after = await answered
      heard.values[`${engine} recap after a question`] = { notified: !!after.payload?.notification, summarized: typeof after.payload?.summary === 'string' }
      // A turn held open, then cancelled: the card clears, with no recap and no ring.
      const held = dial.messages.length
      window.send('message', { agentId, content: '!hold' })
      await dial.next((m) => m.t === 'turn.started' && m.agentId === agentId, 45_000, `${engine}'s held turn`, held)
      window.send('cancel', { agentId })
      await dial.next((m) => m.t === 'turn.done' && m.agentId === agentId, 45_000, `${engine}'s cancelled turn ending`, held)
      heard.values[`${engine} cancel`] = { summaries: dial.messages.slice(held).filter((m) => m.t === 'summary' && m.agentId === agentId).length }
      // What a device restoring its tiles is answered.
      const recent = await window.request('agent_recent', { agentId, n: 3 }, 30_000)
      heard.values[`${engine} agent_recent`] = { events: recent.events, asks: recent.asks }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    for (const message of dial.messages as DialMessage[]) {
      if (typeof message.t !== 'string' || !(message.t.startsWith('turn.') || message.t === 'summary')) continue
      hear(heard, `dial ${message.t}`, message)
    }
    for (const frame of window.frames as Frame[]) {
      if (frame.type !== 'turn_summary' && frame.type !== 'turn_summary_pending') continue
      hear(heard, `window ${frame.type}`, frame)
    }
    window.close()
    // Each agent's own id says nothing about the build.
    const text = JSON.stringify(heard.values).split(agents.claude).join('<claude>').split(agents.codex).join('<codex>')
    heard.values = JSON.parse(text) as Record<string, unknown>
    return heard
  } finally {
    await daemon.close()
    await dial.close()
  }
}

describe.skipIf(!FROM)('each turn\'s recap, against another build\'s', () => {
  it('the dial and the windows hear the same cards and recaps, in the same shapes', async () => {
    const before = await scenario(FROM, 'released')
    const after = await scenario(process.env.E2E_BUNDLE_PATH, 'this build')
    if (process.env.COMPAT_REPORT) {
      const side = (heard: Heard) => ({ shapes: Object.fromEntries([...heard.shapes].map(([key, set]) => [key, [...set].map((s) => JSON.parse(s))])), values: heard.values })
      writeFileSync(process.env.COMPAT_REPORT, JSON.stringify({ before: side(before), after: side(after) }, null, 2))
    }
    const differences: string[] = []
    for (const key of new Set([...before.shapes.keys(), ...after.shapes.keys()])) {
      if (CHANGED[key] || TIMING[key]) continue
      const was = before.shapes.get(key)
      const is = after.shapes.get(key)
      if (!was) { differences.push(`${key}: only in this build`); continue }
      if (!is) { differences.push(`${key}: not in this build`); continue }
      const lost = [...was].filter((s) => !is.has(s))
      const added = [...is].filter((s) => !was.has(s))
      if (lost.length || added.length) differences.push(`${key}: shapes ${JSON.stringify({ lost, added })}`)
    }
    expect(differences).toEqual([])
    expect(after.values).toEqual(before.values)
    // The scenario heard what it is about, on both builds.
    expect(before.shapes.has('dial summary') && before.shapes.has('window turn_summary')).toBe(true)
  })
})
