import { describe, expect, it } from 'vitest'
import { OmpNormalizer } from './normalizer.js'

const line = (value: unknown) => JSON.stringify(value)

describe('OmpNormalizer', () => {
  it('opens a turn on a user message and streams the assistant text', () => {
    const normalizer = new OmpNormalizer()
    const events = [
      ...normalizer.ingest(line({ type: 'session', id: 's1', cwd: '/work' })),
      ...normalizer.ingest(line({ type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'fix the login' }] } })),
      ...normalizer.ingest(line({ type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } })),
    ]
    expect(events.map(event => event.type)).toEqual(['user_message', 'turn_started', 'text_delta'])
    expect(events[2]).toMatchObject({ payload: { content: 'Done.' } })
    expect(normalizer.turnOpen).toBe(true)
  })

  it('closes the open turn when the next user message arrives', () => {
    const normalizer = new OmpNormalizer()
    normalizer.ingest(line({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'one' }] } }))
    const next = normalizer.ingest(line({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'two' }] } }))
    expect(next[0]).toMatchObject({ type: 'turn_ended' })
  })
})
