/**
 * An engine settings file saved with a UTF-8 BOM, as Windows PowerShell 5's `Set-Content -Encoding utf8` writes one: the
 * daemon reads it as its text, installs its hooks and writes it back without the BOM, so a create starts, binds and
 * ends its turn instead of being held for hooks that were never written (lib/settingsText.ts).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'

/** Where the daemon installs each engine's hooks: Claude Code's `~/.claude/settings.json`, Codex's `$CODEX_HOME/hooks.json`. */
const settingsFile = (d: IsolatedDaemon, engine: Engine): string =>
  engine === 'claude' ? join(d.env.HOME!, '.claude', 'settings.json') : join(d.engineConfig.codexHome, 'hooks.json')

const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId

describe('a settings file saved with a BOM', () => {
  let daemon: IsolatedDaemon | undefined
  let client: LocalClient | undefined
  afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })

  it.each<Engine>(['claude', 'codex'])('%s: a settings file that starts with a BOM does not hold a create', async (engine) => {
    const d = daemon = await IsolatedDaemon.create()
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    const file = settingsFile(d, engine)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '﻿{}\n')
    await d.start()
    const c = client = await LocalClient.connect(d)

    const cwd = join(d.projectsDir, `bom-${engine}`)
    mkdirSync(cwd, { recursive: true })
    const created = await c.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    await until('the agent to bind its conversation', async () => {
      const rows = (await c.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents
      const agent = rows.find((one) => one.id === created.agent.id)
      return agent?.sessionId && agent.status === 'active' ? agent : null
    }, 60_000, 500)
    const started = c.next(isTurn('turn_started', created.agent.id), 45_000, 'turn_started')
    const ended = c.next(isTurn('turn_ended', created.agent.id), 45_000, 'turn_ended')
    c.send('message', { agentId: created.agent.id, content: 'after the BOM' })
    await started
    await ended

    expect(readFileSync(file)[0]).toBe('{'.charCodeAt(0))
    expect(d.log()).not.toContain('failed to write')
  })

  // Codex 0.169 reads hooks.json with serde_json, which refuses a BOM, and runs none of its hooks: Harness's own text
  // after one is written again without it, though the text is the same.
  it('codex: a hooks.json of a BOM and Harness\'s own text is written again without the BOM, and its hooks run', async () => {
    const d = daemon = await IsolatedDaemon.create()
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`)
      console.log(`---- hooks the engine ran\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    const file = settingsFile(d, 'codex')
    await d.start()
    await d.hooksInstalled(['codex'])
    const own = readFileSync(file, 'utf8')
    await d.stop()
    writeFileSync(file, `﻿${own}`)
    await d.start()
    await d.hooksInstalled(['codex'])
    expect(readFileSync(file, 'utf8')).toBe(own)
    const c = client = await LocalClient.connect(d)

    const cwd = join(d.projectsDir, 'bom-codex-own')
    mkdirSync(cwd, { recursive: true })
    const created = await c.request('agent_create', { engine: 'codex', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agent = await until('the agent to bind its conversation', async () => {
      const rows = (await c.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents
      const found = rows.find((one) => one.id === created.agent.id)
      return found?.sessionId && found.status === 'active' ? found : null
    }, 60_000, 500)
    const ended = c.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    c.send('message', { agentId: agent.id, content: 'after the BOM' })
    await ended
    await until('the engine to run its Stop', () => d.hookLog().includes(` Stop session=${agent.sessionId} ran`) || null, 30_000, 50)
    expect(d.hookLog()).not.toContain('hooks not loaded')
  })
})
