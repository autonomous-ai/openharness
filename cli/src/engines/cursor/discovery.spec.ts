import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The tree below a Cursor home is the wrong thing to watch: one macOS box had 6,849 folders under
// ~/.cursor/projects for 10 transcripts, and a recursive watcher of that size stalls the daemon's
// event loop (libuv rebuilds its single FSEvents stream on every add/remove). The discovery must
// never reach for a directory watcher again, whichever library it would be.
vi.mock('chokidar', () => ({
  default: { watch: () => { throw new Error('cursor discovery must not watch the projects tree') } },
}))

const SESSION_A = 'aaaaaaaa-1111-4222-8333-444444444444'
const SESSION_B = 'bbbbbbbb-1111-4222-8333-444444444444'
// Fast enough that a test waiting on a sweep finishes in milliseconds, slow enough that a sweep
// never overlaps the one before it on a loaded CI box.
const POLL_MS = 20

let cursorHome = ''

function writeTranscript(project: string, sessionId: string): string {
  const dir = join(cursorHome, 'projects', project, 'agent-transcripts', sessionId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${sessionId}.jsonl`)
  writeFileSync(path, '{"role":"user"}\n')
  return path
}

// `validTranscriptPath` checks candidates against the process-wide `env.CURSOR_HOME`, which the config
// module resolves once at import time — so the module graph is reset and re-imported per test with
// the throwaway home already in the environment (the same shape registry.spec.ts uses).
async function loadDiscovery() {
  vi.resetModules()
  process.env.CURSOR_HOME = cursorHome
  return import('./discovery.js')
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4))
}

describe('CursorTranscriptDiscovery', () => {
  beforeEach(() => {
    cursorHome = mkdtempSync(join(tmpdir(), 'cursor-discovery-'))
    mkdirSync(join(cursorHome, 'projects'), { recursive: true })
  })

  afterEach(() => {
    delete process.env.CURSOR_HOME
    rmSync(cursorHome, { recursive: true, force: true })
  })

  it('reports a transcript that already exists without polling', async () => {
    const { CursorTranscriptDiscovery } = await loadDiscovery()
    const expected = writeTranscript('proj-1', SESSION_A)
    const onFound = vi.fn()
    const discovery = new CursorTranscriptDiscovery(cursorHome, onFound, POLL_MS)
    await discovery.start()

    await discovery.add(SESSION_A)

    expect(onFound).toHaveBeenCalledTimes(1)
    expect(onFound).toHaveBeenCalledWith(SESSION_A, expected)
    expect(discovery.isPolling).toBe(false)
    await discovery.stop()
  })

  it('polls only while a session is pending and reports the transcript once it appears', async () => {
    const { CursorTranscriptDiscovery } = await loadDiscovery()
    const onFound = vi.fn()
    const discovery = new CursorTranscriptDiscovery(cursorHome, onFound, POLL_MS)
    await discovery.start()

    await discovery.add(SESSION_A)
    expect(onFound).not.toHaveBeenCalled()
    expect(discovery.isPolling).toBe(true)

    const expected = writeTranscript('proj-late', SESSION_A)
    await vi.waitFor(() => expect(onFound).toHaveBeenCalledWith(SESSION_A, expected))

    // Found once, then the poll shuts itself off — nothing is left to look for.
    await settle()
    expect(onFound).toHaveBeenCalledTimes(1)
    expect(discovery.isPolling).toBe(false)
    await discovery.stop()
  })

  it('finds transcripts added before start() once polling begins', async () => {
    const { CursorTranscriptDiscovery } = await loadDiscovery()
    const onFound = vi.fn()
    const discovery = new CursorTranscriptDiscovery(cursorHome, onFound, POLL_MS)

    await discovery.add(SESSION_A)
    expect(discovery.isPolling).toBe(false)
    const expected = writeTranscript('proj-1', SESSION_A)

    await discovery.start()
    await vi.waitFor(() => expect(onFound).toHaveBeenCalledWith(SESSION_A, expected))
    await discovery.stop()
  })

  it('stops looking for a session that was removed', async () => {
    const { CursorTranscriptDiscovery } = await loadDiscovery()
    const onFound = vi.fn()
    const discovery = new CursorTranscriptDiscovery(cursorHome, onFound, POLL_MS)
    await discovery.start()
    await discovery.add(SESSION_A)
    await discovery.add(SESSION_B)

    discovery.remove(SESSION_A)
    writeTranscript('proj-1', SESSION_A)
    const expectedB = writeTranscript('proj-2', SESSION_B)

    await vi.waitFor(() => expect(onFound).toHaveBeenCalledWith(SESSION_B, expectedB))
    await settle()
    expect(onFound).toHaveBeenCalledTimes(1)
    expect(discovery.isPolling).toBe(false)
    await discovery.stop()
  })

  it('reports nothing after stop()', async () => {
    const { CursorTranscriptDiscovery } = await loadDiscovery()
    const onFound = vi.fn()
    const discovery = new CursorTranscriptDiscovery(cursorHome, onFound, POLL_MS)
    await discovery.start()
    await discovery.add(SESSION_A)

    await discovery.stop()
    expect(discovery.isPolling).toBe(false)
    writeTranscript('proj-1', SESSION_A)

    await settle()
    expect(onFound).not.toHaveBeenCalled()
  })

  it('drops what an add() in flight finds once stop() has run', async () => {
    const { CursorTranscriptDiscovery } = await loadDiscovery()
    writeTranscript('proj-1', SESSION_A)
    const onFound = vi.fn()
    const discovery = new CursorTranscriptDiscovery(cursorHome, onFound, POLL_MS)
    await discovery.start()

    const adding = discovery.add(SESSION_A) // its lookup is now awaiting the disk
    await discovery.stop()
    await adding

    expect(onFound).not.toHaveBeenCalled()
    expect(discovery.isPolling).toBe(false)
  })

  it('ignores session ids that cannot name a transcript', async () => {
    const { CursorTranscriptDiscovery } = await loadDiscovery()
    const onFound = vi.fn()
    const discovery = new CursorTranscriptDiscovery(cursorHome, onFound, POLL_MS)
    await discovery.start()

    await discovery.add('../../etc/passwd')
    await discovery.add('short')

    expect(discovery.isPolling).toBe(false)
    expect(onFound).not.toHaveBeenCalled()
    await discovery.stop()
  })

  it('never watches the projects tree, however large it is', async () => {
    const { CursorTranscriptDiscovery } = await loadDiscovery()
    // A thousand unrelated project folders — the shape of a Cursor home on a machine that has opened
    // many repos. The old recursive watcher registered every one of these with the OS.
    for (let i = 0; i < 1000; i++) mkdirSync(join(cursorHome, 'projects', `proj-${i}`, 'deep', 'er'), { recursive: true })
    const onFound = vi.fn()
    const discovery = new CursorTranscriptDiscovery(cursorHome, onFound, POLL_MS)

    const started = Date.now()
    await discovery.start()
    await discovery.add(SESSION_A)
    const expected = writeTranscript('proj-999', SESSION_A)
    await vi.waitFor(() => expect(onFound).toHaveBeenCalledWith(SESSION_A, expected))
    await discovery.stop()

    expect(Date.now() - started).toBeLessThan(2000)
  })
})
