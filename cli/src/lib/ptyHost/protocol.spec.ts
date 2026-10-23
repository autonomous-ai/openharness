import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  encodeFrame,
  FrameKind,
  FrameReader,
  helloAuth,
  helloProof,
  MAX_FRAME,
  PTY_PROTOCOL,
  SUPPORTED_PTY_PROTOCOLS,
  type HelloLine,
  type PtyOp,
  type PtyOpOf,
} from './protocol.js'

// A bump no longer needs a pin here: the updater holds a CLI whose `PTY_PROTOCOL` is above the installed host's back
// until a payload of that protocol goes in first, in the same handover (lib/selfUpdate.ts `installedPtyProtocol`; the
// delivery rule is tested in selfUpdate.spec.ts, "a build needing a newer pty protocol waits, then stages once the host
// has it", and the pair in windows/ptyUpdate.spec.ts). What still holds is that the daemon reaches the hosts of its own
// protocol.
it('a CLI needing a protocol above the installed host\'s waits (the delivery rule replaces the pin)', () => {
  expect(SUPPORTED_PTY_PROTOCOLS).toContain(PTY_PROTOCOL)
})

describe('ptyHost protocol framing', () => {
  it('decodes frames split across chunks', () => {
    const frame = encodeFrame(FrameKind.Output, Buffer.from([0, 0, 0, 0, 0, 0, 0, 1, 104, 105]))
    const reader = new FrameReader()
    expect(reader.push(frame.subarray(0, 3))).toEqual([])
    const [out] = reader.push(frame.subarray(3))
    expect(out.kind).toBe(FrameKind.Output)
    expect(Buffer.from(out.payload.subarray(8)).toString()).toBe('hi')
  })

  it('decodes several frames from one chunk and keeps the remainder', () => {
    const a = encodeFrame(FrameKind.Pause, Buffer.alloc(0))
    const b = encodeFrame(FrameKind.Paste, Buffer.from('xyz'))
    const reader = new FrameReader()
    const got = reader.push(Buffer.concat([a, b.subarray(0, 4)]))
    expect(got.map(f => f.kind)).toEqual([FrameKind.Pause])
    const rest = reader.push(b.subarray(4))
    expect(rest).toHaveLength(1)
    expect(rest[0].payload.toString()).toBe('xyz')
  })

  it('matches the wire layout [kind][u32 BE len][payload]', () => {
    const f = encodeFrame(FrameKind.Resize, Buffer.from('ab'))
    expect([...f]).toEqual([4, 0, 0, 0, 2, 97, 98])
  })

  it('rejects frames over 8 MiB by throwing from push', () => {
    const head = Buffer.alloc(5)
    head.writeUInt8(FrameKind.Output, 0)
    head.writeUInt32BE(MAX_FRAME + 1, 1)
    expect(() => new FrameReader().push(head)).toThrow(/too large/)
    expect(() => encodeFrame(FrameKind.Output, Buffer.alloc(MAX_FRAME + 1))).toThrow(/too large/)
  })

  it('accepts a frame of exactly 8 MiB', () => {
    const f = encodeFrame(FrameKind.Output, Buffer.alloc(MAX_FRAME))
    const [out] = new FrameReader().push(f)
    expect(out.payload.length).toBe(MAX_FRAME)
  })

  it('reads an 8 MiB frame fed in 1 KiB chunks in linear time', () => {
    const payload = Buffer.alloc(MAX_FRAME, 7)
    const frame = encodeFrame(FrameKind.Output, payload)
    const reader = new FrameReader()
    const started = performance.now()
    let got: ReturnType<FrameReader['push']> = []
    for (let at = 0; at < frame.length; at += 1024) got = got.concat(reader.push(frame.subarray(at, at + 1024)))
    // Joining the whole backlog per chunk (8192 chunks) took over 3 s on an M-series Mac; linear
    // reading takes tens of milliseconds.
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(got).toHaveLength(1)
    expect(got[0].payload.equals(payload)).toBe(true)
  })

  it('reads frames whose header and payload span many chunks, one byte at a time', () => {
    const frames = [
      encodeFrame(FrameKind.Output, Buffer.from('abc')),
      encodeFrame(FrameKind.Pause, Buffer.alloc(0)),
      encodeFrame(FrameKind.Ack, Buffer.from('{"ok":true}')),
    ]
    const wire = Buffer.concat(frames)
    const reader = new FrameReader()
    const got = []
    for (const byte of wire) got.push(...reader.push(Buffer.from([byte])))
    expect(got.map(f => [f.kind, f.payload.toString()])).toEqual([
      [FrameKind.Output, 'abc'],
      [FrameKind.Pause, ''],
      [FrameKind.Ack, '{"ok":true}'],
    ])
    expect(reader.push(Buffer.alloc(0))).toEqual([])
  })

  it('does not keep a reference to the caller\'s chunk', () => {
    const chunk = Buffer.from(encodeFrame(FrameKind.Output, Buffer.from('xyz')))
    const reader = new FrameReader()
    reader.push(chunk.subarray(0, 6))
    chunk.fill(0)
    const [out] = reader.push(Buffer.from('yz'))
    expect(out.payload.toString()).toBe('xyz')
  })

  it('rejects unknown frame kinds', () => {
    expect(() => new FrameReader().push(Buffer.from([99, 0, 0, 0, 0]))).toThrow(/unknown frame kind/)
  })
})

describe('ptyHost protocol messages', () => {
  it('exposes a positive protocol number for the hello line', () => {
    const hello: HelloLine = {
      hello: { auth: helloAuth('t', 'ab'.repeat(32)), nonce: 'ab'.repeat(32), protocol: PTY_PROTOCOL, role: 'control', clientId: 'c' },
    }
    expect(JSON.parse(JSON.stringify(hello)).hello.protocol).toBe(PTY_PROTOCOL)
    expect(PTY_PROTOCOL).toBeGreaterThan(0)
  })

  it('proves the token as the host does: hex SHA-256 of token, a separator byte, nonce (pty/src/protocol.rs)', () => {
    // The same vectors as protocol.rs `the_hello_auth_and_proof_are_sha256_of_token_separator_nonce`.
    expect(helloProof('tok', 'ab'.repeat(32))).toBe('b981c336c08b0e9e5d9798d723e2a76ad73ae2162afc266c976d28689a8a4d5d')
    expect(helloAuth('tok', 'ab'.repeat(32))).toBe('a495f777a3d1a2e8fc2c5db3af651dfa5ea3b5d1813fd62f83934c1571f5628d')
    expect(helloProof('tok2', 'ab'.repeat(32))).not.toBe(helloProof('tok', 'ab'.repeat(32)))
  })

  it('serialises ops with wire (camelCase) field names', () => {
    const ops: PtyOp[] = [
      { op: 'holdOpen', pane: '%1' },
      { op: 'respawn', pane: '%1', command: ['sh'], expectedHeldToken: 'u' },
      { op: 'kill', pane: '%1', graceMs: 10 },
      { op: 'capture', pane: '%1', historyLines: 3, ansi: true, visible: false },
    ]
    const wire = ops.map(o => JSON.parse(JSON.stringify({ id: 1, ...o })))
    expect(wire[0]).toEqual({ id: 1, op: 'holdOpen', pane: '%1' })
    expect(wire[1].expectedHeldToken).toBe('u')
    expect(wire[2].graceMs).toBe(10)
    expect(wire[3].historyLines).toBe(3)
  })
})

/**
 * The type of each field of an op, for every field the TypeScript type declares, optional ones
 * included (`-?`): the compiler rejects a table that misses or invents a field.
 */
type FieldType = 'string' | 'number' | 'boolean' | 'string[]' | 'env' | 'afterExit'
type OpFields = { [K in PtyOp['op']]: { [F in keyof Omit<PtyOpOf<K>, 'op'>]-?: FieldType } }
const OP_FIELDS: OpFields = {
  create: { command: 'string[]', cwd: 'string', env: 'env', cols: 'number', rows: 'number', owner: 'string', label: 'string', hold: 'boolean', afterExit: 'afterExit', clearInherited: 'string[]', seed: 'string' },
  kill: { pane: 'string', graceMs: 'number' },
  inventory: {},
  titles: {},
  paneState: { pane: 'string' },
  paneInfo: { pane: 'string' },
  capture: { pane: 'string', historyLines: 'number', ansi: 'boolean', visible: 'boolean' },
  write: { pane: 'string', data: 'string' },
  paste: { pane: 'string', text: 'string', bracketed: 'boolean' },
  key: { pane: 'string', key: 'string' },
  setTitle: { pane: 'string', title: 'string' },
  holdOpen: { pane: 'string' },
  releaseHold: { pane: 'string' },
  respawn: { pane: 'string', command: 'string[]', cwd: 'string', env: 'env', expectedHeldToken: 'string', clearEnv: 'string[]', clearInherited: 'string[]', afterExit: 'afterExit' },
  jobPids: { pane: 'string' },
  processes: {},
  setEngineExit: { pane: 'string', status: 'number' },
  shutdown: {},
}

function typeOf(value: unknown): FieldType | 'other' {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'command' in value) {
    const { command, env, ...rest } = value as Record<string, unknown>
    return typeOf(command) === 'string[]' && typeOf(env) === 'env' && !Object.keys(rest).length ? 'afterExit' : 'other'
  }
  if (Array.isArray(value)) return value.every(v => typeof v === 'string') ? 'string[]' : 'other'
  if (value !== null && typeof value === 'object') {
    return Object.values(value).every(v => typeof v === 'string') ? 'env' : 'other'
  }
  const t = typeof value
  return t === 'string' || t === 'number' || t === 'boolean' ? t : 'other'
}

describe('ptyHost protocol fixture shared with Rust', () => {
  // pty/tests/ops_fixture.rs parses the same file into the host's `Request`.
  const fixture = JSON.parse(
    readFileSync(new URL('../../../../pty/tests/fixtures/ops.json', import.meta.url), 'utf8'),
  ) as Array<Record<string, unknown>>

  it('has one request per op', () => {
    expect(fixture.map(r => r.op).sort()).toEqual(Object.keys(OP_FIELDS).sort())
  })

  it.each(fixture.map(r => [r.op, r] as const))('%s carries exactly the fields PtyOp declares', (op, request) => {
    const { id, op: _op, ...fields } = request
    expect(typeof id).toBe('number')
    const declared = OP_FIELDS[op as PtyOp['op']]
    expect(Object.keys(fields).sort()).toEqual(Object.keys(declared).sort())
    for (const [name, type] of Object.entries(declared)) expect([name, typeOf(fields[name])]).toEqual([name, type])
    const asOp = { op, ...fields } as PtyOp
    expect(Object.keys(JSON.parse(JSON.stringify({ id, ...asOp }))).sort()).toEqual(Object.keys(request).sort())
  })
})
