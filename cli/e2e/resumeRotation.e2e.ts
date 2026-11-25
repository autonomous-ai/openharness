/**
 * A resumed agent whose engine starts a new conversation before any hook of the resumed one reached the daemon: Codex
 * runs a conversation's SessionStart only inside a turn, so after a `/new` typed first, the next prompt's SessionStart
 * (`clear`), UserPromptSubmit and turn are the first hooks the resumed process sends; a Claude Code whose resume hook
 * was lost (killed at its timeout on a loaded machine) reaches `/clear`'s SessionStart the same way. The
 * engine's own verified process reports the new conversation, so the agent follows it as a rotation instead of failing
 * with RESUME_SESSION_MISMATCH, and the resumed row's untimed binding orders nothing, so the new conversation's hook is
 * not held as HOOK_ORDER_AMBIGUOUS or refused as stale (registry.ts register, core/engines/admissionOrder.ts).
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { fakeEngineShim, IsolatedDaemon, until, type EngineConfig } from './harness/daemon.js'
import { sid } from '../src/lib/log.js'

type Engine = 'claude' | 'codex'

const rows = async (client: LocalClient) =>
  (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
/** A turn, started and ended: Codex's Stop arrives right after its UserPromptSubmit, so its end is what is waited on. */
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const started = client.next(isTurn('turn_started', agentId), 45_000, `turn_started (${content})`)
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  // Together: a turn that never starts fails the case once, not again as its end's unhandled timeout.
  await Promise.all([started, ended])
}
/** The engine as the next launch runs it: its config plus what the case says, renamed over the old wrapper. */
function install(d: IsolatedDaemon, engine: Engine, extra: Partial<EngineConfig>): void {
  const wrapper = join(d.root, 'bin', engine)
  writeFileSync(`${wrapper}.new`, fakeEngineShim(engine, { ...d.engineConfig, ...extra }), { mode: 0o755 })
  renameSync(`${wrapper}.new`, wrapper)
}

describe('a resumed agent takes a new conversation', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it.each<[string, Engine, Partial<EngineConfig>]>([
    ['Codex: a resumed agent whose first input starts a new conversation binds it, and its turn ends', 'codex', { lazySessionStart: true }],
    ['Claude Code: a /clear on a resumed agent whose resume hook was lost binds the new conversation', 'claude', { lostHooks: ['SessionStart:resume'] }],
  ])('%s', async (_name, engine, resumedEngine) => {
    const d = daemon = await IsolatedDaemon.create()
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const client = await LocalClient.connect(d)

    const cwd = join(d.projectsDir, `resume-rotation-${engine}`)
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agentId: string = created.agent.id
    const first = await until('the agent to bind its conversation', async () => {
      const now = await row(client, agentId)
      return now?.sessionId && now.status === 'active' ? now : null
    }, 60_000, 500)
    await turn(client, agentId, 'in the saved conversation')

    expect((await client.request('agent_delete', { agentId }, 60_000)).error).toBeUndefined()
    await until('the agent to stop', async () => (await row(client, agentId))?.status === 'stopped' || null, 45_000, 500)
    install(d, engine, resumedEngine)
    expect((await client.request('agent_resume', { agentId }, 90_000)).error).toBeUndefined()
    const resumed = await until('the agent to be active on the saved conversation', async () => {
      const now = await row(client, agentId)
      return now?.status === 'active' && now.sessionId === first.sessionId && now.tmuxPane ? now : null
    }, 60_000, 500)

    // Typed into the pane before any prompt, as a person starts a new conversation: no hook of the resumed one came.
    await d.tmux.run('send-keys', '-t', resumed.tmuxPane, '!clear', 'Enter')
    const bound = () => until('the agent to bind the new conversation', async () => {
      const now = await row(client, agentId)
      return now?.status === 'active' && now.sessionId && now.sessionId !== first.sessionId ? now : null
    }, 30_000, 250)
    // Claude Code announces the new conversation at once; Codex sends nothing until the next prompt, whose
    // SessionStart, UserPromptSubmit and turn arrive together.
    const announced = engine === 'claude' ? await bound() : null
    await turn(client, agentId, 'in the new conversation')
    const rotated = await bound()
    if (announced) expect(rotated.sessionId).toBe(announced.sessionId)
    expect(rotated.launch?.state).not.toBe('failed')

    // The words the old guard logged as it failed the row (registry.ts `traceLaunch`).
    const refused = d.log().split('\n').filter((line) => line.includes('resume conversation mismatch')
      || (line.includes(sid(rotated.sessionId)) && /HOOK_ORDER_AMBIGUOUS|stale_hook/.test(line)))
    expect(refused).toEqual([])
    client.close()
  })
})
