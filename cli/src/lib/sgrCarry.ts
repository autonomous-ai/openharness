/**
 * The SGR state a tmux capture leaves open at the end of one row, re-stated at the start of the next.
 *
 * ⚠️ **`capture-pane -e` is a diff, not a set of self-contained rows.** tmux writes only the SGR that
 * changes from one cell to the next, and that includes the step from the last cell of row N to the
 * first cell of row N+1. A dim command line that wraps (Codex's `Ran …` output) arrives as
 * `ESC[2mdim text that wraps ` and then `past twenty cols` with no SGR at all, because tmux considers
 * dim still in force. Its empty rows carry the state across without writing a byte.
 *
 * The snapshot builders reset SGR at every row end, and they must keep doing so: a background left
 * active at EOL would otherwise fill the next row when it scrolls in. The reset alone, though, turned
 * every carried cell back into plain default text, so the same Codex output read dim live and bright
 * after the next keyframe (open, resize, resync, reconnect). This tracker is the other half: whatever
 * tmux assumed was still active is written again after the reset.
 */

type SgrSlot =
  | 'bold' | 'faint' | 'italic' | 'underline' | 'blink' | 'inverse' | 'hidden' | 'strike' | 'overline'
  | 'fg' | 'bg' | 'underlineColor'

/** Emission order, so the same state always serializes to the same bytes. */
const SLOTS: readonly SgrSlot[] = [
  'bold', 'faint', 'italic', 'underline', 'blink', 'inverse', 'hidden', 'strike', 'overline',
  'fg', 'bg', 'underlineColor',
]

/** Plain SGR codes that set one slot, or clear the listed ones. */
const SETS: Readonly<Record<number, SgrSlot>> = {
  1: 'bold', 2: 'faint', 3: 'italic', 4: 'underline', 5: 'blink', 6: 'blink', 7: 'inverse', 8: 'hidden',
  9: 'strike', 21: 'underline', 53: 'overline',
}
const CLEARS: Readonly<Record<number, readonly SgrSlot[]>> = {
  22: ['bold', 'faint'], 23: ['italic'], 24: ['underline'], 25: ['blink'], 27: ['inverse'], 28: ['hidden'],
  29: ['strike'], 39: ['fg'], 49: ['bg'], 55: ['overline'], 59: ['underlineColor'],
}
const EXTENDED_COLOR: Readonly<Record<number, SgrSlot>> = { 38: 'fg', 48: 'bg', 58: 'underlineColor' }

/** Private-marker CSI (`CSI > 4 ; 2 m`) is not SGR, so it never matches. */
const SGR_PATTERN = /\u001b\[([0-9;:]*)m/g

function colorSlot(code: number): SgrSlot | undefined {
  if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) return 'fg'
  if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) return 'bg'
  return undefined
}

export class SgrCarry {
  private readonly state = new Map<SgrSlot, string>()

  /** The SGR that re-establishes the carried state, or '' when nothing is carried. */
  get restore(): string {
    if (this.state.size === 0) return ''
    return `\u001b[${SLOTS.flatMap((slot) => this.state.get(slot) ?? []).join(';')}m`
  }

  /** Read one captured row and move the state to where tmux leaves it at that row's end. */
  feed(row: string): void {
    for (const match of row.matchAll(SGR_PATTERN)) this.apply(match[1].split(';'))
  }

  private apply(params: readonly string[]): void {
    for (let index = 0; index < params.length; index++) {
      const param = params[index]
      if (param.includes(':')) {
        this.applySubParams(param)
        continue
      }
      const code = param === '' ? 0 : Number(param)
      if (code === 0) {
        this.state.clear()
        continue
      }
      const extended = EXTENDED_COLOR[code]
      if (extended) {
        // `38;5;n` or `38;2;r;g;b`: the colour is the code plus the parameters that belong to it.
        const take = params[index + 1] === '5' ? 2 : params[index + 1] === '2' ? 4 : 0
        if (take === 0 || index + take >= params.length) return
        this.state.set(extended, params.slice(index, index + take + 1).join(';'))
        index += take
        continue
      }
      const set = SETS[code] ?? colorSlot(code)
      if (set) {
        this.state.set(set, param)
        continue
      }
      for (const slot of CLEARS[code] ?? []) this.state.delete(slot)
    }
  }

  /** Colon forms carry their own sub-parameters: `4:3` (curly underline), `38:2::r:g:b`. */
  private applySubParams(param: string): void {
    const [head, first] = param.split(':')
    const code = Number(head)
    if (code === 4) {
      if (first === '0') this.state.delete('underline')
      else this.state.set('underline', param)
      return
    }
    const extended = EXTENDED_COLOR[code]
    if (extended) this.state.set(extended, param)
  }
}
