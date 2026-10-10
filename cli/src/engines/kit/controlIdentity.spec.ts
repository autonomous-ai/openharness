import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { controlIdentity as claude } from '../claude/sessionStore.js'
import { PI_CONTROL_IDENTITY as pi } from '../pi/contract.js'
import { controlIdentity } from './controlIdentity.js'
import { NativeFiles } from './nativeFiles.js'

const line = (value: unknown) => JSON.stringify(value) + '\n'
const opening = { type: 'user', sessionId: 'native-conversation', cwd: '/fixture/work', isSidechain: false }
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('reads identity after bookkeeping and ignores sidechain body records after the parent opening', () => {
  const prefix = line({ type: 'queue-operation' }) + '\n' + line(opening)
  const text = prefix + line({ ...opening, isSidechain: true })
  expect(controlIdentity(Buffer.from(text), claude)).toEqual({ id: opening.sessionId, cwd: opening.cwd,
    delegated: false, bytes: Buffer.byteLength(prefix) })
  expect(controlIdentity(Buffer.from(line({ ...opening, isSidechain: true })), claude).delegated).toBe(true)
})

it.each([
  '', '{partial', line(null), line([]), line({ ...opening, sessionId: 8 }), line({ ...opening, sessionId: '' }),
  line({ ...opening, cwd: 'relative' }), line({ ...opening, cwd: 9 }), line({ ...opening, isSidechain: 'false' }),
  line({ type: 'bookkeeping' }).repeat(20) + line(opening),
  line({ sessionId: 'first' }) + line(opening), line({ cwd: '/other' }) + line(opening),
  line({ sessionId: 'native-conversation', isSidechain: false }) + line({ cwd: '/fixture/work', isSidechain: true }),
  line({ sessionId: 'native-conversation', isSidechain: false }) + line({ cwd: '/fixture/work', isSidechain: 'false' }),
  line({ ...opening, padding: 'x'.repeat(1024 * 1024) }),
].map((text, index) => ({ text, index })))('holds incomplete or contradictory Claude opening $index', ({ text }) => {
  expect(() => controlIdentity(Buffer.from(text), claude)).toThrow(expect.objectContaining({ code: 'IDENTITY_UNAVAILABLE' }))
})

it('rejects invalid UTF-8 rather than manufacturing an identity from replacement characters', () => {
  const bytes = Buffer.concat([Buffer.from('{"sessionId":"'), Buffer.from([0xff]), Buffer.from('","cwd":"/fixture"}\n')])
  expect(() => controlIdentity(bytes, claude)).toThrow('complete UTF-8')
})

it.each(['wrong type', 'path id', 'incomplete', 'missing workspace'])('holds a Pi opening with %s', state => {
  const value = { type: 'session', id: 'native-id', cwd: '/fixture/work' }
  if (state === 'wrong type') value.type = 'message'
  if (state === 'path id') value.id = 'conversation.jsonl'
  if (state === 'missing workspace') delete (value as Partial<typeof value>).cwd
  const text = line(value)
  expect(() => controlIdentity(Buffer.from(state === 'incomplete' ? text.trimEnd() : text), pi))
    .toThrow(expect.objectContaining({ code: 'IDENTITY_UNAVAILABLE' }))
})

it('keeps a complete opening proof through appends and rejects its replacement before publication', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-control-opening-')); roots.push(root)
  const path = join(root, 'conversation.jsonl'), files = new NativeFiles()
  writeFileSync(path, line(opening))
  expect(files.opening(path, claude).id).toBe(opening.sessionId)
  writeFileSync(path, line(opening) + line({ type: 'assistant', text: 'appended body' }))
  expect(() => files.verify(path)).not.toThrow()
  writeFileSync(path, line({ ...opening, sessionId: 'other-conversation' }))
  expect(() => files.verify(path)).toThrow('opening changed')
})
