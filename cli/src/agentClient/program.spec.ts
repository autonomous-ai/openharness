import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KEPT_INPUTS, openclawMessage, ownedBy, ProgramRecords, programMay, readProgramToken, sameHash, withProgramLock } from './program.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'program-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const TOKEN = 'a'.repeat(40)
const tokenFile = (content = `${TOKEN}\n`, mode = 0o600): string => {
  const path = join(dir, `token-${Math.random()}`)
  writeFileSync(path, content)
  chmodSync(path, mode)
  return path
}

describe('a program token file', () => {
  it('is read as the SHA-256 of its token, a trailing newline taken off', () => {
    expect(readProgramToken(tokenFile()).hash).toBe(createHash('sha256').update(TOKEN).digest('hex'))
  })

  it('is refused when others may read it, it is short, a link, missing, or not the caller\'s', () => {
    const refused = (path: string, deps = {}) => { try { readProgramToken(path, deps); return null } catch (error) { return (error as { code?: string }).code } }
    expect(refused(tokenFile(undefined, 0o644))).toBe('BAD_TOKEN_FILE')
    expect(refused(tokenFile('short'))).toBe('BAD_TOKEN_FILE')
    expect(refused(tokenFile('x'.repeat(5_000)))).toBe('BAD_TOKEN_FILE')
    const link = join(dir, 'link')
    symlinkSync(tokenFile(), link)
    expect(refused(link)).toBe('BAD_TOKEN_FILE')
    expect(refused(join(dir, 'missing'))).toBe('BAD_TOKEN_FILE')
    expect(refused(dir)).toBe('BAD_TOKEN_FILE')
    expect(refused(tokenFile(), { uid: () => 424242 })).toBe('BAD_TOKEN_FILE')
    // Windows has no Unix mode: the ACL is the check there.
    expect(refused(tokenFile(undefined, 0o644), { platform: 'win32' })).toBeNull()
  })

  it('allows a reply and a resume, signed in or out: the one place a PM ruling changes', () => {
    expect(programMay('reply', false) && programMay('resume', true)).toBe(true)
    expect(sameHash('ab', 'ab')).toBe(true)
    expect(sameHash('ab', 'abc')).toBe(false)
  })
})

describe('a program\'s words to an OpenClaw harness', () => {
  // OpenClaw 2026.11.2's TUI, as it reads a submitted editor: pi-tui 1.0.3 `submitValue` trims, then
  // `createEditorSubmitHandler` asks `resolveEditorSubmitAction` and sends `raw.trim()` as the message.
  const tui = (typed: string): { action: string; sent: string } => {
    const raw = typed.trim()
    const action = /^\/browser-setup(?:\s|$)/i.test(raw.trimStart()) ? 'command'
      : raw.includes('\n') ? 'message'
        : raw.startsWith('!') && raw.trimEnd() !== '!' ? 'local shell'
          : raw.trimStart().startsWith('/') ? 'command' : 'message'
    return { action, sent: raw.trim() }
  }

  it('are always sent as a message, a line starting with ! or / included, and otherwise as written', () => {
    for (const words of ['!rm -rf ~', '/new', '/reset please', '  /browser-setup', '!', '/']) {
      const typed = openclawMessage(words)
      expect(tui(typed)).toEqual({ action: 'message', sent: `​${words.trim()}` })
    }
    for (const words of ['turn on the light', 'what is 2/3?', '!important\nthen this', 'say hi!']) {
      expect(openclawMessage(words)).toBe(words)
      expect(tui(words).action).toBe('message')
    }
  })
})

describe('the program harness records', () => {
  const hash = 'f'.repeat(64)
  const row = (agentId: string, name = 'lamp-openclaw', createdAt = 1) =>
    ({ agentId, tokenHash: hash, name, engine: 'openclaw', createdAt, startedAt: createdAt, inputs: [] })

  it('finds a harness by the program\'s name and token, newest first, and keeps its last inputs', () => {
    const records = new ProgramRecords(dir)
    expect(records.all()).toEqual([])
    records.put(row('a', 'Lamp-OpenClaw', 1))
    records.put(row('b', 'lamp-openclaw', 2))
    expect(records.named('lamp-openclaw', hash).map((h) => h.agentId)).toEqual(['b', 'a'])
    expect(records.named('lamp-openclaw', '0'.repeat(64))).toEqual([])
    expect(ownedBy(dir, 'a', hash)).toBe(true)
    expect(ownedBy(dir, 'a', '0'.repeat(64))).toBe(false)
    expect(ownedBy(dir, 'zzz', hash)).toBe(false)
    records.started('a', 50)
    for (let i = 0; i < KEPT_INPUTS + 3; i++) records.taken('a', { id: `program:${i}`, takenAt: 100 + i })
    records.taken('missing', { id: 'x', takenAt: 1 })
    records.started('missing', 1)
    const a = records.get('a')!
    expect(a.startedAt).toBe(50)
    expect(a.inputs).toHaveLength(KEPT_INPUTS)
    expect(a.inputs.at(-1)!.id).toBe(`program:${KEPT_INPUTS + 2}`)
    records.prune(new Set(['a', 'b']))
    records.prune(new Set(['a']))
    expect(records.all().map((h) => h.agentId)).toEqual(['a'])
    records.forget('a')
    expect(records.get('a')).toBeNull()
  })

  it('reads past a file that is not its own shape', () => {
    const records = new ProgramRecords(dir)
    writeFileSync(records.path, 'not json')
    expect(records.all()).toEqual([])
    writeFileSync(records.path, JSON.stringify({ v: 1, harnesses: null }))
    expect(records.all()).toEqual([])
    writeFileSync(records.path, JSON.stringify({ v: 1, harnesses: { x: { agentId: 'x' }, y: { ...row('y'), inputs: 'no', createdAt: 'no' } } }))
    expect(records.all()).toEqual([{ ...row('y'), createdAt: 0 }])
  })

  it('runs two ensures of one name one after the other', async () => {
    const order: string[] = []
    const one = withProgramLock(dir, 'lamp', async () => { order.push('a+'); await new Promise((r) => setTimeout(r, 60)); order.push('a-') })
    const two = withProgramLock(dir, 'LAMP', async () => { order.push('b+'); order.push('b-') })
    await Promise.all([one, two])
    expect(order).toEqual(['a+', 'a-', 'b+', 'b-'])
  })

  it('takes over a lock whose process is gone, and gives up on a live one in time', async () => {
    const name = 'lamp'
    const key = createHash('sha256').update(name).digest('hex').slice(0, 16)
    writeFileSync(join(dir, `program-ensure-${key}.lock`), JSON.stringify({ pid: 2 ** 22 + 7 }))
    expect(await withProgramLock(dir, name, async () => 'ran')).toBe('ran')
    writeFileSync(join(dir, `program-ensure-${key}.lock`), JSON.stringify({ pid: process.pid }))
    await expect(withProgramLock(dir, name, async () => 'ran', 50)).rejects.toMatchObject({ code: 'BUSY' })
  })
})
