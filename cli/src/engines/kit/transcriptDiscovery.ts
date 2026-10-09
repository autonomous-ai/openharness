import { locateTranscript, transcriptGroups, type TranscriptLocation } from './sessionLocation.js'

/**
 * Poll only while a known session has no transcript. A recursive watcher over the project tree once
 * stalled the macOS daemon with thousands of FSEvents registrations for a handful of transcripts.
 * Every lookup carries its own candidate identity: remove, replacement and stop revoke it immediately.
 */
export class TranscriptDiscovery {
  private readonly pending = new Map<string, { looking: boolean }>()
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
    const found = await locateTranscript(this.rule, this.home, id, { valid: this.valid })
    if (this.pending.get(id) !== candidate) return
    candidate.looking = false
    if (found) {
      this.pending.delete(id)
      if (!this.pending.size) this.clearTimer()
      this.onFound(id, found)
    } else this.schedule()
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
      const groups = await transcriptGroups(this.home, this.rule)
      for (const [id, candidate] of candidates) {
        if (this.pending.get(id) !== candidate) continue
        const found = await locateTranscript(this.rule, this.home, id, { groups, valid: this.valid })
        if (!found || this.pending.get(id) !== candidate) continue
        this.pending.delete(id)
        this.onFound(id, found)
      }
    } finally {
      this.sweeping = false
      if (!this.pending.size) this.clearTimer()
    }
  }
}
