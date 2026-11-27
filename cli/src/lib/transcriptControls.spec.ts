import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { errorKind } from './log.js'
import { recoveryBoundary } from './transcriptBoundary.js'
import { verifyCloses } from './transcriptControls.js'

let dir = ''
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

it('names a close whose boundary the transcript no longer matches by its code, for the log', () => {
  dir = mkdtempSync(join(tmpdir(), 'transcript-controls-'))
  const file = join(dir, 't.jsonl')
  writeFileSync(file, '{"a":1}\n')
  const boundary = recoveryBoundary(file)
  writeFileSync(file, '{"b":2}\n')
  let thrown: unknown
  try { verifyCloses(file, [{ offset: boundary.offset, reason: 'cancel', boundary }]) } catch (error) { thrown = error }
  expect(errorKind(thrown)).toBe('ENGINE_CONTROL_BOUNDARY_CHANGED')
})
