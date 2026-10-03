import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentNotifications } from './agentNotifications.js'
import { CommanderMirror, type CommanderFrame, type CommanderMirrorOpts } from './commander.js'
import type { LiveEvent } from './normalize.js'

let dataDir: string
beforeEach(() => { vi.useFakeTimers(); dataDir = mkdtempSync(join(tmpdir(), 'harness-notifications-')) })
afterEach(() => { vi.useRealTimers(); rmSync(dataDir, { recursive: true, force: true }) })

const turn: LiveEvent[] = [
  { type: 'turn_started', payload: { userMessage: 'Fix it' } },
  { type: 'text_delta', payload: { content: 'The fix is complete.' } },
  { type: 'turn_ended', payload: {} },
]

function setup(options: Partial<CommanderMirrorOpts> = {}) {
  const device: CommanderFrame[] = [], desktop: Record<string, any>[] = []
  const summarize = vi.fn(async () => 'The fix is complete.\n\nTests passed.')
  const policy = new AgentNotifications()
  const mirror = new CommanderMirror({
    dataDir, notifications: policy, notifyWithoutDevice: true,
    send: f => device.push(f), sendWeb: f => desktop.push(f),
    hasDevice: () => true, summarize, summarizeIsLocal: true,
    agentIdFor: () => 'agent', ...options,
  })
  return { mirror, device, desktop, summarize, policy }
}

describe('one completed-result decision for desktop and device', () => {
  it('sends the same notification to both while keeping live cards intact', async () => {
    const { mirror, device, desktop } = setup()
    mirror.ingest([
      turn[0], { type: 'tool_start', payload: { id: 't', tool: 'Read', input: { path: '/work/file' } } },
      turn[1], turn[2],
    ], 's')
    expect(device.map(f => f.payload.kind)).toEqual(['processing', 'tool'])
    expect(device[1].payload).toEqual({ kind: 'tool', text: 'Read', recap: '/work/file', color: '#61afef', detail: 'path: /work/file' })
    await vi.runAllTimersAsync()
    expect(device.map(f => f.payload.kind)).toEqual(['processing', 'tool', 'done', 'summary'])
    expect(desktop).toHaveLength(1)
    expect(desktop[0].payload.notification).toEqual(device.at(-1)?.payload.notification)
    expect(desktop[0].agentId).toBe('agent')
    expect(desktop[0].payload.notification.kind).toBe('done')
  })

  it('works without hardware and does not start a paid recap call', async () => {
    const { mirror, desktop, device, summarize } = setup({ hasDevice: () => false, summarizeIsLocal: false })
    mirror.ingest(turn, 's')
    await vi.runAllTimersAsync()
    expect(summarize).not.toHaveBeenCalled()
    expect(device).toEqual([])
    expect(desktop[0].payload.notification.kind).toBe('done')
    expect(mirror.recent('s')[0].text).toContain('The fix is complete.')
  })

  it.each(['null', 'empty', 'error'] as const)('does not turn live commentary into an answer when the final reader returns %s', async mode => {
    const { mirror, desktop, device } = setup({ readLastTurn: async () => {
      if (mode === 'error') throw new Error('Unavailable transcript')
      return mode === 'null' ? null : { userMessage: 'Fix it', assistantText: '' }
    } })
    mirror.ingest(turn, 's')
    await vi.runAllTimersAsync()
    expect(desktop).toEqual([])
    expect(device.at(-1)?.payload.kind).toBe('done')
  })

  it.each(['replay', 'subagent', 'question'] as const)('updates device recaps silently for %s, with no desktop notification', async mode => {
    const { mirror, desktop, device, policy } = setup({ isSubagent: () => mode === 'subagent' })
    mirror.ingest([turn[0]], 's', { replay: mode === 'replay' })
    if (mode === 'question') {
      policy.asked('s', 'q')
      policy.answered('s', 'q')
    }
    mirror.ingest(turn.slice(1), 's', { replay: mode === 'replay' })
    await vi.runAllTimersAsync()
    expect(desktop[0].payload.notification).toBeNull()
    expect(device.at(-1)?.payload.subagent).toBe(true)
  })

  it('ignores aborted, duplicate and superseded ends', async () => {
    const { mirror, desktop } = setup()
    mirror.ingest([turn[0], turn[1], { type: 'turn_ended', payload: { aborted: true } }], 'aborted')
    mirror.ingest(turn, 'superseded')
    mirror.ingest([turn[0]], 'superseded')
    mirror.ingest([...turn, turn[2]], 'finished')
    await vi.runAllTimersAsync()
    expect(desktop.filter(f => f.payload.notification)).toHaveLength(1)
    expect(desktop[0].dbSessionId).toBe('finished')
  })

  it('announces a live completion after attaching midway through the turn', async () => {
    const { mirror, desktop } = setup()
    mirror.ingest([turn[0]], 's', { replay: true })
    mirror.ingest([turn[1]], 's', { replay: true })
    mirror.ingest(turn.slice(1), 's')
    await vi.runAllTimersAsync()
    expect(desktop[0].payload.notification.kind).toBe('done')
  })
})
