import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { composerState } from './composer.js'
import { screen } from './screen.js'

/**
 * Task #2428 (reported 11-03): a person renamed their Buddy's Claude Code session with Claude Code's own `/rename`, and
 * from then on no chat message reached it, while typing in its terminal still worked. Claude Code then sets the session's
 * name in its prompt box's top rule, the name and one `─` after it. These are real panes of Claude Code 2.1.317 after
 * `/rename my-renamed-buddy`, read with tmux at 120 and 60 columns.
 */
const fixture = (width: number) => readFileSync(new URL(`./__fixtures__/renamed-session-2.1.317-${width}.txt`, import.meta.url), 'utf8')
const renamed = [fixture(120), fixture(60)]

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const on = (name: NodeJS.Platform) => Object.defineProperty(process, 'platform', { ...platform, value: name })
afterEach(() => { Object.defineProperty(process, 'platform', platform) })

/** [capture] with [draft] typed after its last `❯`. */
const typed = (capture: string, draft: string) => {
  const lines = capture.split('\n')
  const at = lines.findLastIndex(line => line.startsWith('❯'))
  lines[at] = `❯ ${draft}`
  return lines.join('\n')
}

describe('a Claude Code session renamed with /rename', () => {
  it('the captures show the titled rule this reads', () => {
    for (const capture of renamed) expect(capture).toMatch(/^─{3,} my-renamed-buddy ─$/m)
  })

  it('takes a Swarm message: its prompt box is found, nothing holds the delivery', () => {
    for (const capture of renamed) {
      expect(composerState(capture)).toBe('ready')
      expect(screen.inspect(capture)).toMatchObject({ messageHold: null, teamHold: null, question: null })
    }
  })

  it('still sees what the person typed there as a draft, and a slash popup as a popup', () => {
    for (const capture of renamed) {
      expect(composerState(typed(capture, 'half a thought'))).toBe('ready')
      expect(screen.inspect(typed(capture, 'half a thought')).teamHold).toBe('team_waiting_draft')
      const popup = typed(capture, '/mo').replace(/\n  ⏵⏵ auto mode on.*$/m, '\n  /model   Set the AI model for Claude Code')
      expect(composerState(popup)).toBe('popup')
    }
  })

  it('reads a dialog Claude Code draws ruled under the renamed box as no prompt', () => {
    for (const capture of renamed) {
      const dialog = capture.replace(/\n  ⏵⏵ auto mode on.*$/m, `\n${'─'.repeat(40)}\n Do you want to proceed?\n ❯ 1. Yes\n   2. No`)
      expect(composerState(dialog)).toBe('absent')
    }
  })

  // The takeover reader found the prompt only under a plain rule; under the titled one it looked for a dialog anywhere on
  // the screen, so the trust question's words quoted in the transcript above read as the trust dialog open.
  it('never reads the trust question quoted above the renamed box as a dialog in front of it', () => {
    const quoted = ['⏺ The first screen asked:', '  Quick safety check: Is this a project you created or one you trust?',
      '  ❯ No, exit', '  Yes, I trust this folder', '']
    for (const capture of renamed) {
      const at = capture.indexOf('❯ /rename')
      const shown = capture.slice(0, at) + quoted.join('\n') + capture.slice(at)
      expect(screen.inspect(shown)).toMatchObject({ messageHold: null })
    }
  })

  // Claude Code draws `>` for its marker in the Harness terminal on Windows (kit/pane.ts `claudeWindowsComposer`).
  it('on Windows, finds the `>` composer under the titled rule too', () => {
    on('win32')
    for (const capture of renamed) {
      const windows = capture.replace(/^❯ $/m, '> ')
      expect(composerState(windows)).toBe('ready')
      expect(screen.inspect(windows)).toMatchObject({ messageHold: null, teamHold: null })
    }
  })
})
