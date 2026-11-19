/**
 * A pane agent's Stop that reaches a held core. On Linux the engine's `/bin/sh -c` is dash, which stays the hook's
 * parent and exits with it. The hook waits 500 ms for an answer and leaves; a core held past that read the process
 * table after the shell had gone, found no engine above the caller the hook named, and refused its Stop as unbound.
 * On macOS `/bin/sh` execs the hook, so the caller is the engine itself and this passes with or without the fix.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Row = Record<string, any>

/** Far past the hook's 500 ms wait for a reply, far inside the master's 40 s. */
const HOLD_MS = 4_000
const TURN_MS = 45_000
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
/** The Stop hooks the fake engine has seen end, for this session (fakeEngine.mjs notes each once its shell has exited). */
const stopsRan = (d: IsolatedDaemon, sessionId: string): number =>
  d.hookLog().split('\n').filter((line) => line.includes(` Stop session=${sessionId} `)).length

describe('a Stop hook that reaches a held core', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it('claude: its Stop ends the turn once the core lets go, though the hook and its shell have exited', async () => {
    // No period and no `/spawn`: the core is held only on SIGUSR2, and at once.
    const d = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: `core.stall:${HOLD_MS}` } })
    daemon = d
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`)
      console.log(`---- hooks the engine ran\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    await d.start()
    await until('the stalls to be armed', () => /\[stall\] armed/.test(d.log()) || null, 30_000, 100)
    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'held-core-stop')
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agent = await until('the agent to bind its conversation', async () => {
      const rows = (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
      const now = rows.find((row) => row.id === created.agent.id)
      return now?.sessionId && now.status === 'active' ? now : null
    }, 60_000, 500)
    // Its first plain turn makes the session's turns end by hook.
    await client.turn(agent.id, 'a first plain turn', TURN_MS)

    const release = join(d.engineConfig.root, 'held-stop.release')
    const since = client.frames.length
    client.send('message', { agentId: agent.id, content: '!heldstop' })
    // The engine has started its Stop hook under its `/bin/sh -c`, and the hook waits for the release.
    await until('the Stop hook to start', () => existsSync(`${release}.started`) || null, 45_000, 20)
    const before = stopsRan(d, agent.sessionId)
    process.kill(d.corePid()!, 'SIGUSR2')
    // What the core logs after this line, it logs after the hold. The first turn's own Stop line is before it,
    // though it can reach this log after that turn's end was read: a mark taken earlier counted it as this turn's.
    const held = await until('the core to be held', () => {
      const at = d.log().indexOf('[stall] holding the event loop')
      return at >= 0 ? at : null
    }, 10_000, 10)
    writeFileSync(release, 'go')
    await until('the Stop hook and its shell to exit', () => stopsRan(d, agent.sessionId) > before || null, 30_000, 20)
    expect(d.log().slice(held), 'the hook and its shell left while the core was still held').not.toMatch(/turn-stop|unmatched/)
    await until('the core to answer the Stop', () => /\[hooks\] \S+ turn-stop/.test(d.log().slice(held)) || null, HOLD_MS + 30_000, 50)
    const log = d.log().slice(held)
    expect(log).not.toMatch(/turn-stop refused · unbound/)
    expect(log).not.toMatch(/caller is not a descendant of that engine process/)
    expect(log).toMatch(/\[hooks\] \S+ turn-stop$/m)
    await until('the turn to end', () => client.frames.slice(since).some(isTurn('turn_ended', agent.id)) || null, 30_000, 50)
    expect(client.frames.slice(since).filter(isTurn('turn_ended', agent.id))).toHaveLength(1)
    client.close()
  }, 240_000)
})
