import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isMessageHold, messageHold, messageHoldText, messageWithheldText, passingHold, type MessageHold } from './messageHold.js'
import {
  CLAUDE_PROMPT, CLAUDE_REWIND_CONFIRM, CLAUDE_REWIND_LIST, CODEX_BROWSING_FULLSCREEN, CODEX_BROWSING_SCROLLBACK, CODEX_PROMPT,
} from './__fixtures__/rewindPickers.js'
import * as TAKEOVER from './__fixtures__/takeoverScreens.js'

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')
const RULE = '─'.repeat(100)

/**
 * Claude Code's transcript view (ctrl+o), as 2.1.289 draws it: the conversation, its prompt hidden, and
 * a footer row under a dim rule: `Showing detailed transcript · ctrl+o to toggle · ctrl+e to show all`,
 * `verbose` on the right.
 */
const CLAUDE_TRANSCRIPT = [
  '\u001b[38;5;239m\u001b[48;5;237m❯ \u001b[38;5;231mfix the login bug\u001b[39m\u001b[49m',
  '',
  '\u001b[38;5;246m⏺\u001b[39m Fixed: the session cookie was never refreshed.',
  '',
  `\u001b[2m${RULE}\u001b[0m`,
  '  \u001b[2mShowing detailed transcript · ctrl+o to toggle · ctrl+e to show all\u001b[0m                     \u001b[2mverbose \u001b[0m',
].join('\n')

/**
 * Codex's model picker, as the runtime profile spec has it (runtimeProfileController.spec.ts): a menu
 * where Enter picks the highlighted model. One that the question reader also reads, as Claude Code's
 * menus with a numbered footer are, is held as a question, the way the app shows it.
 */
const CODEX_MODEL_MENU = 'Select Model and Effort\n› 1. gpt-5.6-sol (current)\n  2. gpt-5.6-terra'

describe('what a message is not typed into', () => {
  it('is a permission prompt, in Claude Code, Codex and every engine whose prompt the daemon reads', () => {
    for (const [engine, name] of [['claude', 'permission-claude.txt'], ['claude', 'permission-claude-edit.txt'], ['claude', 'permission-claude-plan.txt'],
      ['codex', 'permission-codex.txt'], ['commandcode', 'permission-commandcode.txt'], ['cursor', 'permission-cursor.txt']] as const) {
      expect(messageHold(engine, fixture(name)), name).toBe('permission_open')
    }
  })

  it('is a permission prompt whose rows wrapped in a narrow pane, read by its question alone', () => {
    // Ink wraps a long row onto a line of its own, which ends the run of numbered rows the prompt is
    // otherwise read by. Claude Code's edit, write and fetch prompts then went unseen, and the Enter
    // after the paste approved the edit.
    const edit = fixture('permission-claude-edit.txt').replace('Yes, allow all edits during this session ', 'Yes, allow all edits during this\n      session ')
    expect(edit).not.toBe(fixture('permission-claude-edit.txt'))
    expect(messageHold('claude', edit)).toBe('permission_open')
    const fetch = [
      '\u001b[38;5;239m❯ \u001b[38;5;231msummarise https://example.com\u001b[39m',
      '',
      '⏺ Fetch(https://example.com)',
      RULE,
      ' Fetch',
      '   https://example.com',
      ' Do you want to allow Claude to fetch this content?',
      ' ❯ 1. Yes',
      '   2. Yes, and don\u2019t ask again for',
      '      example.com',
      '   3. No, and tell Claude what to do differently',
      '      (esc)',
    ].join('\n')
    expect(messageHold('claude', fetch)).toBe('permission_open')
    const plan = fixture('permission-claude-plan.txt')
    expect(messageHold('claude', plan)).toBe('permission_open')
  })

  it('is not a numbered list in the output of a turn at work, over its spinner', () => {
    const working = [
      '❯ tidy up the release script',
      '',
      '⏺ Here is the plan:',
      '  1. Run the existing tests first',
      '  2. Rename the helper',
      '  3. Stop publishing the debug build',
      '',
      '✻ Pondering… (12s · ↓ 1.2k tokens · esc to interrupt)',
      '',
      RULE, '❯ ', RULE, '  ? for shortcuts',
    ].join('\n')
    expect(messageHold('claude', working)).toBeNull()
    const codex = ['› tidy up the release script', '', '• Plan:', '  1. Run the existing tests first', '  2. Stop publishing the debug build', '', '◦ Working (5s • esc to interrupt)', '', '\u001b[1m›\u001b[0m ', '', '  ? for shortcuts'].join('\n')
    expect(messageHold('codex', codex)).toBeNull()
  })

  it('is not a draft or an echo that asks a question of its own', () => {
    expect(messageHold('claude', CLAUDE_PROMPT.replace('Try "fix lint errors"', 'Do you want to add tests? Would you like to proceed?'))).toBeNull()
    const answered = [
      '❯ Do you want to rename the module?',
      '',
      '⏺ Renamed it. Do you want to run the tests too?',
      RULE,
      '❯ ',
      RULE,
      '  ? for shortcuts',
    ].join('\n')
    expect(messageHold('claude', answered)).toBeNull()
  })

  it('is a question, which is answered through its own path', () => {
    for (const [engine, name] of [['claude', 'question-single.txt'], ['claude', 'question-multi.txt'], ['codex', 'question-codex.txt']] as const) {
      expect(messageHold(engine, fixture(name)), name).toBe('question_open')
    }
  })

  it('is, in Claude Code and Codex, a menu, a picker for a point to rewind to, or Claude Code\'s transcript view', () => {
    expect(messageHold('codex', CODEX_MODEL_MENU)).toBe('menu_open')
    expect(messageHold('claude', CLAUDE_REWIND_LIST)).toBe('rewind_picker_open')
    // In a pane narrower than its body line, which wraps.
    const narrow = CLAUDE_REWIND_LIST.replace(' Restore the code and/or conversation to the point before', ' Restore the code and/or conversation to\n the point before')
    expect(narrow).not.toBe(CLAUDE_REWIND_LIST)
    expect(messageHold('claude', narrow)).toBe('rewind_picker_open')
    expect(messageHold('claude', CLAUDE_REWIND_CONFIRM)).toBe('rewind_picker_open')
    expect(messageHold('codex', CODEX_BROWSING_FULLSCREEN)).toBe('rewind_picker_open')
    expect(messageHold('codex', CODEX_BROWSING_SCROLLBACK)).toBe('rewind_picker_open')
    expect(messageHold('claude', CLAUDE_TRANSCRIPT)).toBe('transcript_open')
    // With a dialog waiting behind it, and the footer cut short by a narrow pane.
    expect(messageHold('claude', CLAUDE_TRANSCRIPT.replace('Showing detailed', 'dialog waiting · Showing detailed'))).toBe('transcript_open')
    expect(messageHold('claude', CLAUDE_TRANSCRIPT.replace(/Showing detailed transcript ·.*/, 'Showing detailed transcript · ctrl+o to tog…'))).toBe('transcript_open')
  })

  it('is not a ready composer, a turn at work, an unreadable pane, or the MCP boot notice, which takes typing', () => {
    expect(messageHold('claude', CLAUDE_PROMPT)).toBeNull()
    expect(messageHold('codex', CODEX_PROMPT)).toBeNull()
    expect(messageHold('claude', `✶ Thinking… (esc to interrupt)\n${CLAUDE_PROMPT}`)).toBeNull()
    expect(messageHold('claude', `${CLAUDE_PROMPT}\n  Starting MCP servers (1/3)…`)).toBeNull()
    // The conversation's own words are not the view's footer, nor a menu.
    expect(messageHold('claude', `⏺ Showing detailed transcript is what ctrl+o does.\n${CLAUDE_PROMPT}`)).toBeNull()
    // Another engine's screen is read only for its prompts: a menu or a view it may draw is its own.
    expect(messageHold('cursor', CODEX_MODEL_MENU)).toBeNull()
    expect(messageHold('cursor', CLAUDE_TRANSCRIPT)).toBeNull()
  })
})

describe('the engines\' own screens that take the composer\'s place', () => {
  it('holds a message back from each one, where its Enter would do something else or it would be lost', () => {
    const expected: Record<keyof typeof TAKEOVER, MessageHold> = {
      CODEX_UPDATE_PROMPT: 'update_prompt_open',
      CODEX_TRUST_PROMPT: 'trust_open',
      CODEX_TRUST_PROMPT_0147: 'trust_open',
      CODEX_MODEL_MIGRATION: 'model_prompt_open',
      CODEX_SIGN_IN: 'sign_in_open',
      CODEX_HISTORY_SEARCH: 'search_open',
      CODEX_TRANSCRIPT_FIND: 'search_open',
      CODEX_TRANSCRIPT_OVERLAY: 'transcript_open',
      CLAUDE_HISTORY_SEARCH: 'search_open',
      CLAUDE_HISTORY_SEARCH_NO_MATCH: 'search_open',
      CLAUDE_TRUST_PROMPT: 'trust_open',
      CLAUDE_SIGN_IN: 'sign_in_open',
    }
    for (const [name, hold] of Object.entries(expected)) {
      const engine = name.startsWith('CLAUDE') ? 'claude' : 'codex'
      expect(messageHold(engine, TAKEOVER[name as keyof typeof TAKEOVER]), name).toBe(hold)
    }
  })

  it('is not fooled by their words in the conversation, above a ready composer', () => {
    // The conversation can say anything; the screens are matched on their own rows and footers.
    // (The pager's header counts only as the top row of the screen, which is the pager's own.)
    const said = [
      '• Its transcript pager has this header:',
      '/ T R A N S C R I P T',
      '  reverse-i-search: is what ctrl+r shows',
      'Find: the cookie bug',
      '  Update available · 0.160.0 → 0.161.0',
      '› 1. Update now (runs `npm install -g @openai/codex`)',
      '  Trust this folder? Codex can read, edit, and run files here, it said.',
      '› 1. Try new model',
      '› 1. Sign in with ChatGPT',
    ].join('\n')
    expect(messageHold('codex', `${said}\n\n${CODEX_PROMPT}`)).toBeNull()
    const claudeSaid = [
      '⏺ search prompts: is what ctrl+r shows',
      '  Quick safety check: Is this a project you created or one you trust?',
      '  Select login method:',
    ].join('\n')
    expect(messageHold('claude', `${claudeSaid}\n${CLAUDE_PROMPT}`)).toBeNull()
    // A startup question answered, the composer below it, is no longer open.
    expect(messageHold('codex', `${TAKEOVER.CODEX_TRUST_PROMPT}\n\n${CODEX_PROMPT}`)).toBeNull()
    expect(messageHold('codex', `${TAKEOVER.CODEX_UPDATE_PROMPT}\n\n${CODEX_PROMPT}`)).toBeNull()
    expect(messageHold('claude', `${TAKEOVER.CLAUDE_TRUST_PROMPT}\n${CLAUDE_PROMPT}`)).toBeNull()
    expect(messageHold('claude', `${TAKEOVER.CLAUDE_SIGN_IN}\n${CLAUDE_PROMPT}`)).toBeNull()
    // Another engine's pane is not read for them.
    expect(messageHold('cursor', TAKEOVER.CODEX_UPDATE_PROMPT)).toBeNull()
    expect(messageHold('cursor', TAKEOVER.CLAUDE_HISTORY_SEARCH)).toBeNull()
  })
})

describe('anything but the engine\'s own composer, for Claude Code and Codex', () => {
  it('is refused: a screen never seen, a popup over the composer, a pane not drawn yet or not read', () => {
    // Claude Code's settings (/config), which the daemon has no name for.
    expect(messageHold('claude', `${'─'.repeat(80)}\n Settings:  Status  Config  Usage\n\n ⌕ Search settings…\n\n ❯ Auto-compact   true\n\n Enter/Space to change · Esc to close`)).toBe('prompt_hidden')
    // Codex's agent command center.
    expect(messageHold('codex', '  Agent command center\n  › ○ Task 12      Inactive\n    ○ Task 11      Inactive\n\n  ? help  esc back  ↑/↓ move  enter open')).toBe('prompt_hidden')
    expect(messageHold('codex', ['  /model     choose what model', '\u001b[1;7m› /memories  configure memory\u001b[0m', '', '\u001b[1m›\u001b[0m /m', '', '  ? for shortcuts'].join('\n'))).toBe('popup_open')
    expect(messageHold('claude', '')).toBe('prompt_hidden')
    expect(messageHold('claude', null)).toBe('screen_unreadable')
    expect(messageHold('codex', null)).toBe('screen_unreadable')
    // Another engine is read for its prompts only: an unknown screen or an unread pane is typed into as before.
    expect(messageHold('cursor', '')).toBeNull()
    expect(messageHold('cursor', null)).toBeNull()
  })

  it('waits a little for the passing ones, an engine starting or a pane read once in vain, before refusing', () => {
    expect(['prompt_hidden', 'screen_unreadable'].every(passingHold)).toBe(true)
    expect(['permission_open', 'popup_open', 'menu_open', 'team_waiting_user'].some(passingHold)).toBe(false)
  })
})

describe('what the person is told', () => {
  const holds: MessageHold[] = ['permission_open', 'question_open', 'menu_open', 'rewind_picker_open', 'transcript_open',
    'search_open', 'trust_open', 'update_prompt_open', 'model_prompt_open', 'sign_in_open', 'popup_open', 'prompt_hidden', 'screen_unreadable']

  it('names the engine, what is open, and exactly what lets the message through', () => {
    expect(holds.map((hold) => messageHoldText('claude', hold))).toEqual([
      'Claude Code is asking for permission. Answer it first, in the app or in its terminal, then send the message again.',
      'Claude Code is asking you a question. Answer it first, in the app or in its terminal, then send the message again.',
      'Claude Code has a menu open, where Enter would pick from it. Close it with Esc in its terminal, then send the message again.',
      'Claude Code has its Rewind menu open, where Enter would pick a point to rewind to. Close it with Esc in its terminal, then send the message again.',
      'Claude Code is showing its transcript (ctrl+o), where a message is not typed. Close it with Esc in its terminal, then send the message again.',
      'Claude Code is searching its prompt history (ctrl+r), where Enter would send an earlier prompt. Close it with ctrl+c in its terminal, then send the message again.',
      'Claude Code is asking whether to trust this folder. Answer it in its terminal, then send the message again.',
      'Claude Code is asking whether to update. Answer it in its terminal, then send the message again.',
      'Claude Code is asking whether to switch to a new model. Answer it in its terminal, then send the message again.',
      'Claude Code is asking how to sign in. Sign in in its terminal, then send the message again.',
      'Claude Code has a list of suggestions open in its prompt, where Enter would pick one. Close it with Esc in its terminal, then send the message again.',
      'Claude Code isn\'t showing its prompt; finish what\'s on its screen in its terminal, then send the message again.',
      'Claude Code\'s screen could not be read, so the message was not typed. Send it again in a moment.',
    ])
    expect(messageHoldText('codex', 'prompt_hidden')).toBe('Codex isn\'t showing its prompt; finish what\'s on its screen in its terminal, then send the message again.')
    expect(messageHoldText('codex', 'transcript_open')).toBe('Codex is showing its transcript (ctrl+t), where a message is not typed. Close it with q in its terminal, then send the message again.')
    expect(messageHoldText('codex', 'search_open')).toBe('Codex has a search open, where a message would become what it searches for. Close it with Esc in its terminal, then send the message again.')
    expect(messageHoldText('codex', 'update_prompt_open')).toBe('Codex is asking whether to update. Answer it in its terminal, then send the message again.')
    expect(messageHoldText('codex', 'permission_open')).toBe('Codex is asking for approval. Answer it first, in the app or in its terminal, then send the message again.')
    expect(messageHoldText('codex', 'rewind_picker_open')).toBe('Codex is browsing its transcript, where Enter would rewind the conversation. Close it with Esc in its terminal, then send the message again.')
    expect(messageHoldText('commandcode', 'permission_open')).toBe('Command Code is asking for permission. Answer it first, in the app or in its terminal, then send the message again.')
  })

  it('tells a hold from any other refusal', () => {
    for (const hold of holds) expect(isMessageHold(hold)).toBe(true)
    expect(isMessageHold('team_waiting_user')).toBe(false)
    expect(isMessageHold('terminal agent is unavailable')).toBe(false)
  })
})

describe('what the person is told when their message was typed and its Enter withheld', () => {
  it('says what opened, that the message waits unsent in the prompt, and what sends or clears it', () => {
    expect(messageWithheldText('codex', 'question_open')).toBe('Codex asked you a question just as your message was typed, so it was not sent; it waits in Codex\'s prompt. Answer the question in the app or in its terminal, then press Enter in its terminal to send the message, or clear it there.')
    expect(messageWithheldText('claude', 'prompt_hidden')).toBe('Claude Code opened another screen just as your message was typed, so it was not sent; it waits in Claude Code\'s prompt. Finish what\'s on its screen in its terminal, then press Enter in its terminal to send the message, or clear it there.')
  })
})
