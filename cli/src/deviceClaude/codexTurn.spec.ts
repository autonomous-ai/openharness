/**
 * The turn's setting, read from a Codex session's rollout: who reviews its permission asks and its mode, for the turn a
 * hook names, and nothing from a file it may not read. Every Codex home is a throwaway folder; the turn_context lines are
 * Codex 0.172.0's own (__fixtures__/codex-turn-context.jsonl), the filler around them is made here.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { CODEX_REVIEWER_READ_BYTES, readTurnSetting } from './codexTurn.js'

const posix = it.skipIf(process.platform === 'win32')

const FIXTURE = readFileSync(new URL('./__fixtures__/codex-turn-context.jsonl', import.meta.url), 'utf8')
  .split(/\r?\n/).filter(Boolean)
/** Line 2: automatic review, Default mode. */
const AUTO_REVIEW_LINE = FIXTURE[1]
const AUTO_REVIEW_TURN = '01a21860-3b56-7292-b32b-e04f386c56d4'
/** Line 6: the person reviews, Default mode. */
const USER_LINE = FIXTURE[5]
const USER_TURN = '01a21862-356c-7481-bf3a-ea92e3fd707a'
const ROLLOUT = 'rollout-2026-11-26T14-59-40-019abc00-0000-7000-8000-000000000001.jsonl'
const SESSION_META = JSON.stringify({
  timestamp: '2026-11-26T14:59:40.000Z', ordinal: 0, type: 'session_meta',
  payload: { id: '019abc00-0000-7000-8000-000000000001', cwd: '/home/person/work', cli_version: '0.172.0' },
})

/** A line of [line]'s with its payload changed. */
function edited(line: string, change: (payload: Record<string, unknown>) => void): string {
  const record = JSON.parse(line) as { payload: Record<string, unknown> }
  change(record.payload)
  return JSON.stringify(record)
}
const PLAN_LINE = edited(USER_LINE, (payload) => { payload.collaboration_mode = { ...payload.collaboration_mode as object, mode: 'plan' } })

/** The event line Codex 0.172.0 writes at [turnId]'s end (EventMsg::TurnComplete, persisted by rollout/src/policy.rs). */
const taskComplete = (turnId: string): string => JSON.stringify({
  timestamp: '2026-11-26T15:02:10.000Z', ordinal: 9, type: 'event_msg',
  payload: { type: 'task_complete', turn_id: turnId, last_agent_message: 'Done.' },
})
/** The event line Codex 0.172.0 writes when the person interrupts [turnId] (EventMsg::TurnAborted). */
const turnAborted = (turnId: string | null): string => JSON.stringify({
  timestamp: '2026-11-26T15:02:10.000Z', ordinal: 9, type: 'event_msg',
  payload: { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' },
})

/** Whole lines, each with its newline. */
const lines = (...records: string[]): string => records.map((record) => `${record}\n`).join('')

const FILLER_HEAD = '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"'
const FILLER_TAIL = '"}}\n'
/** Tool output lines of exactly [bytes] bytes in all, their newlines included. */
function filler(bytes: number): string {
  const line = (size: number): string => FILLER_HEAD + 'x'.repeat(size - FILLER_HEAD.length - FILLER_TAIL.length) + FILLER_TAIL
  const out: string[] = []
  for (let left = bytes; left > 0;) {
    const size = left >= 8192 ? 4096 : left
    out.push(line(size))
    left -= size
  }
  return out.join('')
}

/** What Codex writes before a turn's context: the session's own line, then earlier turns' output. */
const HEAD = lines(SESSION_META) + filler(8 * 1024)
/** A rollout whose last turn is line 6's, 4 KiB of its output after it, as the spike found in a short turn. */
const VALID = HEAD + lines(USER_LINE) + filler(4 * 1024)

/** How far from the end [line]'s last copy in [text] starts, in bytes. */
const fromEnd = (text: string, line: string): number =>
  Buffer.byteLength(text) - Buffer.byteLength(text.slice(0, text.lastIndexOf(line)))

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A Codex home with its sessions folder, in a throwaway folder that also holds places outside the home. */
function codexHome() {
  const root = mkdtempSync(join(tmpdir(), 'codex-turn-'))
  roots.push(root)
  const home = join(root, 'codex')
  const sessions = join(home, 'sessions', '2026', '11', '26')
  mkdirSync(sessions, { recursive: true })
  const elsewhere = join(root, 'elsewhere')
  mkdirSync(elsewhere)
  const write = (text: string, folder = sessions): string => {
    const path = join(folder, ROLLOUT)
    writeFileSync(path, text)
    return path
  }
  return { root, home, sessions, elsewhere, write }
}

const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
/** Line 6's setting read by a child process run from [cwd], which the test can kill. */
function readInChild(path: string, home: string, cwd: string): unknown {
  const reader = new URL('./codexTurn.ts', import.meta.url).href
  const script = `const { readTurnSetting } = await import(${JSON.stringify(reader)})
    console.log(JSON.stringify(readTurnSetting(process.argv[1], process.argv[2], process.argv[3])))`
  const child = spawnSync(process.execPath, ['--import', TSX, '--input-type=module', '-e', script, path, USER_TURN, home],
    { cwd, encoding: 'utf8', timeout: 10_000 })
  expect(child.signal).toBeNull()
  return JSON.parse(child.stdout)
}

/** The setting [turnId] reads from a rollout holding [text], in a home of its own. */
function settingIn(text: string, turnId = USER_TURN) {
  const fx = codexHome()
  return readTurnSetting(fx.write(text), turnId, fx.home)
}

describe('readTurnSetting', () => {
  describe('the turn it names', () => {
    it('user', () => {
      expect(settingIn(HEAD + lines(...FIXTURE) + filler(4096))).toStrictEqual({ reviewer: 'user', mode: 'default' })
    })

    it('auto_review', () => {
      expect(settingIn(HEAD + lines(...FIXTURE) + filler(4096), AUTO_REVIEW_TURN))
        .toStrictEqual({ reviewer: 'auto_review', mode: 'default' })
    })

    it('plan', () => {
      expect(settingIn(HEAD + lines(PLAN_LINE) + filler(4096))).toStrictEqual({ reviewer: 'user', mode: 'plan' })
    })

    it('no turn_context at all', () => {
      expect(settingIn(HEAD + filler(4096))).toBeNull()
    })

    it('only another turn\'s turn_context', () => {
      expect(settingIn(HEAD + lines(AUTO_REVIEW_LINE) + filler(4096))).toBeNull()
    })

    // Review Focus 1: Codex writes the line again after a compaction; the later one is the turn's setting.
    it('the later of two lines for a turn wins', () => {
      const later = edited(USER_LINE, (payload) => { payload.approvals_reviewer = 'auto_review' })
      expect(settingIn(HEAD + lines(USER_LINE) + filler(4096) + lines(later) + filler(1024)))
        .toStrictEqual({ reviewer: 'auto_review', mode: 'default' })
    })

    it('a line across a 64 KiB chunk edge', () => {
      const text = HEAD + lines(USER_LINE) + filler(64 * 1024 + 100 - (USER_LINE.length + 1))
      expect(fromEnd(text, USER_LINE)).toBe(64 * 1024 + 100)
      expect(settingIn(text)).toStrictEqual({ reviewer: 'user', mode: 'default' })
    })

    // A turn_context line carries the turn's instructions, which can run past several chunks.
    it('a line across three 64 KiB chunks', () => {
      const long = edited(USER_LINE, (payload) => { payload.user_instructions = 'x'.repeat(3 * 64 * 1024) })
      const text = HEAD + lines(long) + filler(4096)
      expect(fromEnd(text, long)).toBeGreaterThan(3 * 64 * 1024)
      expect(settingIn(text)).toStrictEqual({ reviewer: 'user', mode: 'default' })
    })

    it('the last line without its newline', () => {
      expect(settingIn(HEAD + USER_LINE)).toStrictEqual({ reviewer: 'user', mode: 'default' })
    })

    it('a rollout that is the line alone', () => {
      expect(settingIn(lines(USER_LINE))).toStrictEqual({ reviewer: 'user', mode: 'default' })
    })
  })

  // The hook runs in the background, so it can read the rollout after its turn ended (spec Part 7, "A post that lands
  // after the answer").
  describe('the turn\'s end', () => {
    it.each([
      ['task_complete', taskComplete(USER_TURN)],
      ['turn_aborted', turnAborted(USER_TURN)],
    ])('the turn\'s own %s after its turn_context: nothing', (_, end) => {
      expect(settingIn(HEAD + lines(USER_LINE) + filler(4096) + lines(end) + filler(1024))).toBeNull()
    })

    it('a turn still running reads as before', () => {
      expect(settingIn(HEAD + lines(taskComplete(AUTO_REVIEW_TURN), USER_LINE) + filler(4096)))
        .toStrictEqual({ reviewer: 'user', mode: 'default' })
    })

    it.each([
      ['another turn\'s task_complete after it', taskComplete(AUTO_REVIEW_TURN)],
      ['another turn\'s turn_aborted after it', turnAborted(AUTO_REVIEW_TURN)],
      ['a turn_aborted with no turn_id', turnAborted(null)],
    ])('%s does not end it', (_, end) => {
      expect(settingIn(HEAD + lines(USER_LINE) + filler(4096) + lines(end)))
        .toStrictEqual({ reviewer: 'user', mode: 'default' })
    })

    it('the turn\'s task_complete before a later turn_context of its own does not end it', () => {
      const later = edited(USER_LINE, (payload) => { payload.approvals_reviewer = 'auto_review' })
      expect(settingIn(HEAD + lines(USER_LINE, taskComplete(USER_TURN), later)))
        .toStrictEqual({ reviewer: 'auto_review', mode: 'default' })
    })

    it('the text of a task_complete inside a tool output, or another record\'s, is not taken for one', () => {
      const inOutput = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: taskComplete(USER_TURN) } })
      const notEvent = JSON.stringify({ ...JSON.parse(taskComplete(USER_TURN)), type: 'response_item' })
      const notEnd = edited(taskComplete(USER_TURN), (payload) => { payload.type = 'agent_message'; payload.message = 'task_complete' })
      expect(settingIn(HEAD + lines(USER_LINE, inOutput, notEvent, notEnd, '{"type":"event_msg","payload":"task_complete"}')))
        .toStrictEqual({ reviewer: 'user', mode: 'default' })
    })
  })

  describe('malformed', () => {
    it('a file of non-JSON text', () => {
      expect(settingIn(lines(`"type":"turn_context" ${USER_TURN} "approvals_reviewer":"user"`, 'not a record'))).toBeNull()
    })

    it('the matching line cut short (a write in progress)', () => {
      expect(settingIn(HEAD + USER_LINE.slice(0, USER_LINE.length / 2))).toBeNull()
    })

    it.each([
      ['an approvals_reviewer that is a number', edited(USER_LINE, (payload) => { payload.approvals_reviewer = 7 }),
        { reviewer: null, mode: 'default' }],
      ['a collaboration_mode that is text', edited(USER_LINE, (payload) => { payload.collaboration_mode = 'plan' }),
        { reviewer: 'user', mode: null }],
      ['neither field', edited(USER_LINE, (payload) => { delete payload.approvals_reviewer; delete payload.collaboration_mode }),
        { reviewer: null, mode: null }],
    ])('%s reads as not given', (_, line, setting) => {
      expect(settingIn(HEAD + lines(line))).toStrictEqual(setting)
    })

    it('a turn_context record with no payload, or not a record, is passed over', () => {
      const broken = ['{"type":"turn_context","payload":null}', '{"type":"turn_context"}', '[{"type":"turn_context"}]']
      expect(settingIn(HEAD + lines(USER_LINE, ...broken))).toStrictEqual({ reviewer: 'user', mode: 'default' })
    })

    it('the text "type":"turn_context" inside a tool output, or in another record\'s payload, is not taken for one', () => {
      const own = edited(USER_LINE, (payload) => { payload.approvals_reviewer = 'auto_review' })
      const inOutput = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: USER_LINE } })
      const inPayload = JSON.stringify({ type: 'event_msg', payload: { ...JSON.parse(USER_LINE).payload, type: 'turn_context' } })
      expect(settingIn(HEAD + lines(own, inOutput, inPayload))).toStrictEqual({ reviewer: 'auto_review', mode: 'default' })
    })
  })

  describe('the bound', () => {
    it('a line that starts exactly CODEX_REVIEWER_READ_BYTES from the end is found', () => {
      const text = HEAD + lines(USER_LINE) + filler(CODEX_REVIEWER_READ_BYTES - (USER_LINE.length + 1))
      expect(fromEnd(text, USER_LINE)).toBe(CODEX_REVIEWER_READ_BYTES)
      expect(settingIn(text)).toStrictEqual({ reviewer: 'user', mode: 'default' })
    })

    it('one byte further is not', () => {
      const text = HEAD + lines(USER_LINE) + filler(CODEX_REVIEWER_READ_BYTES + 1 - (USER_LINE.length + 1))
      expect(fromEnd(text, USER_LINE)).toBe(CODEX_REVIEWER_READ_BYTES + 1)
      expect(settingIn(text)).toBeNull()
    })
  })

  describe('what it may read', () => {
    it.each<[string, (fx: ReturnType<typeof codexHome>) => string]>([
      ['a missing file', (fx) => join(fx.sessions, ROLLOUT)],
      ['a folder at the path', (fx) => {
        mkdirSync(join(fx.sessions, ROLLOUT))
        return join(fx.sessions, ROLLOUT)
      }],
      ['a valid rollout in another folder', (fx) => fx.write(VALID, fx.elsewhere)],
      ['a path inside the home through .. that leaves it', (fx) => {
        fx.write(VALID, fx.elsewhere)
        return [fx.home, 'sessions', '..', '..', 'elsewhere', ROLLOUT].join(sep)
      }],
    ])('%s gives nothing', (_, place) => {
      const fx = codexHome()
      expect(readTurnSetting(place(fx), USER_TURN, fx.home)).toBeNull()
    })

    posix('a link to a valid rollout inside the home gives nothing', () => {
      const fx = codexHome()
      const link = join(fx.sessions, 'link.jsonl')
      symlinkSync(fx.write(VALID), link)
      expect(readTurnSetting(link, USER_TURN, fx.home)).toBeNull()
    })

    posix('a rollout under a linked folder of the home that leads out of it gives nothing', () => {
      const fx = codexHome()
      fx.write(VALID, fx.elsewhere)
      symlinkSync(fx.elsewhere, join(fx.sessions, 'linked'))
      expect(readTurnSetting(join(fx.sessions, 'linked', ROLLOUT), USER_TURN, fx.home)).toBeNull()
    })

    // Run from the throwaway folder, it names the valid rollout inside the home (there is no relative path between two
    // drives, so the child is what gives it one on Windows).
    it('a relative path gives nothing', () => {
      const fx = codexHome()
      expect(readInChild(relative(fx.root, fx.write(VALID)), fx.home, fx.root)).toBeNull()
    })

    // A FIFO opened for reading would wait for a writer for good, so the call runs in a child the test can kill.
    posix('a FIFO at the path gives nothing, at once', () => {
      const fx = codexHome()
      const fifo = join(fx.sessions, ROLLOUT)
      execFileSync('mkfifo', [fifo])
      expect(readInChild(fifo, fx.home, fx.root)).toBeNull()
    })

    posix('a home given through a link whose target holds the rollout is read: real paths are compared', () => {
      const fx = codexHome()
      const homeLink = join(fx.root, 'home-link')
      symlinkSync(fx.home, homeLink)
      expect(readTurnSetting(fx.write(VALID), USER_TURN, homeLink)).toStrictEqual({ reviewer: 'user', mode: 'default' })
    })
  })
})
