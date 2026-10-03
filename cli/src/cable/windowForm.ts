import { randomUUID } from 'node:crypto'

export interface FormCommand {
  formId: string
  surface?: 'new' | 'find'
  op: 'open' | 'state' | 'move' | 'activate' | 'back' | 'close' | 'query.begin' | 'query' | 'query.cancel'
  revision?: number
  delta?: number
  queryId?: string
  text?: string
}
export interface FormResult {
  ok: boolean; active: boolean; revision?: number
  title?: string; label?: string; detail?: string; previous?: string; next?: string
  error?: string; status?: string; action?: string
  position?: number; total?: number; busy?: boolean; enabled?: boolean
  canQuery?: boolean; query?: string; queryId?: string
}
interface Form { id: string; connId: string; machineId: string; surface: 'new' | 'find' }
interface Pending { form: Form; requestId: string; command: FormCommand; resolve: (r: FormResult) => void; timer: ReturnType<typeof setTimeout> }

/** The actual Cmd-N form or Cmd-P finder, in one exact desktop window. A timeout never retries
 * activation: a lost launch reply must be inspected through the form's receipt. */
export class WindowForm {
  private form?: Form
  private pending?: Pending
  constructor(private readonly wiring: {
    focus: () => { connId: string; machineId: string } | undefined
    send: (connId: string, payload: Record<string, unknown>) => boolean
    timeoutMs?: number
    log?: (line: string) => void
  }) {}

  command(command: FormCommand): Promise<FormResult> {
    const fail = (error: string): FormResult => {
      // These are fixed product errors, never names, queries or transcripts.
      this.wiring.log?.(`picker ${command.op} refused: ${error}`)
      return { ok: false, active: false, error }
    }
    if (!/^[a-zA-Z0-9-]{1,48}$/.test(command.formId) ||
        (command.surface !== undefined && !['new', 'find'].includes(command.surface)) ||
        !['open', 'state', 'move', 'activate', 'back', 'close', 'query.begin', 'query', 'query.cancel'].includes(command.op) ||
        (command.op.startsWith('query') && (typeof command.queryId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(command.queryId))) ||
        (command.op === 'query' && (typeof command.text !== 'string' || !command.text.trim() || command.text.length > 240)) ||
        (command.op === 'move' && (!Number.isSafeInteger(command.delta) || !command.delta || Math.abs(command.delta) > 8)) ||
        (command.op !== 'open' && (!Number.isSafeInteger(command.revision) || command.revision! < 0))) {
      return Promise.resolve(fail('Invalid form command.'))
    }
    if (command.op === 'query.cancel') {
      const form = this.form
      if (form?.id === command.formId) {
        if (this.pending?.command.queryId === command.queryId) this.finish(fail('Voice search cancelled.'))
        this.wiring.send(form.connId, { ...command, requestId: randomUUID(), expiresAt: Date.now() + 2000 })
      }
      return Promise.resolve({ ok: true, active: false })
    }
    if (this.pending) return Promise.resolve(fail('Wait for the current choice.'))
    if (command.op === 'open' && this.form?.id !== command.formId) {
      const focus = this.wiring.focus()
      if (!focus) return Promise.resolve(fail('Open Harness on this computer.'))
      this.form = { id: command.formId, surface: command.surface ?? 'new', ...focus }
    }
    const form = this.form
    if (!form || form.id !== command.formId) return Promise.resolve(fail('Open New Harness again.'))
    if (command.surface !== undefined && command.surface !== form.surface) {
      return Promise.resolve(fail('This picker has changed. Open it again.'))
    }
    const requestId = randomUUID(), timeout = this.wiring.timeoutMs ?? 2000
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this.pending?.requestId !== requestId) return
        this.finish(fail('No reply. Check Harness on desktop.'))
        // Keep the window identity for a read-only state request. Never replay
        // the action and never automatically dismiss an uncertain creation.
      }, timeout)
      this.pending = { form, requestId, command, resolve, timer }
      if (!this.wiring.send(form.connId, { ...command, requestId, expiresAt: Date.now() + timeout })) {
        this.finish(fail('Open Harness on this computer.'))
      }
    })
  }

  reply(connId: string, machineId: string, payload: Record<string, unknown>): void {
    const p = this.pending
    if (!p || p.form.connId !== connId || p.form.machineId !== machineId ||
        p.form.id !== payload.formId || p.requestId !== payload.requestId) return
    const invalid = () => this.finish({ ok: false, active: false, error: 'The app returned an invalid form.' })
    if (typeof payload.ok !== 'boolean' || typeof payload.active !== 'boolean') return invalid()
    const r: FormResult = { ok: payload.ok, active: payload.active }
    // Bounded UTF-8 strings fit the small device without splitting a character.
    const fields = { title: 79, label: 159, detail: 383, previous: 95, next: 95, error: 179, status: 95, action: 31, query: 239 } as const
    for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
      const limit = fields[key]
      const value = payload[key]
      if (value !== undefined && typeof value !== 'string') return invalid()
      if (typeof value === 'string') r[key] = utf8Prefix(value, limit)
    }
    if (r.active) {
      for (const key of ['revision', 'position', 'total'] as const) {
        const value = payload[key]
        if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2147483647) return invalid()
        r[key] = value as number
      }
      if (typeof payload.busy !== 'boolean' || typeof payload.enabled !== 'boolean') return invalid()
      r.busy = payload.busy; r.enabled = payload.enabled
      r.canQuery = payload.canQuery === true
    }
    if (p.command.op === 'query.begin' && r.ok) {
      if (!r.active || !r.canQuery || payload.queryId !== p.command.queryId) return invalid()
      r.queryId = payload.queryId as string
    }
    if (p.command.op !== 'state' || !r.ok) {
      const reason = r.error === 'Return to the Harness window first.' ? 'foreground-required' :
        r.error === 'Open the Harness workspace first.' ? 'workspace-required' :
        r.error === 'Open harness search on desktop first.' ? 'finder-unavailable' : r.ok ? 'ready' : 'desktop-refused'
      this.wiring.log?.(`picker ${p.command.op} reply ok=${Number(r.ok)} active=${Number(r.active)} query=${Number(r.canQuery === true)} busy=${Number(r.busy === true)} reason=${reason}`)
    }
    this.finish(r)
  }

  disconnected(connId: string): void {
    if (this.form?.connId !== connId) return
    this.form = undefined
    this.finish({ ok: false, active: false, error: 'Harness disconnected. Open the picker again.' })
  }

  clear(): void {
    this.form = undefined
    this.finish({ ok: false, active: false, error: 'Device disconnected.' })
  }

  private finish(r: FormResult): void {
    const p = this.pending
    this.pending = undefined
    if (p) { clearTimeout(p.timer); p.resolve(r) }
  }
}

function utf8Prefix(text: string, cap: number): string {
  let result = '', used = 0
  for (const c of text) {
    const bytes = Buffer.byteLength(c)
    if (used + bytes > cap) break
    result += c; used += bytes
  }
  return result
}
