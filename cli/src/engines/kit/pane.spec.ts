import { afterEach, describe, expect, it } from 'vitest'
import { composerState } from '../claude/composer.js'
import { inspectPane } from './pane.js'
import { teamHold } from './screen.js'

const rule = '─'.repeat(60)
const footer = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
/** Claude Code's composer between its two rules, as read from DESKTOP-0TFH0OJ on 2026-10-23: in the Harness terminal on
 *  Windows it draws `>` and a no-break space where it draws `❯` elsewhere. */
const claudeScreen = (marker: string, draft = '') => ['✻ Crunched for 4m 6s · done 12:33 AM', '', rule,
  `${marker}\u00a0${draft}`.padEnd(60), rule, footer, ''].join('\n')

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const on = (name: NodeJS.Platform) => Object.defineProperty(process, 'platform', { ...platform, value: name })
afterEach(() => { Object.defineProperty(process, 'platform', platform) })

const read = (capture: string) => ({ pane: inspectPane('claude', capture), hold: teamHold('claude', capture, inspectPane('claude', capture), null) })

describe("Claude Code's composer on Windows", () => {
  // With the `>` unread, the pane never read idle, and the Flutter assignment for DESKTOP setup was held from 07:42 UTC.
  it('reads `>` inside the composer frame as its prompt: idle when empty, a draft when typed into', () => {
    on('win32')
    expect(read(claudeScreen('>'))).toEqual({ pane: { idle: true, plan: false, dialog: false, draft: false }, hold: null })
    expect(read(claudeScreen('>', 'install flutter'))).toMatchObject({ pane: { idle: false, draft: true }, hold: 'team_waiting_draft' })
  })

  // The resent assignment (08:27 UTC) then reached the pane and was refused as `prompt_hidden`: the composer reader looked
  // for `❯` alone too.
  it('finds the composer there, so input is typed into it', () => {
    on('win32')
    expect(composerState(claudeScreen('>'))).toBe('ready')
    expect(composerState(claudeScreen('>', '/mo'))).toBe('ready')
    on('darwin')
    expect(composerState(claudeScreen('>'))).toBe('absent')
  })

  it('never reads a shell prompt or a `>` in the transcript as an idle Claude Code', () => {
    on('win32')
    const shell = ['Windows PowerShell', '', 'PS C:\\Users\\DELL> ', ''].join('\n')
    expect(read(shell)).toMatchObject({ pane: { idle: false }, hold: 'team_waiting_idle' })
    const quoted = ['⏺ The log says:', rule, '> rename observers.json.next -> observers.json', 'EPERM', '', '✻ Working… (esc to interrupt)', ''].join('\n')
    expect(read(quoted)).toMatchObject({ pane: { idle: false }, hold: 'team_waiting_idle' })
  })

  // Review of #1649: a framed `>` in output (a quoted screen) above more output is not the input box. Only the last box,
  // with nothing under it but Claude Code's indented footer, is.
  it('reads only the bottom box with its footer as the composer, never a framed `>` in output', () => {
    on('win32')
    const quoted = ['⏺ The pane showed:', rule, '>\u00a0', rule, '⏺ and then it stopped.', ''].join('\n')
    expect(read(quoted)).toMatchObject({ pane: { idle: false }, hold: 'team_waiting_idle' })
    expect(composerState(quoted)).not.toBe('ready')
    const shellAfter = ['⏺ Done.', rule, '>\u00a0', rule, '  ⏵⏵ bypass permissions on (shift+tab to cycle)', 'PS C:\\Users\\DELL> ', ''].join('\n')
    expect(read(shellAfter)).toMatchObject({ pane: { idle: false } })
    expect(composerState(shellAfter)).not.toBe('ready')
    // Re-review: indented output under a framed quote is not a footer; only Claude Code's own footer rows are.
    const indentedAfter = ['⏺ The pane showed:', rule, '>\u00a0', rule, '  continued output', '  - and a list item', ''].join('\n')
    expect(read(indentedAfter)).toMatchObject({ pane: { idle: false }, hold: 'team_waiting_idle' })
    expect(composerState(indentedAfter)).not.toBe('ready')
    const defaultMode = [rule, '>\u00a0', rule, '  ? for shortcuts', ''].join('\n')
    expect(read(defaultMode)).toEqual({ pane: { idle: true, plan: false, dialog: false, draft: false }, hold: null })
    expect(composerState(defaultMode)).toBe('ready')
  })

  // DESKTOP-0TFH0OJ, 2026-10-26: in a 42-column pane Claude Code cut its footer at the edge, the composer read as absent, and
  // each Swarm message was typed but its Enter held as `prompt_hidden`. Read through the pty host, as the daemon reads it.
  it('finds the composer of a narrow pane, whose footer Claude Code cut at the edge', () => {
    on('win32')
    const narrow = (draft: string, footerRow: string) => ['✻ Brewed for 2s · done Thursday 9:07 PM', '', '─'.repeat(42),
      `> ${draft}`, '─'.repeat(42), footerRow, '  × Auto-update failed: claude.exe in u…', ''].join('\n')
    for (const cut of ['  ⏵⏵ bypass permissions on (shift+tab to', '  ⏵⏵ bypass permi…', '  ⏸ plan mode on (shift…', '  ? for shortc…']) {
      expect(composerState(narrow('', cut))).toBe('ready')
      expect(composerState(narrow('[Pasted text #3 +10 lines]', cut))).toBe('ready')
      expect(read(narrow('', cut)).hold).toBeNull()
    }
    // Indented output under a framed quote is still no footer.
    expect(composerState(narrow('', '  continued output'))).not.toBe('ready')
  })

  it('reads Mac and Linux screens as before', () => {
    on('darwin')
    expect(read(claudeScreen('>'))).toMatchObject({ pane: { idle: false }, hold: 'team_waiting_idle' })
    expect(read(claudeScreen('❯'))).toEqual({ pane: { idle: true, plan: false, dialog: false, draft: false }, hold: null })
    on('win32')
    expect(read(claudeScreen('❯'))).toEqual({ pane: { idle: true, plan: false, dialog: false, draft: false }, hold: null })
  })
})
