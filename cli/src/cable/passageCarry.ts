import type { SelectionCommand, SelectionResult } from './windowSelection.js'

export interface CarriedPassage {
  readonly id: string
  readonly sourceAgentId: string
  readonly sourceName: string
  readonly text: string
  readonly excerpt: string
  readonly rows: number
  readonly expiresAt: number
}
export type CarryResult = { ok: false; active: false; error: string } | {
  ok: true; active: true; carryId: string; sourceName: string
  excerpt: string; rows: number; ttlMs: number
}
export type CarryRead = { ok: true; passage: CarriedPassage } | { ok: false; error: string }

/** One explicitly selected passage, kept in RAM on this cable connection.
 * Moving to another pane does not change its text. Nothing is delivered until
 * a voice turn names this identity and a specific recipient. */
export class PassageCarry {
  static readonly ttlMs = 5 * 60_000
  private generation = 0
  private item?: CarriedPassage & { key: string }
  private pending?: { id: string; key: string; generation: number; promise: Promise<CarryResult> }

  constructor(private readonly wiring: {
    select: (command: SelectionCommand) => Promise<SelectionResult>
    name: (agentId: string) => Promise<string>
    now?: () => number
  }) {}

  private now(): number { return this.wiring.now?.() ?? Date.now() }
  private fail(error: string): CarryResult { return { ok: false, active: false, error } }
  private state(item: CarriedPassage): CarryResult {
    return { ok: true, active: true, carryId: item.id, sourceName: item.sourceName,
      excerpt: item.excerpt, rows: item.rows, ttlMs: Math.max(0, item.expiresAt - this.now()) }
  }

  prepare(id: string, command: SelectionCommand): Promise<CarryResult> {
    if (!/^[a-zA-Z0-9-]{1,48}$/.test(id) || command.op !== 'pin' ||
        !command.agentId || command.agentId.length > 128 ||
        !/^[a-zA-Z0-9-]{1,48}$/.test(command.selectionId ?? '') ||
        !Number.isSafeInteger(command.revision) || command.revision! < 0) {
      return Promise.resolve(this.fail('Choose the text again.'))
    }
    const key = JSON.stringify([id, command.agentId, command.selectionId, command.revision])
    if (this.pending) return this.pending.key === key ? this.pending.promise
      : Promise.resolve(this.fail('Wait for the selected text.'))
    if (this.item?.id === id && this.item.expiresAt > this.now()) {
      return Promise.resolve(this.item.key === key ? this.state(this.item)
        : this.fail('That carried text has changed. Choose it again.'))
    }
    const generation = ++this.generation
    this.item = undefined
    const promise = (async (): Promise<CarryResult> => {
      try {
        const selection = await this.wiring.select(command)
        if (generation !== this.generation) return this.fail('Carrying cancelled.')
        if (!selection.ok) return this.fail(selection.error)
        if (!selection.text?.trim() || Buffer.byteLength(selection.text, 'utf8') > 4096 ||
            selection.rows < 1 || selection.rows > 16) return this.fail('Choose a shorter passage.')
        const name = await this.wiring.name(command.agentId)
        if (generation !== this.generation) return this.fail('Carrying cancelled.')
        this.item = Object.freeze({ id, key, sourceAgentId: command.agentId,
          sourceName: [...name.replace(/[\x00-\x1f\x7f]/g, ' ')].slice(0, 60).join('') || 'Harness',
          text: selection.text, excerpt: selection.excerpt, rows: selection.rows,
          expiresAt: this.now() + PassageCarry.ttlMs })
        return this.state(this.item)
      } catch (_) {
        return this.fail('Could not carry that text. Choose it again.')
      } finally {
        if (this.pending?.generation === generation) this.pending = undefined
        void this.wiring.select({ op: 'cancel', agentId: command.agentId,
          selectionId: command.selectionId }).catch(() => {})
      }
    })()
    this.pending = { id, key, generation, promise }
    return promise
  }

  read(id: string): CarryRead {
    const item = this.item
    if (!item || item.id !== id || item.expiresAt <= this.now()) {
      if (item?.expiresAt !== undefined && item.expiresAt <= this.now()) this.item = undefined
      return { ok: false, error: 'The carried text expired. Choose it again.' }
    }
    return { ok: true, passage: item }
  }

  clear(id?: string): void {
    if (id !== undefined && id !== this.item?.id && id !== this.pending?.id) return
    this.generation++
    this.item = undefined
    this.pending = undefined
  }
}

export function withCarriedPassage(instruction: string, passage: CarriedPassage): string {
  return `${instruction}\n\nContext I selected from harness ${JSON.stringify(passage.sourceName)}:\n` +
    passage.text.split(/\r?\n/).map(line => `> ${line}`).join('\n')
}
