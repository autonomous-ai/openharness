import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cmuxEventLine, fakeCmuxLog } from '../../testing/fakeCmux.js'
import {
  CMUX_EVENTS, cmuxLogFiles, createCmuxFocus, MAX_EVENT_LINE, MAX_EVENTS_READ, MAX_WINDOWS, MAX_WORKSPACES,
  type CmuxFocusDeps,
} from './cmuxFocus.js'

/** The n-th id of a kind, as cmux prints a UUID: upper case. The kind's group tells workspaces, surfaces, windows and
 *  boots apart. */
const uuid = (kind: string) => (n: number) => `${n.toString(16).toUpperCase().padStart(8, '0')}-${kind}-4000-8000-000000000000`
const W = uuid('AAAA')
const S = uuid('BBBB')
const WIN = uuid('CCCC')
const B = uuid('DDDD')
const [W1, W2, W3] = [W(1), W(2), W(3)]
const [S1, S2, S3] = [S(1), S(2), S(3)]
const [WIN1, WIN2] = [WIN(1), WIN(2)]
const [B1, B2] = [B(1), B(2)]
const PANE = uuid('EEEE')(1)
const low = (id: string) => id.toLowerCase()
const GAP = '[cmux] events · gap'
const LINE = /^\[cmux\] (events · gap|read · events · \d+)$/
/** Words about people's work that cmux puts in its payloads: none may reach a value or a line. */
const TITLE = 'Payroll export'
const FOLDER = '/Users/someone/payroll'
const PREVIEW = 'ship the payroll fix'

// cmux's focus events, each with the payload docs/events.md gives it at the tag.
const focused = (workspace: string, surface: string, boot = B1) =>
  cmuxEventLine('surface.focused', { boot, workspace, surface, pane: PANE }, { kind: 'terminal' })
const paneFocused = (workspace: string, surface: string) =>
  cmuxEventLine('pane.focused', { boot: B1, workspace, pane: PANE }, { selected_surface_id: surface })
const selected = (workspace: string, boot = B1) =>
  cmuxEventLine('workspace.selected', { boot, workspace }, { title: TITLE, current_directory: FOLDER, index: 0, tab_count: 2 })
const windowEvent = (name: string, window: string, workspace: string, boot = B1) =>
  cmuxEventLine(name, { boot, window }, {
    window_id: window, workspace_id: workspace, workspace_count: 1, selected_workspace_index: 0,
    is_key_window: name === 'window.keyed', is_main_window: true,
  })
const keyed = (window: string, workspace: string, boot = B1) => windowEvent('window.keyed', window, workspace, boot)
const created = (window: string) => windowEvent('window.created', window, W1)
const windowClosed = (window: string) => windowEvent('window.closed', window, W1)
const surfaceClosed = (workspace: string, surface: string) =>
  cmuxEventLine('surface.closed', { boot: B1, workspace, surface, pane: PANE }, { kind: 'terminal' })
const workspaceClosed = (workspace: string) =>
  cmuxEventLine('workspace.closed', { boot: B1, workspace }, { title: TITLE, current_directory: FOLDER, remaining_tab_count: 1 })
const prompt = (more: Record<string, unknown> = {}) =>
  cmuxEventLine('workspace.prompt.submitted', { boot: B1, workspace: W1, surface: S2 }, { message: '[redacted]', preview: PREVIEW, ...more })

/** Lines of another event, `bytes` of them in all: what a working agent's hooks append many times a second. */
function noise(bytes: number): string {
  const line = (pad: number) => cmuxEventLine('notification.created', { boot: B1, workspace: W3, surface: S3 }, { body: 'x'.repeat(pad) })
  const base = line(0).length
  expect(bytes).toBeGreaterThanOrEqual(base)
  let text = ''
  for (let left = bytes; left > 0;) {
    // Each line at most 8 KiB, and never a rest too short for a line of its own.
    const size = left <= 8192 ? left : Math.min(8192, left - base)
    text += line(size - base)
    left -= size
  }
  return text
}

let said: string[] = []

describe('cmux\'s front from its event log (docs/plans/2026-11-25-dial-cmux-focus-follow-design.md)', () => {
  beforeEach(() => { said = [] })
  afterEach(() => {
    // Fixed words and a number only: never an id, a path or anything a line of the log held.
    for (const line of said) expect(line).toMatch(LINE)
    vi.restoreAllMocks()
  })

  function setup(over: Partial<CmuxFocusDeps> = {}) {
    const log = fakeCmuxLog()
    const focus = createCmuxFocus({
      files: log, path: '/home/.cmuxterm/events.jsonl', monotonic: () => 0, log: (line) => said.push(line), ...over,
    })
    return { log, focus }
  }
  const gaps = () => said.filter((line) => line === GAP).length

  describe('the focus events', () => {
    it('names the front workspace and its focused surface, in lower case', async () => {
      const { log, focus } = setup()
      log.append(focused(W1, S1) + keyed(WIN1, W1))
      expect(await focus.read()).toEqual({ workspace: low(W1), surface: low(S1) })
    })

    it('takes pane.focused\'s selected surface as its workspace\'s', async () => {
      const { log, focus } = setup()
      log.append(focused(W1, S1) + keyed(WIN1, W1))
      await focus.read()
      log.append(paneFocused(W1, S2))
      expect(await focus.read()).toEqual({ workspace: low(W1), surface: low(S2) })
    })

    it('with one window or none known, a selection names the front, its surface when known', async () => {
      const { log, focus } = setup()
      log.append(focused(W1, S1) + focused(W2, S2) + selected(W1))
      expect(await focus.read()).toEqual({ workspace: low(W1), surface: low(S1) })
      log.append(keyed(WIN1, W1) + selected(W2))
      expect(await focus.read()).toEqual({ workspace: low(W2), surface: low(S2) })
      log.append(selected(W3))
      expect(await focus.read()).toEqual({ workspace: low(W3) })
    })

    it('with two windows known, a selection makes the front unknown until a window is keyed', async () => {
      const { log, focus } = setup()
      log.append(focused(W1, S1) + focused(W2, S2) + created(WIN1) + keyed(WIN2, W1))
      expect(await focus.read()).toEqual({ workspace: low(W1), surface: low(S1) })
      // It names no window: one behind the key window may have changed its own.
      log.append(selected(W2))
      expect(await focus.read()).toEqual({})
      log.append(keyed(WIN1, W2))
      expect(await focus.read()).toEqual({ workspace: low(W2), surface: low(S2) })
      log.append(windowClosed(WIN2) + selected(W1))
      expect(await focus.read()).toEqual({ workspace: low(W1), surface: low(S1) })
    })

    it('a closed surface is no workspace\'s focus, and a closed workspace is forgotten with the front', async () => {
      const { log, focus } = setup()
      log.append(focused(W1, S1) + focused(W2, S2) + keyed(WIN1, W1))
      await focus.read()
      log.append(surfaceClosed(W1, S1))
      expect(await focus.read()).toEqual({ workspace: low(W1) })
      log.append(workspaceClosed(W1))
      expect(await focus.read()).toEqual({})
      log.append(keyed(WIN1, W2))
      expect(await focus.read()).toEqual({ workspace: low(W2), surface: low(S2) })
    })

    it('a new boot id forgets every surface and window from before cmux restarted (Review Focus 3)', async () => {
      const { log, focus } = setup()
      log.append(focused(W1, S1) + created(WIN1) + keyed(WIN2, W1))
      expect(await focus.read()).toEqual({ workspace: low(W1), surface: low(S1) })
      log.append(keyed(WIN1, W1, B2))
      expect(await focus.read()).toEqual({ workspace: low(W1) })
      // One window known since the restart, so a selection names the front.
      log.append(selected(W2, B2))
      expect(await focus.read()).toEqual({ workspace: low(W2) })
    })
  })

  describe('gaps (Review Focus 4)', () => {
    it('a rotated log is read from the new file\'s start, as a gap', async () => {
      const { log, focus } = setup()
      log.append(focused(W1, S1) + keyed(WIN1, W1))
      await focus.read()
      log.rotate()
      log.append(focused(W2, S2) + keyed(WIN1, W2))
      expect(await focus.read()).toEqual({ workspace: low(W2), surface: low(S2) })
      expect(log.positions.at(-1)).toBe(0)
      expect(gaps()).toBe(1)
      // What was known from the old file went with the gap: the bytes between it and the rotation were never read.
      log.append(keyed(WIN1, W1))
      expect(await focus.read()).toEqual({ workspace: low(W1) })
    })

    it('a log cut shorter than the offset is read from its start, as a gap', async () => {
      const { log, focus } = setup()
      log.append(focused(W1, S1) + focused(W2, S2) + keyed(WIN1, W1))
      await focus.read()
      log.rewrite(keyed(WIN1, W2))
      expect(await focus.read()).toEqual({ workspace: low(W2) })
      expect(log.positions.at(-1)).toBe(0)
      expect(gaps()).toBe(1)
    })

    it('more than 1 MiB since the last read is read from the newest 1 MiB, as a gap', async () => {
      const { log, focus } = setup()
      const reads = vi.spyOn(log, 'read')
      const first = focused(W1, S1) + keyed(WIN1, W1)
      log.append(first)
      await focus.read()
      const more = noise(MAX_EVENTS_READ) + focused(W2, S2) + keyed(WIN1, W2)
      log.append(more)
      expect(await focus.read()).toEqual({ workspace: low(W2), surface: low(S2) })
      expect(log.positions.at(-1)).toBe(first.length + more.length - MAX_EVENTS_READ)
      expect(reads.mock.calls.at(-1)?.[1].length).toBe(MAX_EVENTS_READ)
      expect(gaps()).toBe(1)
      log.append(keyed(WIN1, W1))
      expect(await focus.read()).toEqual({ workspace: low(W1) })
    })

    it('a first read of a log past 1 MiB takes its newest 1 MiB, drops the line it starts in and says no gap', async () => {
      const { log, focus } = setup()
      const reads = vi.spyOn(log, 'read')
      // A whole line right where the read starts, after bytes that end no line: to the reader it is the end of one.
      const cut = focused(W1, S3)
      const end = focused(W2, S2) + keyed(WIN1, W2)
      log.append('x'.repeat(100) + cut + noise(MAX_EVENTS_READ - cut.length - end.length) + end)
      expect(await focus.read()).toEqual({ workspace: low(W2), surface: low(S2) })
      expect(log.positions).toEqual([100])
      expect(reads.mock.calls[0]?.[1].length).toBe(MAX_EVENTS_READ)
      expect(gaps()).toBe(0)
      log.append(keyed(WIN1, W1))
      expect(await focus.read()).toEqual({ workspace: low(W1) })
    })
  })

  describe('lines', () => {
    it('a line split across two reads is taken once it is whole', async () => {
      const { log, focus } = setup()
      const line = focused(W1, S2)
      log.append(focused(W1, S1) + keyed(WIN1, W1) + line.slice(0, 40))
      expect(await focus.read()).toEqual({ workspace: low(W1), surface: low(S1) })
      log.append(line.slice(40))
      expect(await focus.read()).toEqual({ workspace: low(W1), surface: low(S2) })
    })

    it('a line past 16 KiB is skipped, whole in one read or carried across reads, and the next is taken', async () => {
      const { log, focus } = setup()
      const long = cmuxEventLine('surface.focused', { boot: B1, workspace: W1, surface: S3 }, { pad: 'x'.repeat(2 * MAX_EVENT_LINE) })
      log.append(focused(W1, S1) + focused(W2, S2) + keyed(WIN1, W1))
      await focus.read()
      log.append(long + keyed(WIN1, W2))
      expect(await focus.read()).toEqual({ workspace: low(W2), surface: low(S2) })
      // 20,000 bytes that end no line, then a focus line: the line carried past 16 KiB is skipped to its end, so the
      // focus line at its end is not taken as a line of its own.
      const carried = 'x'.repeat(20_000) + focused(W1, S3)
      log.append(carried.slice(0, 10_000))
      await focus.read()
      log.append(carried.slice(10_000, 20_000))
      await focus.read()
      log.append(carried.slice(20_000) + keyed(WIN1, W1))
      // And what a read carries to the next is at most 16 KiB, however long a line goes on.
      const concat = vi.spyOn(Buffer, 'concat')
      expect(await focus.read()).toEqual({ workspace: low(W1), surface: low(S1) })
      for (const [list] of concat.mock.calls) expect(list[0]?.length).toBeLessThanOrEqual(MAX_EVENT_LINE)
    })

    it('a prompt quoting a focus event, ids not in form and a line that is not JSON change nothing', async () => {
      const { log, focus } = setup()
      log.append(focused(W1, S1) + keyed(WIN1, W1))
      await focus.read()
      log.append(
        // A quote of the words is escaped in the preview, and an object of the same keys passes the name's substring
        // test: only the parse tells the event is another.
        prompt({ preview: '"name":"surface.focused"', quoted: { name: 'surface.focused', type: 'event', workspace_id: W1, surface_id: S2 } })
        + cmuxEventLine('surface.focused', { boot: B1, workspace: W1, surface: 'surface-2' })
        + cmuxEventLine('surface.focused', { boot: 'boot-2', workspace: W1, surface: S2 })
        + cmuxEventLine('surface.focused', { boot: B1, surface: S2 })
        + `${JSON.stringify({ boot_id: B1, name: 'surface.focused', surface_id: S2, type: 'response', workspace_id: W1 })}\n`
        + `{"name":"surface.focused","surface_id":"${S2}"\n`,
      )
      expect(await focus.read()).toEqual({ workspace: low(W1), surface: low(S1) })
    })

    it('lines of other events are never parsed', async () => {
      const { log, focus } = setup()
      const parse = vi.spyOn(JSON, 'parse')
      log.append(noise(64 * 1024) + prompt())
      await focus.read()
      expect(parse).not.toHaveBeenCalled()
      log.append(focused(W1, S1) + keyed(WIN1, W1))
      expect(await focus.read()).toEqual({ workspace: low(W1), surface: low(S1) })
      expect(parse).toHaveBeenCalledTimes(2)
    })

    it('no value or line holds a payload\'s title, folder or preview', async () => {
      const { log, focus } = setup()
      const answers = []
      log.append(focused(W1, S1) + keyed(WIN1, W1) + selected(W2) + prompt() + workspaceClosed(W2))
      answers.push(await focus.read())
      log.rotate()
      log.append(selected(W1))
      answers.push(await focus.read())
      const seen = JSON.stringify(answers) + said.join('\n')
      for (const word of [TITLE, FOLDER, FOLDER.replaceAll('/', '\\/'), PREVIEW, 'redacted']) expect(seen).not.toContain(word)
    })
  })

  describe('no log, and failed reads', () => {
    it('no log is a front unknown, with no line, and a log made again is read from its start', async () => {
      const { log, focus } = setup()
      log.remove()
      expect(await focus.read()).toEqual({})
      expect(said).toEqual([])
      log.append(focused(W1, S1) + keyed(WIN1, W1))
      expect(await focus.read()).toEqual({ workspace: low(W1), surface: low(S1) })
      log.remove()
      expect(await focus.read()).toEqual({})
      log.append(keyed(WIN1, W1))
      expect(await focus.read()).toEqual({ workspace: low(W1) })
      expect(log.positions.at(-1)).toBe(0)
      expect(gaps()).toBe(0)
    })

    it('a failed read is a gap, said once until a read succeeds, and the next read takes the newest 1 MiB again', async () => {
      const { log, focus } = setup()
      log.append(focused(W1, S1) + keyed(WIN1, W1))
      await focus.read()
      log.append(focused(W2, S2))
      log.failNext()
      expect(await focus.read()).toEqual({})
      expect(gaps()).toBe(1)
      log.failNext()
      expect(await focus.read()).toEqual({})
      vi.spyOn(log, 'open').mockRejectedValueOnce(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
      expect(await focus.read()).toEqual({})
      expect(gaps()).toBe(1)
      expect(await focus.read()).toEqual({ workspace: low(W1), surface: low(S1) })
      expect(log.positions.at(-1)).toBe(0)
      log.append(keyed(WIN1, W2))
      log.failNext()
      expect(await focus.read()).toEqual({})
      expect(gaps()).toBe(2)
    })
  })

  describe('bounds', () => {
    it('past 256 workspaces the one least recently set is forgotten', async () => {
      const { log, focus } = setup()
      let text = ''
      for (let n = 1; n <= MAX_WORKSPACES; n++) text += focused(W(n), S(n))
      // W1 set again, so W2 is the least recently set when one more comes.
      text += focused(W1, S1) + focused(W(MAX_WORKSPACES + 1), S(MAX_WORKSPACES + 1))
      log.append(text + keyed(WIN1, W1))
      expect(await focus.read()).toEqual({ workspace: low(W1), surface: low(S1) })
      log.append(keyed(WIN1, W2))
      expect(await focus.read()).toEqual({ workspace: low(W2) })
      log.append(keyed(WIN1, W3))
      expect(await focus.read()).toEqual({ workspace: low(W3), surface: low(S3) })
      log.append(keyed(WIN1, W(MAX_WORKSPACES + 1)))
      expect(await focus.read()).toEqual({ workspace: low(W(MAX_WORKSPACES + 1)), surface: low(S(MAX_WORKSPACES + 1)) })
    })

    it('past 16 windows the oldest is forgotten', async () => {
      const { log, focus } = setup()
      let text = focused(W1, S1)
      for (let n = 1; n <= MAX_WINDOWS + 1; n++) text += created(WIN(n))
      for (let n = 3; n <= MAX_WINDOWS + 1; n++) text += windowClosed(WIN(n))
      // WIN1 went with the 17th: WIN2 alone is known, so a selection names the front.
      log.append(text + selected(W1))
      expect(await focus.read()).toEqual({ workspace: low(W1), surface: low(S1) })
    })
  })

  describe('one read at a time', () => {
    it('ten reads asked during one share the one read after it', async () => {
      const { log, focus } = setup()
      const stats = vi.spyOn(log, 'fstat')
      log.append(focused(W1, S1) + keyed(WIN1, W1))
      const release = log.hold()
      const first = focus.read()
      await vi.waitFor(() => expect(log.positions).toHaveLength(1))
      // Past its fstat: what comes now is the next read's.
      log.append(focused(W1, S2))
      const asked = Array.from({ length: 10 }, () => focus.read())
      release()
      expect(await first).toEqual({ workspace: low(W1), surface: low(S1) })
      expect(new Set(asked).size).toBe(1)
      expect(await asked[0]).toEqual({ workspace: low(W1), surface: low(S2) })
      expect(stats).toHaveBeenCalledTimes(2)
    })

    it('a reset during a read: that read answers nothing and commits nothing, and the next is a first read', async () => {
      const { log, focus } = setup()
      log.append(focused(W1, S1) + keyed(WIN1, W1))
      const release = log.hold()
      const during = focus.read()
      await vi.waitFor(() => expect(log.positions).toHaveLength(1))
      focus.reset()
      release()
      expect(await during).toEqual({})
      expect(await focus.read()).toEqual({ workspace: low(W1), surface: low(S1) })
      expect(log.positions).toEqual([0, 0])
      expect(gaps()).toBe(0)
    })

    // The devices reset as the dial goes: a read asked before it would open the log with no dial attached, and keep what
    // it read past the reset.
    it('a reset drops the read asked during one: it never runs, and one asked after the reset is a first read', async () => {
      const { log, focus } = setup()
      log.append(focused(W1, S1) + keyed(WIN1, W1))
      let release = log.hold()
      const during = focus.read()
      await vi.waitFor(() => expect(log.positions).toHaveLength(1))
      const asked = focus.read()
      focus.reset()
      release()
      expect(await during).toEqual({})
      expect(await asked).toEqual({})
      expect(log.opens).toBe(1)
      release = log.hold()
      const next = focus.read()
      await vi.waitFor(() => expect(log.positions).toHaveLength(2))
      focus.reset()
      const after = focus.read()
      release()
      expect(await next).toEqual({})
      expect(await after).toEqual({ workspace: low(W1), surface: low(S1) })
      expect(log.positions).toEqual([0, 0, 0])
      expect(gaps()).toBe(0)
    })

    // The dial back while the dropped read still waits: its settle's read is not handed the dropped one's nothing.
    it('a read asked after a reset, while the one asked before it still waits, is a first read of its own', async () => {
      const { log, focus } = setup()
      log.append(focused(W1, S1) + keyed(WIN1, W1))
      const release = log.hold()
      const during = focus.read()
      await vi.waitFor(() => expect(log.positions).toHaveLength(1))
      const asked = focus.read()
      focus.reset()
      const after = focus.read()
      release()
      expect(await during).toEqual({})
      expect(await asked).toEqual({})
      expect(await after).toEqual({ workspace: low(W1), surface: low(S1) })
      expect(log.positions).toEqual([0, 0])
      expect(gaps()).toBe(0)
    })
  })

  it('says the first read\'s time after a reset, then only a read slower than every one said', async () => {
    const times = [0, 5, 10, 12, 20, 40, 50, 52]
    const { log, focus } = setup({ monotonic: () => times.shift() ?? 0 })
    log.append(focused(W1, S1))
    await focus.read()
    await focus.read()
    await focus.read()
    focus.reset()
    await focus.read()
    expect(said).toEqual(['[cmux] read · events · 5', '[cmux] read · events · 20', '[cmux] read · events · 2'])
  })

  describe('on disk', () => {
    it('reads a real log it may only read, and leaves its bytes and modified time as they were', async () => {
      const folder = mkdtempSync(join(tmpdir(), 'cmux-events-'))
      onTestFinished(() => rmSync(folder, { recursive: true, force: true }))
      const path = join(folder, CMUX_EVENTS)
      writeFileSync(path, focused(W1, S1) + keyed(WIN1, W1))
      chmodSync(path, 0o400)
      const bytes = readFileSync(path)
      const { mtimeMs } = statSync(path)
      const focus = createCmuxFocus({ files: cmuxLogFiles(), path, monotonic: () => performance.now(), log: (line) => said.push(line) })
      expect(await focus.read()).toEqual({ workspace: low(W1), surface: low(S1) })
      expect(readFileSync(path)).toEqual(bytes)
      expect(statSync(path).mtimeMs).toBe(mtimeMs)
      const none = createCmuxFocus({ files: cmuxLogFiles(), path: join(folder, 'gone.jsonl'), monotonic: () => 0, log: (line) => said.push(line) })
      expect(await none.read()).toEqual({})
      expect(gaps()).toBe(0)
    })
  })
})
