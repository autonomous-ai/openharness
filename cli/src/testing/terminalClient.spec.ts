import { expect, it } from 'vitest'
import { Terminal } from '../../e2e/harness/terminal.js'
import type { LocalClient, Frame } from '../../e2e/harness/client.js'
import { TerminalBinaryKind, type TerminalBinaryClear } from '../lib/terminalBinary.js'

it('keeps the opening screen when terminal_ready and its keyframe arrive together', async () => {
  const keyframe: TerminalBinaryClear = {
    kind: TerminalBinaryKind.keyframe, streamId: 'opened', seq: 0, compressed: false,
    bytes: Buffer.from('the engine is ready'),
  }
  const binaries: TerminalBinaryClear[] = [{ ...keyframe, streamId: 'older' }]
  let accepts!: (frame: Frame) => boolean
  let answer!: (frame: Frame) => void
  const client = {
    binaries,
    next(test: (frame: Frame) => boolean) {
      accepts = test
      return new Promise<Frame>((resolve) => { answer = resolve })
    },
    send(_type: string, payload: Record<string, unknown>) {
      const ready = { type: 'terminal_ready', payload: { requestId: payload.requestId, streamId: 'opened' } }
      expect(accepts(ready)).toBe(true)
      // Found by QA on a quiet machine: ws can deliver both frames in one socket callback,
      // before the await of terminal_ready continues. The test window must keep that screen.
      answer(ready)
      binaries.push({ ...keyframe, streamId: 'another-window' }, keyframe)
    },
  } as unknown as LocalClient

  const terminal = await Terminal.open(client, 'agent')
  expect(terminal.frames()).toEqual([keyframe])
  expect(terminal.screen()).toBe('the engine is ready')
})
