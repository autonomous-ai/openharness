import { describe, expect, it } from 'vitest'
import { SURFACE_DOWN_TYPES, SURFACE_UP_TYPES, VIEWER_DOWN_TYPES, VIEWER_UP_TYPES } from './viewerFrames.js'
import { encryptDownFrame, encryptDownFrameFor, encryptRpcResult } from './e2ee/applicationFrames.js'

describe('surface frame names', () => {
  it('never collide with the viewer proxy frames', () => {
    for (const t of [...SURFACE_DOWN_TYPES, ...SURFACE_UP_TYPES]) {
      expect(VIEWER_DOWN_TYPES.has(t) || VIEWER_UP_TYPES.has(t)).toBe(false)
      expect(t.startsWith('surface_')).toBe(true)
    }
    expect([...SURFACE_DOWN_TYPES].sort()).toEqual(['surface_ack', 'surface_close', 'surface_input', 'surface_open'])
    expect([...SURFACE_UP_TYPES].sort()).toEqual(['surface_error', 'surface_state'])
  })
  it('are sealed: down frames always, up frames on the way out', () => {
    for (const t of SURFACE_DOWN_TYPES) {
      expect(encryptDownFrame(t)).toBe(true)
      expect(encryptDownFrameFor(t, { strictDown: false })).toBe(true)
    }
    for (const t of SURFACE_UP_TYPES) expect(encryptRpcResult(t)).toBe(true)
  })
})
