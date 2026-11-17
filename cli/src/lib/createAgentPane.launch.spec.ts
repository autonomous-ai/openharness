/** A registration retry is a new dispatch and must select current owner-built launch data again. */
import { expect, it, vi } from 'vitest'
import { createAndRegisterPane } from './createAgentPane.js'
import type { TerminalCreateRequest } from './terminalTypes.js'
import { launchSettingsArgs } from '../engines/kit/launchValues.js'

it.each(['optional', 'required'] as const)('rechecks %s authority after registration failure and pane cleanup', async changed => {
  let optionalCurrent = true, nativeCurrent = true, attempt = 0
  const values = { instructions: 'optional instruction', settings: null }
  const launch = vi.fn(() => ['claude', ...launchSettingsArgs('claude', ['--model', 'owner'], { values, current: () => optionalCurrent })])
  const commands: string[][] = []
  const onDispatch = vi.fn(() => launch)
  const create = vi.fn(async (request: TerminalCreateRequest) => {
    if (request.current?.() === false) return { state: 'failed', dispatch: 'not_started', reason: 'changed' }
    const command = await request.onDispatch?.()
    if (request.current?.() === false) return { state: 'failed', dispatch: 'not_started', reason: 'changed' }
    commands.push(command ? command() : request.command ?? [])
    return { state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId: `%${++attempt}` } }
  })
  const kill = vi.fn(async () => { if (changed === 'optional') optionalCurrent = false; else nativeCurrent = false })
  const openPendingAgent = vi.fn(async () => attempt === 1 ? null : { agentId: 'fixture', engine: 'claude' })
  const result = await createAndRegisterPane({ engine: 'claude', sessionLabel: 'fixture', argv: ['preflight'], onDispatch, paneLaunch: { cwd: 'C:\\work', afterExit: { command: ['pwsh.exe'] } },
    current: () => nativeCurrent, tmuxBackend: { create, kill }, registry: { openPendingAgent } } as never)
  expect(commands[0]).toEqual(['claude', '--model', 'owner', '--append-system-prompt', 'optional instruction'])
  expect(create.mock.calls[0]?.[0]).toMatchObject({ command: ['preflight'], cwd: 'C:\\work' })
  if (changed === 'optional') {
    expect(result.ok).toBe(true)
    expect(launch).toHaveBeenCalledTimes(2)
    expect(commands[1]).toEqual(['claude', '--model', 'owner'])
    expect(create.mock.calls[1]?.[0]).toMatchObject({ command: ['preflight'], cwd: 'C:\\work', afterExit: { command: ['pwsh.exe'] } })
  } else {
    expect(result.ok).toBe(false)
    expect(commands).toHaveLength(1)
    expect(launch).toHaveBeenCalledTimes(1)
  }
  expect(onDispatch).toHaveBeenCalledTimes(changed === 'optional' ? 2 : 1)
  expect(kill).toHaveBeenCalledTimes(1)
})
