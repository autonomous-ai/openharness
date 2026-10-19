import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from './driver.mts'

function captureOpen() {
  const client = new Client()
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  client.ws = {
    send(data: string) {
      const frame = JSON.parse(data)
      sent.push(frame)
      client.frames.push({
        type: 'terminal_ready',
        payload: { requestId: frame.payload.requestId, streamId: 'test-stream' },
      })
    },
  } as unknown as WebSocket
  return { client, sent }
}

test('a passive screen open watches without taking the Desktop terminal or changing its size', async () => {
  const { client, sent } = captureOpen()
  await client.open('owned-terminal', 120, 40, { passive: true })

  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'terminal_open')
  assert.deepEqual(sent[0].payload, {
    requestId: sent[0].payload.requestId,
    agentId: 'owned-terminal',
    cols: 120,
    rows: 40,
    protocolVersion: 3,
    takeover: false,
    watch: true,
  })
})

test('an ordinary open still requests control for typing', async () => {
  const { client, sent } = captureOpen()
  await client.open('owned-terminal', 120, 40)

  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].payload, {
    requestId: sent[0].payload.requestId,
    agentId: 'owned-terminal',
    cols: 120,
    rows: 40,
    protocolVersion: 3,
  })
})
