/**
 * Chaos, for Claude Code and Codex: a seeded random run of everything a desk does at once — messages,
 * slow turns with messages behind them, agent restarts, stops and resumes, new agents, forks,
 * compactions, windows coming and going, and the daemon itself restarting — and then the daemon's
 * picture of the desk is checked against tmux and the process table. Whatever the order, at the end no
 * two agents share a pane, every active agent has its pane, one engine in it and a conversation, no
 * engine runs in a pane nobody owns, every active agent answers, and the core never crashed.
 *
 * CHAOS_SEED picks the run (a failure prints its seed), CHAOS_OPS its length.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
const SEED = Number(process.env.CHAOS_SEED ?? 20261004)
const OPS = Number(process.env.CHAOS_OPS ?? 70)

/** mulberry32: small, seeded, and the same sequence on every machine. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rows = async (client: LocalClient) =>
  (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId

/** Engine processes per tmux pane, from tmux's own pane list and the process table. */
function enginesByPane(daemon: IsolatedDaemon, panes: Array<{ id: string; pid: number }>): Map<string, number> {
  const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command=']).toString().trim().split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean) as RegExpMatchArray[]
  const children = new Map<number, number[]>()
  for (const [, pid, ppid] of table) children.set(Number(ppid), [...(children.get(Number(ppid)) ?? []), Number(pid)])
  const result = new Map<string, number>()
  for (const pane of panes) {
    const tree = new Set<number>([pane.pid])
    for (const pid of tree) for (const child of children.get(pid) ?? []) tree.add(child)
    // The fake engines' process title is their engine's name, then their arguments, as a CLI's is.
    result.set(pane.id, table.filter(([, pid, , command]) => tree.has(Number(pid)) && /^(claude|codex)(?:\s|$)/.test(command.trim())).length)
  }
  void daemon
  return result
}

describe('chaos', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it(`seed ${SEED}, ${OPS} operations: the desk ends coherent`, async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    const rand = random(SEED)
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]
    const log: string[] = []
    onTestFailed(() => {
      console.log(`---- chaos seed ${SEED}\n${log.join('\n')}`)
      console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`)
      // The whole of it, for a failure that began long before the end.
      if (process.env.CHAOS_LOG) writeFileSync(process.env.CHAOS_LOG, `${log.join('\n')}\n---- daemon log\n${d.log()}`)
    })
    await d.start()
    let client = await LocalClient.connect(d)
    let daemonRestarts = 0
    const unexpected: string[] = []
    // Errors a racing request may honestly get: the agent was busy, gone, or changed under it.
    const EXPECTED = new Set(['AGENT_BUSY', 'STOP_UNCONFIRMED', 'AGENT_NOT_FOUND', 'NOT_FOUND', 'AGENT_CHANGED',
      'RESUME_UNCONFIRMED', 'RESTART_FAILED', 'UNSUPPORTED', 'NOT_STOPPED', 'ALREADY_RUNNING', 'NOT_RUNNING'])
    const expectAnswer = (op: string, answer: Record<string, any>) => {
      if (answer.error && !EXPECTED.has(String(answer.error))) unexpected.push(`${op}: ${JSON.stringify(answer).slice(0, 300)}`)
    }
    let folders = 0
    const create = async (engine: Engine) => {
      const cwd = join(d.projectsDir, `chaos-${folders++}`)
      mkdirSync(cwd, { recursive: true })
      const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
      expectAnswer(`create ${engine}`, created)
      return created.agent?.id as string | undefined
    }
    const known = new Set<string>()
    for (const engine of ['claude', 'codex', 'claude', 'codex'] as const) {
      const id = await create(engine)
      if (id) known.add(id)
    }
    for (const id of known) await until(`${id.slice(0, 8)} to bind`, async () => (await row(client, id))?.sessionId || null, 60_000, 500)

    const live = async () => (await rows(client)).filter((agent) => known.has(agent.id) && agent.status === 'active' && agent.sessionId)
    const stopped = async () => (await rows(client)).filter((agent) => known.has(agent.id) && agent.status === 'stopped')
    const message = async (agentId: string, content: string, ms = 45_000) => {
      const ended = client.next(isTurn('turn_ended', agentId), ms, `turn_ended (${content})`).catch(() => null)
      client.send('message', { agentId, content })
      return ended
    }

    for (let op = 0; op < OPS; op++) {
      const roll = rand()
      const agents = await live()
      const target = agents.length ? pick(agents) : undefined
      try {
        if (roll < 0.30 && target) {
          log.push(`${op} message ${target.id.slice(0, 8)}`)
          await message(target.id, `chaos message ${op}`)
        } else if (roll < 0.40 && target) {
          log.push(`${op} slow turn with a message behind it ${target.id.slice(0, 8)}`)
          client.send('message', { agentId: target.id, content: '!slow 1500' })
          await message(target.id, `behind the slow turn ${op}`, 60_000)
        } else if (roll < 0.48 && target) {
          log.push(`${op} restart ${target.id.slice(0, 8)}`)
          expectAnswer('restart', await client.request('agent_restart', { agentId: target.id }, 90_000))
        } else if (roll < 0.55 && target) {
          log.push(`${op} stop ${target.id.slice(0, 8)}`)
          expectAnswer('stop', await client.request('agent_delete', { agentId: target.id }, 90_000))
        } else if (roll < 0.63) {
          const paused = await stopped()
          if (paused.length) {
            const agent = pick(paused)
            log.push(`${op} resume ${agent.id.slice(0, 8)}`)
            expectAnswer('resume', await client.request('agent_resume', { agentId: agent.id }, 90_000))
          }
        } else if (roll < 0.69 && known.size < 9) {
          const engine = pick(['claude', 'codex'] as const)
          log.push(`${op} create ${engine}`)
          const id = await create(engine)
          if (id) known.add(id)
        } else if (roll < 0.74 && target) {
          log.push(`${op} fork ${target.id.slice(0, 8)}`)
          const forked = await client.request('agent_fork', { agentId: target.id, name: `fork ${op}` }, 90_000)
          expectAnswer('fork', forked)
          const forkId = forked.agent?.id ?? forked.agentId
          if (forkId) known.add(forkId)
        } else if (roll < 0.80 && target) {
          log.push(`${op} compact ${target.id.slice(0, 8)}`)
          await d.tmux.run('send-keys', '-t', target.tmuxPane, '!compact', 'Enter').catch(() => {})
        } else if (roll < 0.88) {
          log.push(`${op} reconnect the window`)
          client.close()
          client = await LocalClient.connect(d)
        } else if (roll < 0.92) {
          log.push(`${op} restart the daemon`)
          client.close()
          await d.restart()
          daemonRestarts++
          client = await LocalClient.connect(d)
        } else if (target) {
          log.push(`${op} two messages at once ${target.id.slice(0, 8)}`)
          client.send('message', { agentId: target.id, content: `first of two ${op}` })
          await message(target.id, `second of two ${op}`, 60_000)
        }
      } catch (error) {
        unexpected.push(`${op}: threw ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Settle: restarts, resumes and binds finish; every scan lands.
    log.push('settle')
    await new Promise((resolve) => setTimeout(resolve, 8_000))
    const desk = (await rows(client)).filter((agent) => known.has(agent.id))
    const active = desk.filter((agent) => agent.status === 'active')
    const paneList = (await d.tmux.run('list-panes', '-a', '-F', '#{pane_id} #{pane_pid}').catch(() => ''))
      .split('\n').filter(Boolean).map((line) => { const [id, pid] = line.split(' '); return { id, pid: Number(pid) } })
    const engines = enginesByPane(d, paneList)
    const report = `rows: ${desk.map((agent) => `${agent.id.slice(0, 8)}=${agent.status}@${agent.tmuxPane ?? '-'}${agent.sessionId ? '' : '(unbound)'}`).join(' ')}\npanes: ${[...engines].map(([pane, n]) => `${pane}:${n}`).join(' ')}`
    log.push(report)

    expect(unexpected, `unexpected answers\n${report}`).toEqual([])
    // No two active agents share a pane, and every active agent has its pane, one engine and a conversation.
    const panesOfActive = active.map((agent) => agent.tmuxPane)
    expect(new Set(panesOfActive).size, `shared panes\n${report}`).toBe(panesOfActive.length)
    for (const agent of active) {
      expect(engines.has(agent.tmuxPane), `${agent.id.slice(0, 8)} active without its pane\n${report}`).toBe(true)
      expect(engines.get(agent.tmuxPane), `${agent.id.slice(0, 8)} should have one engine\n${report}`).toBe(1)
    }
    // No engine runs in a pane no active agent owns: that would be a ghost, or a leak.
    for (const [pane, count] of engines) {
      if (count > 0) expect(panesOfActive, `an engine in ${pane}, owned by no active agent\n${report}`).toContain(pane)
    }
    // Every active agent answers, and has its conversation by then. One can be without it until now: a
    // fork whose start-up announcement fell into a daemon restart has a conversation nobody named yet
    // (only its hook knows the id a fork chose), and its first prompt's hook names it.
    for (const agent of active) {
      const ended = await message(agent.id, 'the last word', 60_000)
      expect(ended, `${agent.id.slice(0, 8)} did not answer at the end\n${report}`).toBeTruthy()
      expect((await row(client, agent.id))?.sessionId, `${agent.id.slice(0, 8)} has no conversation after a message\n${report}`).toBeTruthy()
    }
    expect(d.coresStarted(), `the core restarted on its own\n${report}`).toBe(daemonRestarts + 1)
    client.close()
  }, 900_000)
})
