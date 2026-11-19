/**
 * The colours the desktop app paints its terminal panes with, as tmux needs to hear them.
 *
 * A TUI inside a pane (Codex) asks its terminal `OSC 10;?` / `OSC 11;?` once at startup and picks
 * a light or dark palette from the answer. The terminal is tmux, and tmux answers from the FIRST
 * client attached to the session — the daemon's control-mode client normally, which yields black
 * and a dark palette; but a person who `tmux attach`es a light-themed terminal first makes tmux
 * answer white, and Codex then draws pale-green/pink diff rows with dark text inside the app's
 * dark pane. Measured on tmux 3.7c: the `window-style` option wins over every client's colours in
 * that reply, and it changes nothing a control-mode client receives (the style is painted only for
 * tty clients). So the app tells the daemon its colours, and the daemon sets `window-style` on the
 * sessions it owns.
 *
 * Persisted, because Codex asks once: a daemon restarted before the app reconnects must already
 * know the last colours when it creates the next session.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { errorKind } from './log.js'

export interface HostTheme {
  background: string
  foreground: string
}

/** The desktop's stock palette (`graphite` in desktop/lib/shared/theme/color_palette.dart). */
export const DEFAULT_HOST_THEME: HostTheme = { background: '#181818', foreground: '#f5f5f5' }

const HEX = /^#[0-9a-f]{6}$/i

/** A well-formed theme or null — never a partial one, so `window-style` is always a full pair. */
export function parseHostTheme(value: unknown): HostTheme | null {
  if (!value || typeof value !== 'object') return null
  const { background, foreground } = value as Record<string, unknown>
  if (typeof background !== 'string' || typeof foreground !== 'string') return null
  if (!HEX.test(background) || !HEX.test(foreground)) return null
  return { background: background.toLowerCase(), foreground: foreground.toLowerCase() }
}

/** The `window-style` value for a theme: what `set-option -w window-style` takes. */
export function windowStyleOf(theme: HostTheme): string {
  return `bg=${theme.background},fg=${theme.foreground}`
}

const fileOf = () => join(env.ADAPTER_DATA_DIR, 'host-theme.json')

export function loadHostTheme(): HostTheme | null {
  try {
    return parseHostTheme(JSON.parse(readFileSync(fileOf(), 'utf8')))
  } catch {
    return null
  }
}

export function saveHostTheme(theme: HostTheme): void {
  try {
    mkdirSync(env.ADAPTER_DATA_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(fileOf(), JSON.stringify(theme, null, 2) + '\n', { mode: 0o600 })
  } catch (error) {
    console.warn(`[theme] could not persist host theme: ${errorKind(error)}`)
  }
}
