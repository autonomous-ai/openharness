import { expect, it, vi } from 'vitest'
import { parseSuperTabArgs, superTabCommand } from './command.js'
const where = { port: 14001, dataDir: '/fixture', machineId: 'machine' }
const prefix = ['--tab', 'tab', '--agent', 'agent']
it('keeps an explicit stable receipt for agent messages and arbitrary work commands', () => {
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', 'Ready', 'op-1'], where).payload).toMatchObject({ action: 'command', operationId: 'op-1', command: { type: 'message.send', conversationId: 'lead', text: 'Ready' } })
  expect(parseSuperTabArgs([...prefix, 'command', 'op-2', '{"type":"work.assign"}'], where).payload).toMatchObject({ command: { type: 'work.assign' } })
  expect(parseSuperTabArgs(['--port', '14002', '--machine', 'target', ...prefix, 'messages', 'lead'], where)).toMatchObject({ where: { port: 14002, machineId: 'target' }, payload: { conversationId: 'lead' } })
  expect(parseSuperTabArgs(['help'], where).payload.action).toBe('help')
  expect(parseSuperTabArgs([...prefix, 'message', 'lead', 'old-question'], where).payload)
    .toMatchObject({ action: 'message', conversationId: 'lead', messageId: 'old-question' })
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', '--tab', 'literal'], where).payload.command).toMatchObject({ text: '--tab' })
  expect(parseSuperTabArgs(['--tab', 'tab', 'status'], where).payload.agentId).toBe('')
  for (const argv of [[], ['status'], [...prefix, 'post', 'lead', 'Ready'], [...prefix, 'messages', '../other'],
    [...prefix, 'message', 'lead'], [...prefix, 'message', 'lead', '../other'], [...prefix, 'message', 'lead', 'id', 'extra'],
    ['--port', 'no', 'help'], ['--machine', '', 'help'], [...prefix, 'status', 'extra'], [...prefix, 'route', 'g1'], [...prefix, 'route', '../x', '{}']]) {
    expect(() => parseSuperTabArgs(argv, where)).toThrow('harness super-tab')
  }
})
it('finds the native caller without requiring an ID in the initial launch prompt', async () => {
  const request = vi.fn(async (type: string) => type === 'agents_list'
    ? { agents: [{ id: 'native', engine: 'codex', tmuxPane: '%42', status: 'active' }] }
    : { ok: true })
  const close = vi.fn(), print = vi.fn()
  const deps = { where: () => where, pane: '%42', open: async () => ({ request, close, machineId: 'machine' }), print }
  expect(await superTabCommand(['--tab', 'tab', 'status'], deps)).toBe(0)
  expect(request).toHaveBeenLastCalledWith('super_tabs', expect.objectContaining({ harnessId: 'native' }), 30_000)
  expect(await superTabCommand(['--tab', 'tab', 'status'], { ...deps, pane: '%43' })).toBe(1)
  expect(print.mock.calls.at(-1)![0]).toContain('inside the participating harness')
  expect(close).toHaveBeenCalledTimes(2)
})
it('uses the existing daemon transport and retains a receipt in an uncertain answer', async () => {
  const print = vi.fn(), close = vi.fn(), request = vi.fn(async () => ({ ok: true }))
  const open = vi.fn(async () => ({ request, close, machineId: 'machine' }))
  const deps = { where: () => where, open, print }
  expect(await superTabCommand([...prefix, 'post', 'lead', 'Ready', 'op'], deps)).toBe(0)
  expect(close).toHaveBeenCalledOnce()
  request.mockRejectedValueOnce(new Error('Connection lost'))
  expect(await superTabCommand([...prefix, 'post', 'lead', 'Ready', 'op'], deps)).toBe(1)
  expect(JSON.parse(print.mock.calls.at(-1)![0])).toEqual({ error: 'Connection lost', operationId: 'op' })
  expect(close).toHaveBeenCalledTimes(2)
})
it('parses route GROUP JSON', () => {
  expect(parseSuperTabArgs([...prefix, 'route', 'g1', '{"difficulty":"low","risk":"low","why":"x"}'], where).payload)
    .toMatchObject({ action: 'route', conversationId: 'g1', assessment: { difficulty: 'low' } })
})
it('routes through the caller and prints the decision, or the parse failure as an error', async () => {
  const print = vi.fn(), close = vi.fn()
  const request = vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
    if (type === 'agents_list') return { agents: [{ id: 'native', engine: 'claude', tmuxPane: '%42', status: 'active' }] }
    if (payload.action === 'routeContext') return { error: 'AGENT_UNAVAILABLE', detail: 'x' }
    return { ok: true }
  })
  const deps = { where: () => where, pane: '%42', open: async () => ({ request, close, machineId: 'machine' }), print }
  expect(await superTabCommand(['--tab', 'tab', 'route', 'g1', '{"difficulty":"low","risk":"low","why":"x"}'], deps)).toBe(1)
  expect(request).toHaveBeenCalledWith('super_tabs', expect.objectContaining({ action: 'routeContext', tabId: 'tab', harnessId: 'native' }), 30_000)
  expect(JSON.parse(print.mock.calls.at(-1)![0])).toMatchObject({ error: 'AGENT_UNAVAILABLE' })
  expect(await superTabCommand(['--tab', 'tab', 'route', 'g1', '{nope'], deps)).toBe(1)
  expect(JSON.parse(print.mock.calls.at(-1)![0]).error).toMatch(/JSON/)
})
