/**
 * Hermes's own sign, on its pane, that it took words typed into it (#4393). Hermes 0.21 writes a new conversation's
 * first message to its store only once its agent is initialized: 46 s after the paste on a loaded Mac (2026-11-17),
 * long after the submit check gives up. Its pane says so at once: the words leave the composer, Hermes prints them
 * under a 40-wide rule as `● <words>` (hermes_cli/cli_stream_mixin.py `_print_user_message_preview`), and its composer
 * shows the running turn's hint (`msg=interrupt`).
 */
import { composerHolds, visibleTerminal } from '../kit/submission.js'

const SUBMITTED_RULE = /^─{40}\s*$/u
/** The composer while a turn runs: its placeholder names what typing does then. */
const RUNNING = /❯\s*msg=interrupt\b/u
const compact = (text: string): string => text.replace(/\s+/g, '')

/**
 * Whether [capture] shows Hermes took [content]: its turn running, the words out of its composer, and the last message
 * it echoed beginning with their first line (an echo the pane wrapped is read whole; a timestamp may follow it).
 */
export function hermesTookPrompt(capture: string, content: string): boolean {
  const first = compact(content.split('\n').find((line) => line.trim()) ?? '')
  if (!first) return false
  const lines = visibleTerminal(capture).split('\n')
  if (!lines.slice(-8).some((line) => RUNNING.test(line)) || composerHolds(capture, content)) return false
  const at = lines.findLastIndex((line, index) => index > 0 && line.startsWith('● ') && SUBMITTED_RULE.test(lines[index - 1]!))
  if (at < 0) return false
  let echo = lines[at]!.slice(2)
  for (const line of lines.slice(at + 1)) {
    if (!line.trim() || /^[─╭☤]|^\s*☤|^Initializing agent/u.test(line)) break
    echo += line
  }
  return compact(echo).startsWith(first)
}
