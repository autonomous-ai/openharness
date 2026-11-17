import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_PROMPT, CLAUDE_REWIND_LIST } from '../../lib/__fixtures__/rewindPickers.js'
import * as pane from '../kit/pane.js'
import { inspectRuntimePane, paneModal, screen } from './screen.js'

describe('Claude screen reading work', () => {
  it.each([
    { name: 'full prompt', capture: CLAUDE_PROMPT, read: screen.inspect, expected: { pane: { idle: true, dialog: false }, messageHold: null } },
    { name: 'full rewind', capture: CLAUDE_REWIND_LIST, read: screen.inspect, expected: { pane: { idle: false, dialog: true }, messageHold: 'rewind_picker_open' } },
    { name: 'standalone pane', capture: CLAUDE_PROMPT, read: inspectRuntimePane, expected: { idle: true, dialog: false } },
  ])('normalizes the takeover capture once for $name', ({ capture, read, expected }) => {
    // The input profile found full-capture normalization repeated by the same takeover reading.
    // Keep the real parser and count its work at the public reader, without a timing threshold.
    const normalize = vi.spyOn(pane, 'stripAnsi')
    let reading: ReturnType<typeof read>
    let fullCaptureReads: number
    try {
      reading = read(capture)
      fullCaptureReads = normalize.mock.calls.filter(([value]) => value === capture).length
    } finally { normalize.mockRestore() }
    expect(reading).toMatchObject(expected)
    expect(fullCaptureReads).toBe(1)
  })

  it('normalizes the takeover capture once for a standalone modal', () => {
    const normalize = vi.spyOn(pane, 'stripAnsi')
    let modal: ReturnType<typeof paneModal>
    let fullCaptureReads: number
    try {
      modal = paneModal(CLAUDE_REWIND_LIST)
      fullCaptureReads = normalize.mock.calls.filter(([value]) => value === CLAUDE_REWIND_LIST).length
    } finally { normalize.mockRestore() }
    expect(modal).toBe('rewind')
    expect(fullCaptureReads).toBe(1)
  })
})
