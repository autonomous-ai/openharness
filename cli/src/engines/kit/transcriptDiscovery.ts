import { locateTranscript, transcriptGroups, type TranscriptLocation } from './sessionLocation.js'

/**
 * Poll only while a known session has no transcript. A recursive watcher over the project tree once
 * stalled the macOS daemon with thousands of FSEvents registrations for a handful of transcripts.
 * Every lookup carries its own candidate identity: remove, replacement and stop revoke it immediately.
 */
export class TranscriptDiscovery {
  private readonly pending = new Map<string, { looking: boolean; detail?: string }>()
  private timer: NodeJS.Timeout | null = null
  private started = false
  private sweeping = false

  constructor(private readonly home: string, private readonly rule: TranscriptLocation,
    private readonly onFound: (id: string, path: string) => void,
    private readonly valid: (path: string) => boolean, private readonly pollMs: number,
  ) {}

  get isPolling(): boolean { return this.timer !== null }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.schedule()
  }

  async add(id: string): Promise<void> {
    if (!this.rule.id.test(id)) return
    const candidate = { looking: true }
    this.pending.set(id, candidate)
    try {
      const found = await locateTranscript(this.rule, this.home, id, { valid: this.valid })
      if (found && this.pending.get(id) === candidate) this.publish(id, candidate, found)
    } catch (error) { this.hold(id, candidate, error) }
    finally {
      candidate.looking = false
      this.schedule()
    }
  }

  private hold(id: string, candidate: { looking: boolean; detail?: string }, error: unknown): void {
    if (this.pending.get(id) !== candidate) return
    const detail = error instanceof Error ? error.message : String(error)
    if (candidate.detail === detail) return
    candidate.detail = detail
    console.error(`[discovery] transcript ${id} held · ${detail}`)
  }

  private publish(id: string, candidate: { looking: boolean }, found: string): void {
    // A failed publication keeps the pending intent. The callback may also remove or replace it.
    this.onFound(id, found)
    if (this.pending.get(id) === candidate) this.pending.delete(id)
    if (!this.pending.size) this.clearTimer()
  }

  remove(id: string): void {
    this.pending.delete(id)
    if (!this.pending.size) this.clearTimer()
  }

  async stop(): Promise<void> {
    this.pending.clear()
    this.clearTimer()
    this.started = false
  }

  private schedule(): void {
    if (!this.started || this.timer || !this.pending.size) return
    this.timer = setInterval(() => {
      void this.sweep().catch(error => console.error('[discovery] transcript lookup failed', error))
    }, this.pollMs)
    this.timer.unref()
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  private async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    const candidates = [...this.pending].filter(([, candidate]) => !candidate.looking)
    try {
      let groups: string[] | undefined
      try { if (this.rule.kind !== 'direct') groups = await transcriptGroups(this.home, this.rule) }
      catch (error) {
        for (const [id, candidate] of candidates) this.hold(id, candidate, error)
        return
      }
      for (const [id, candidate] of candidates) {
        if (this.pending.get(id) !== candidate) continue
        candidate.looking = true
        try {
          const found = await locateTranscript(this.rule, this.home, id, { groups, valid: this.valid })
          if (found && this.pending.get(id) === candidate) this.publish(id, candidate, found)
        } catch (error) { this.hold(id, candidate, error) }
        finally { candidate.looking = false }
      }
    } finally {
      this.sweeping = false
      if (!this.pending.size) this.clearTimer()
    }
  }
}
