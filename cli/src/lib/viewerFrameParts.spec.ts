import { describe, expect, it } from 'vitest'
import { decodeTerminalPlain, encodeTerminalPlain, TerminalBinaryKind, flagsFor } from './terminalBinary.js'
import { splitViewerFrame, surfaceStreamId, VIEWER_PART_BYTES } from './viewerFrameParts.js'

const SURFACE = '0123456789abcdef0123456789abcdef'
const meta = { width: 390, height: 844, scale: 3 }

describe('viewer frame parts', () => {
  it('maps a 32-hex surface id to a stream id and refuses anything else', () => {
    expect(surfaceStreamId(SURFACE)).toBe('01234567-89ab-cdef-0123-456789abcdef')
    expect(surfaceStreamId('e2e')).toBeNull()
    expect(surfaceStreamId(SURFACE.toUpperCase())).toBeNull()
  })
  it('splits and reassembles a 3-part frame, each part under the channel limit', () => {
    const jpeg = new Uint8Array(VIEWER_PART_BYTES * 2 + 17).map((_, i) => i % 251)
    const parts = splitViewerFrame(SURFACE, 7, jpeg, meta)!
    expect(parts.map(p => p.viewer!.part)).toEqual([0, 1, 2])
    expect(parts.every(p => p.viewer!.parts === 3 && p.seq === 7 && p.kind === TerminalBinaryKind.viewerFrame)).toBe(true)
    const decoded = parts.map(p => decodeTerminalPlain(p.kind, flagsFor(p), encodeTerminalPlain(p)!)!)
    expect(decoded[1].viewer).toEqual({ part: 1, parts: 3, width: 390, height: 844, scale: 3 })
    expect(decoded[1].streamId).toBe(surfaceStreamId(SURFACE))
    const joined = Buffer.concat(decoded.map(d => Buffer.from(d.bytes)))
    expect(joined.equals(Buffer.from(jpeg))).toBe(true)
    for (const p of parts) expect(encodeTerminalPlain(p)!.length).toBeLessThanOrEqual(VIEWER_PART_BYTES + 64)
  })
  it('refuses an empty frame, a bad surface id, or more than 16 parts', () => {
    expect(splitViewerFrame(SURFACE, 1, new Uint8Array(0), meta)).toBeNull()
    expect(splitViewerFrame('nope', 1, new Uint8Array(4), meta)).toBeNull()
    expect(splitViewerFrame(SURFACE, 1, new Uint8Array(VIEWER_PART_BYTES * 16 + 1), meta)).toBeNull()
  })
})
