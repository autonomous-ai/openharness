import { basename } from 'node:path'
import { env } from '../config/env.js'
import { terminalActivityReading } from '../cable/terminalActivity.js'
import { connectCodexControl, type CodexControl } from './codexSessionLifecycle.js'
import { codexStoppedGoal } from './codexTurnRecovery.js'
import { argvTokens, processRows, type ProcessRow } from './tmux.js'
import type { RegisteredSession } from './registry.js'
import type { ActivityState } from './turnActivity.js'

export function activityRuntimeKey(session: RegisteredSession): string {
  return JSON.stringify([session.agentId, session.sessionId, session.primaryRuntimeKey, session.processIdentity])
}

/** Read-only connections, shared by profile. Never launch/resume a thread or
 * start an app-server to inspect it. An unrelated server's notLoaded is unknown. */
export class CodexActivityReader {
  private readonly controls = new Map<string, Promise<CodexControl>>()
  private readonly retryAt = new Map<string, number>()
  private rowsAt = -Infinity
  private rows?: Promise<ProcessRow[] | null>
  constructor(private readonly deps = { connect: connectCodexControl, rows: processRows, now: () => performance.now() }) {}
  async read(session: RegisteredSession): Promise<ActivityState> {
    if (session.engine !== 'codex' || !session.processIdentity) return 'unknown'
    const home = session.codexHome || env.CODEX_HOME
    if ((this.retryAt.get(home) ?? 0) > this.deps.now()) return 'unknown'
    if (!this.rows || this.deps.now() - this.rowsAt > 2_000) {
      this.rowsAt = this.deps.now(); this.rows = this.deps.rows()
    }
    const rows = await this.rows
    const owner = rows?.find(row => row.pid === session.processIdentity!.pid
      && row.startMarker === session.processIdentity!.startMarker && row.executable === session.processIdentity!.executable)
    if (!owner) return 'unknown'
    const args = argvTokens(owner.args)
    const option = /^node(?:\.exe)?$/.test(basename(args[0] ?? '')) && /(?:^|\/)codex(?:\.js)?$/.test(args[1] ?? '') ? 2 : 1
    if (args[option] === '--no-daemon' || args.slice(option).some(arg => arg === '--remote' || arg.startsWith('--remote='))) return 'unknown'
    let connection = this.controls.get(home)
    if (!connection) { connection = this.deps.connect(home); this.controls.set(home, connection) }
    try {
      const control = await connection
      const read = await control.request('thread/read', { threadId: session.sessionId })
      if (read?.thread?.id !== session.sessionId) return 'unknown'
      if (read.thread.status?.type === 'active') return 'working'
      if (read.thread.status?.type === 'idle') return 'idle'
      return 'unknown'
    } catch {
      // An old/process-owned engine may share its profile with another server.
      // Do not keep spawning a failed proxy for every session every five seconds.
      if (this.controls.get(home) === connection) this.controls.delete(home)
      void connection.then(control => control.close()).catch(() => {})
      this.retryAt.set(home, this.deps.now() + 60_000)
      return 'unknown'
    }
  }
  close(): void {
    for (const control of this.controls.values()) void control.then(value => value.close()).catch(() => {})
    this.controls.clear()
  }
}

/** A positive, changing live busy indicator can confirm an otherwise quiet
 * process-owned engine. Missing/unrecognized UI is always unknown. */
export class RuntimeActivityReader {
  private readonly footers = new Map<string, { runtime: string; indicator: string | null; stopped: boolean }>()
  constructor(private readonly deps: {
    codex(session: RegisteredSession): Promise<ActivityState>
    capture(session: RegisteredSession): Promise<string | null>
  }) {}
  forget(sessionId: string): void { this.footers.delete(sessionId) }
  async read(session: RegisteredSession): Promise<ActivityState> {
    const state = await this.deps.codex(session)
    if (state !== 'unknown') return state
    if (session.engine !== 'claude' && session.engine !== 'codex') return 'unknown'
    const screen = await this.deps.capture(session)
    const runtime = activityRuntimeKey(session)
    const previous = this.footers.get(session.sessionId)
    const indicator = terminalActivityReading(session.engine, screen)?.indicator ?? null
    const stopped = session.engine === 'codex' && codexStoppedGoal(screen)
    this.footers.set(session.sessionId, { runtime, indicator, stopped })
    if (previous?.runtime !== runtime) return 'unknown'
    if (stopped && previous.stopped) return 'idle'
    if (indicator && previous.indicator && indicator !== previous.indicator) return 'working'
    return 'unknown'
  }
}
