import type { TerminalLogicalKey } from './terminalTypes.js'

/**
 * Each logical key by its `tmux send-keys` name. The pty host reads the same names (term/src/keys.rs
 * `bytes_for`), so both backends send one key the same way. Its own module so the pty host backend
 * does not load the tmux backend for a table.
 */
export const TMUX_KEYS: Record<TerminalLogicalKey, string> = {
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  backtab: 'BTab',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  backspace: 'BSpace',
  delete: 'DC',
  pageup: 'PPage',
  pagedown: 'NPage',
  'ctrl-c': 'C-c',
  'ctrl-d': 'C-d',
  'ctrl-u': 'C-u',
  'ctrl-w': 'C-w',
  space: 'Space',
  '0': '0',
  '1': '1',
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
}
