import { randomUUID } from 'node:crypto'

export interface SelectionFocus { connId: string; machineId: string; agentId: string }
export interface SelectionCommand {
  agentId: string
  op: 'begin' | 'step' | 'extend' | 'pin' | 'cancel' | 'read' | 'search' | 'match' | 'lines'
  selectionId?: string
  revision?: number
  delta?: number
  extend?: boolean
  query?: string
}
export type SelectionResult = { ok: false; error: string } | {
  ok: true; selectionId: string; revision: number; excerpt: string; rows: number; extending: boolean
  text?: string
  query?: string; match?: number; matches?: number
}

interface Selection extends SelectionFocus {
  id: string
  revision: number
  pinned: boolean
  last?: Extract<SelectionResult, { ok: true }>
}
interface Pending {
  selection: Selection
  requestId: string
  revision: number
  op: SelectionCommand['op']
  resolve: (result: SelectionResult) => void
  timer: ReturnType<typeof setTimeout>
}

/** One reading cursor on THIS desk. A request goes to the exact connection
 * that reported app_focus, including when that socket views a remote machine.
 * No cloud broadcast, inferred recipient, automatic retry, or terminal input. */
export class WindowSelection {
  private selection?: Selection
  private pending?: Pending
  constructor(private readonly wiring: {
    focus: () => SelectionFocus | undefined
    send: (connId: string, payload: Record<string, unknown>) => boolean
    timeoutMs?: number
  }) {}

  async command(command: SelectionCommand): Promise<SelectionResult> {
    if (command.op === 'cancel') {
      const current = this.selection
      if (current && current.id === command.selectionId && current.agentId === command.agentId) this.cancel()
      return { ok: false, error: 'Selection closed.' }
    }
    const focus = this.wiring.focus()
    if (!focus || focus.agentId !== command.agentId) {
      this.cancel()
      return { ok: false, error: 'Select that pane in Harness first.' }
    }
    if (command.op === 'begin') {
      if (command.selectionId !== undefined && !/^[a-zA-Z0-9-]{1,48}$/.test(command.selectionId)) {
        return { ok: false, error: 'Invalid selection identity.' }
      }
      this.cancel()
      this.selection = { ...focus, id: command.selectionId ?? randomUUID(), revision: 0, pinned: false }
    }
    const selection = this.selection
    if (!selection || !sameFocus(focus, selection) ||
      (command.op !== 'begin' && (selection.id !== command.selectionId || selection.revision !== command.revision))) {
      return { ok: false, error: 'That selection expired. Choose the text again.' }
    }
    if (this.pending || selection.pinned) return { ok: false, error: 'Wait for the current selection.' }
    if (command.op === 'read') return selection.last ? { ...selection.last } : { ok: false, error: 'Choose the text again.' }
    if ((command.op === 'step' || command.op === 'match') && (!Number.isSafeInteger(command.delta) || command.delta === 0 || Math.abs(command.delta!) > 8)) {
      return { ok: false, error: 'Invalid selection movement.' }
    }
    if (selection.last?.query && (command.op === 'step' || command.op === 'extend')) return { ok: false, error: 'Choose Lines to adjust this passage.' }
    if (command.op === 'match' && !selection.last?.query) return { ok: false, error: 'Say what to find first.' }
    if (command.op === 'search' && (typeof command.query !== 'string' || !command.query.trim() ||
        Buffer.byteLength(command.query, 'utf8') > 120 || /[\x00-\x1f\x7f-\x9f]/.test(command.query))) {
      return { ok: false, error: 'Say a short phrase to find.' }
    }
    if (command.op === 'extend' && typeof command.extend !== 'boolean') return { ok: false, error: 'Invalid selection range.' }
    const requestId = randomUUID()
    const revision = ++selection.revision
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this.pending?.requestId !== requestId) return
        this.finish({ ok: false, error: 'The app did not answer. Update or reopen Harness.' })
        this.cancel()
      }, this.wiring.timeoutMs ?? 2000)
      this.pending = { selection, requestId, revision, op: command.op, resolve, timer }
      const sent = this.wiring.send(focus.connId, {
        requestId, selectionId: selection.id, revision, agentId: focus.agentId,
        machineId: focus.machineId, op: command.op,
        ...(command.op === 'step' || command.op === 'match' ? { delta: command.delta } : {}),
        ...(command.op === 'extend' ? { extend: command.extend } : {}),
        ...(command.op === 'search' ? { query: command.query } : {}),
      })
      if (!sent) {
        this.finish({ ok: false, error: 'Open Harness on this computer.' })
        this.cancel()
      }
    })
  }

  reply(connId: string, machineId: string, payload: Record<string, unknown>): void {
    const p = this.pending
    if (!p || connId !== p.selection.connId || machineId !== p.selection.machineId ||
      payload.requestId !== p.requestId || payload.selectionId !== p.selection.id ||
      payload.agentId !== p.selection.agentId || payload.machineId !== machineId || payload.revision !== p.revision) return
    if (!sameFocus(this.wiring.focus(), p.selection)) {
      this.finish({ ok: false, error: 'The selected pane changed. Choose the text again.' })
      this.cancel()
      return
    }
    if (payload.ok !== true) {
      // Errors are product text, bounded independently from any selected content.
      this.finish({ ok: false, error: typeof payload.error === 'string' ? payload.error.slice(0, 180) : 'Choose the text again.' })
      this.cancel()
      return
    }
    const { excerpt, rows, extending, text, query, match, matches } = payload
    const searching = typeof query === 'string' && !!query.trim() && Buffer.byteLength(query, 'utf8') <= 120 &&
      !/[\x00-\x1f\x7f-\x9f]/.test(query) && Number.isSafeInteger(matches) && (matches as number) >= 0 &&
      (matches as number) <= 0x7fffffff && Number.isSafeInteger(match) &&
      ((matches === 0 && match === 0 && rows === 0 && excerpt === '' && extending === false) || ((match as number) >= 1 && (match as number) <= (matches as number)))
    if (typeof excerpt !== 'string' || excerpt.length > 240 || !Number.isSafeInteger(rows) ||
      (rows as number) < (searching && matches === 0 ? 0 : 1) || (rows as number) > 16 || typeof extending !== 'boolean' ||
      ((query !== undefined || p.op === 'search' || p.op === 'match') && !searching) ||
      (p.op === 'pin' && (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 4096))) {
      this.finish({ ok: false, error: 'The app returned an invalid selection.' })
      this.cancel()
      return
    }
    if (p.op === 'pin') p.selection.pinned = true
    const result: SelectionResult = { ok: true, selectionId: p.selection.id, revision: p.revision,
      excerpt, rows: rows as number, extending, ...(p.op === 'pin' ? { text: text as string } : {}),
      ...(searching ? { query: query as string, match: match as number, matches: matches as number } : {}) }
    p.selection.last = result
    this.finish(result)
  }

  cancel(): void {
    const selection = this.selection
    this.selection = undefined
    this.finish({ ok: false, error: 'Selection closed.' })
    if (selection) this.wiring.send(selection.connId, {
      requestId: randomUUID(), selectionId: selection.id, revision: selection.revision + 1,
      machineId: selection.machineId, agentId: selection.agentId, op: 'cancel',
    })
  }

  focusChanged(): void {
    if (this.selection && !sameFocus(this.wiring.focus(), this.selection)) this.cancel()
  }

  private finish(result: SelectionResult): void {
    const pending = this.pending
    this.pending = undefined
    if (!pending) return
    clearTimeout(pending.timer)
    pending.resolve(result)
  }
}

function sameFocus(a: SelectionFocus | undefined, b: SelectionFocus): boolean {
  return !!a && a.connId === b.connId && a.machineId === b.machineId && a.agentId === b.agentId
}

/** Keep the user's words intact. The selected output is visibly quoted context,
 * not a command from the device and not an assertion that a file was edited. */
export function withSelectedPassage(instruction: string, passage: string): string {
  return `${instruction}\n\nContext I selected from this agent's terminal:\n${passage.split(/\r?\n/).map(line => `> ${line}`).join('\n')}`
}
