import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { validTranscriptPath } from '../../lib/registry.js'

const SESSION_RE = /^[0-9a-f-]{16,}$/i

/**
 * How often a pending session is re-checked for a transcript that has since appeared. A Cursor
 * session is pending only between its process turning up and its first transcript write, so this
 * is a short-lived poll — and no poll runs at all while nothing is pending.
 */
export const CURSOR_TRANSCRIPT_POLL_MS = 1000

/**
 * Finds the transcript of a Cursor session whose process is already known but whose JSONL has not
 * been written yet.
 *
 * This POLLS rather than watching `<CURSOR_HOME>/projects`. A recursive watcher over that tree was
 * the daemon's single worst behaviour on macOS: one machine had 6,849 folders under it for 10
 * transcripts, and libuv keeps every watched path in ONE FSEvents stream that it tears down and
 * recreates on each add or remove — thousands of adds meant the event loop spent minutes inside
 * FSEventStreamCreate, `FSEventStreamStart` began failing (surfaced by libuv as `EMFILE` to every
 * handle at once, 2,700 errors a minute in the log), and the loopback API the desktop app relies on
 * stopped answering: "This computer · Offline", `agent_create` timing out. A readdir of the project
 * list plus one stat per pending session, once a second, finds the same file for no standing cost.
 */
export class CursorTranscriptDiscovery {
  private readonly pending = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private started = false
  private sweeping = false
  /** Bumped by stop(); an add() that started before the bump discards what it finds. */
  private epoch = 0

  constructor(
    private readonly cursorHome: string,
    private readonly onFound: (sessionId: string, transcriptPath: string) => void,
    private readonly pollMs: number = CURSOR_TRANSCRIPT_POLL_MS,
  ) {}

  /** Whether a poll timer is live — true only while at least one session is pending. */
  get isPolling(): boolean {
    return this.timer !== null
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.schedule()
  }

  async add(sessionId: string): Promise<void> {
    if (!SESSION_RE.test(sessionId)) return
    const epoch = this.epoch
    const found = await findCursorTranscript(this.cursorHome, sessionId)
    // Re-checked after the await: a stop() that ran while the lookup was in flight owns this session
    // now — neither a callback nor a pending entry may outlive it.
    if (epoch !== this.epoch) return
    if (found) {
      this.onFound(sessionId, found)
      return
    }
    this.pending.add(sessionId)
    this.schedule()
  }

  remove(sessionId: string): void {
    this.pending.delete(sessionId)
    if (this.pending.size === 0) this.clearTimer()
  }

  async stop(): Promise<void> {
    this.epoch++
    this.pending.clear()
    this.clearTimer()
    this.started = false
  }

  private schedule(): void {
    if (!this.started || this.timer || this.pending.size === 0) return
    this.timer = setInterval(() => { void this.sweep() }, this.pollMs)
    // A pending session must never be what keeps the daemon alive through shutdown.
    this.timer.unref()
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  private async sweep(): Promise<void> {
    if (this.sweeping) return // a slow disk must not stack sweeps on top of each other
    this.sweeping = true
    try {
      // One listing per sweep, shared by every pending session.
      const projects = await listProjects(this.cursorHome)
      for (const sessionId of [...this.pending]) {
        const found = await transcriptAmong(this.cursorHome, projects, sessionId)
        // Re-checked after the await: remove()/stop() may have run while the lookup was in flight.
        if (!found || !this.pending.has(sessionId)) continue
        this.pending.delete(sessionId)
        this.onFound(sessionId, found)
      }
    } finally {
      this.sweeping = false
      if (this.pending.size === 0) this.clearTimer()
    }
  }
}

export async function findCursorTranscript(cursorHome: string, sessionId: string): Promise<string | null> {
  if (!SESSION_RE.test(sessionId)) return null
  return transcriptAmong(cursorHome, await listProjects(cursorHome), sessionId)
}

/** The project folders below `<cursorHome>/projects`; none when the tree does not exist yet. */
async function listProjects(cursorHome: string): Promise<string[]> {
  try { return await readdir(join(cursorHome, 'projects')) } catch { return [] }
}

async function transcriptAmong(cursorHome: string, projects: string[], sessionId: string): Promise<string | null> {
  const root = join(cursorHome, 'projects')
  for (const project of projects) {
    const candidate = join(root, project, 'agent-transcripts', sessionId, `${sessionId}.jsonl`)
    // Existence is probed asynchronously first. validTranscriptPath resolves two realpaths
    // SYNCHRONOUSLY, and paying that for every project folder — hundreds on a machine that has
    // opened many repos — once a second is a visible event-loop hitch. Only a candidate that is
    // actually there pays for the validation.
    if (!(await exists(candidate))) continue
    if (validTranscriptPath('cursor', candidate)) return candidate
  }
  return null
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}
