// The window as the loop sees it: VS Code's API stays behind this, so the loop's tests drive a fake window.

/** The devices' listener refuses a `vscode-state` that lists more. */
export const MAX_TERMINALS = 32

export interface WindowState { terminals: number[]; active: number | null; focused: boolean }

/** The window as the loop sees it. */
export interface WindowFacade {
  /** A remote window (SSH, WSL, a container): its terminals are another computer's. */
  readonly remote: boolean
  state(): WindowState
  /** `changed` runs whenever state() may answer differently. Returns its dispose. */
  onChange(changed: () => void): () => void
  /** Shows the terminal whose shell has that pid, with focus; false when none has. */
  show(pid: number): boolean
  /** Brings this window in front of VS Code's others, and VS Code in front of other apps. */
  raise(): void
  /** One line toward older lines (`up`) or newer, in the active terminal. */
  scrollLine(up: boolean): Promise<void>
  /** Presses PageUp (`up`, toward older lines) or PageDown in the terminal whose shell has that pid: one of two fixed
   *  key sequences, with no newline. False when no terminal has that shell. The one member that writes to a terminal. */
  pageKey(pid: number, up: boolean): boolean
}

/** The first 32 distinct shells whose pid is known (an integer in 2..2^31-1), in order; `active` only when it is one of them. */
export function windowState(shells: readonly (number | undefined)[], active: number | undefined, focused: boolean): WindowState {
  const terminals: number[] = []
  for (const pid of shells) {
    if (terminals.length === MAX_TERMINALS) break
    if (isPid(pid) && !terminals.includes(pid)) terminals.push(pid)
  }
  return { terminals, active: active !== undefined && terminals.includes(active) ? active : null, focused }
}

/** The pids the listener takes: 0 and 1 are never a terminal's shell. */
function isPid(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 2 && value < 2 ** 31
}
