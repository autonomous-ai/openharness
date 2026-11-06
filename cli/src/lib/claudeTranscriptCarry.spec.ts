import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { carryClaudeTranscript } from './claudeTranscriptCarry.js'

const ID = '0a1b2c3d-1111-2222-3333-444455556666'
const CWD = '/work/my.app'
const FOLDER = '-work-my-app'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'carry-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** A throwaway Claude home holding one session; never the developer's own ~/.claude. */
function home(name: string, folder = FOLDER): string {
  const path = join(root, name)
  mkdirSync(join(path, 'projects', folder), { recursive: true })
  return path
}
const writeSession = (from: string, folder = FOLDER) => writeFileSync(join(from, 'projects', folder, `${ID}.jsonl`), '{"turn":1}\n')

describe('carrying a Claude transcript between accounts', () => {
  it("copies the session file into the other account's projects", () => {
    const from = home('a'), to = join(root, 'b')
    writeSession(from)
    const carried = carryClaudeTranscript(from, to, CWD, ID)
    expect(carried).toEqual({ transcriptPath: join(to, 'projects', FOLDER, `${ID}.jsonl`), copied: true })
    expect(readFileSync(carried.transcriptPath, 'utf8')).toBe('{"turn":1}\n')
    expect(existsSync(join(from, 'projects', FOLDER, `${ID}.jsonl`))).toBe(true)
  })

  it('finds the folder by listing when the cwd encoding differs, and replaces an older copy', () => {
    const from = home('a', 'some-other-encoding'), to = home('b', 'some-other-encoding')
    writeSession(from, 'some-other-encoding')
    writeFileSync(join(to, 'projects', 'some-other-encoding', `${ID}.jsonl`), 'stale')
    const carried = carryClaudeTranscript(from, to, CWD, ID)
    expect(carried.copied).toBe(true)
    expect(readFileSync(carried.transcriptPath, 'utf8')).toBe('{"turn":1}\n')
  })

  it('same projects folder copies nothing', () => {
    const from = home('a'), to = join(root, 'orca')
    mkdirSync(to)
    symlinkSync(join(from, 'projects'), join(to, 'projects'))
    writeSession(from)
    expect(carryClaudeTranscript(from, to, CWD, ID)).toEqual({ transcriptPath: join(from, 'projects', FOLDER, `${ID}.jsonl`), copied: false })
  })

  it('a missing session file throws NOT_FOUND', () => {
    const from = home('a')
    expect(() => carryClaudeTranscript(from, join(root, 'b'), CWD, ID)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => carryClaudeTranscript(join(root, 'none'), join(root, 'b'), CWD, ID)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => carryClaudeTranscript(from, join(root, 'b'), CWD, '../escape')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it('the default account is the daemon projects folder', async () => {
    const own = home('default')
    writeSession(own)
    const { env } = await import('../config/env.js')
    const was = env.CLAUDE_PROJECTS_DIR
    env.CLAUDE_PROJECTS_DIR = join(own, 'projects')
    try {
      const to = join(root, 'b')
      expect(carryClaudeTranscript(undefined, to, CWD, ID).copied).toBe(true)
      expect(carryClaudeTranscript(to, undefined, CWD, ID)).toMatchObject({ copied: true, transcriptPath: join(own, 'projects', FOLDER, `${ID}.jsonl`) })
    } finally { env.CLAUDE_PROJECTS_DIR = was }
  })
})
