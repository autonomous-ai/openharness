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

  it('reads Mac and Linux screens as before', () => {
    on('darwin')
    expect(read(claudeScreen('>'))).toMatchObject({ pane: { idle: false }, hold: 'team_waiting_idle' })
    expect(read(claudeScreen('❯'))).toEqual({ pane: { idle: true, plan: false, dialog: false, draft: false }, hold: null })
    on('win32')
    expect(read(claudeScreen('❯'))).toEqual({ pane: { idle: true, plan: false, dialog: false, draft: false }, hold: null })
  })
})
