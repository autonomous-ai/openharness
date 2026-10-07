import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { composerState } from './composerScreen.js'

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')
const rule = (width = 100) => `\u001b[38;5;244m${'─'.repeat(width)}\u001b[39m`

/** Claude Code 2.1.289's prompt box: ruled above and below, `❯` and the prompt or a dim example. */
const claudeBox = (prompt: string, footer: string[] = ['  \u001b[2m? for shortcuts\u001b[0m'], width = 100, more: string[] = []) => [
  rule(width), `\u001b[39m❯ ${prompt}`, ...more, rule(width), ...footer,
].join('\n')
const CLAUDE_EMPTY = claudeBox('\u001b[2mTry "fix lint errors"\u001b[0m')

/** Codex 0.160's composer (snapshots `empty`, `draft_composer`): a blank row, bold `›` and the draft or
 *  the dim placeholder, a blank row, the footer. */
const codexComposer = (draft: string, footer = '  ? for shortcuts                                    100% context left', more: string[] = []) => [
  '', `\u001b[1m›\u001b[0m ${draft}`, ...more, '', footer,
].join('\n')
const CODEX_EMPTY = codexComposer('\u001b[2mAsk Codex to do anything\u001b[0m')

describe('Claude Code\'s prompt', () => {
  it('is ready empty, with a draft, a draft over several lines, or one in CJK and emoji', () => {
    expect(composerState('claude', CLAUDE_EMPTY)).toBe('ready')
    expect(composerState('claude', claudeBox('fix the login bug', ['']))).toBe('ready')
    expect(composerState('claude', claudeBox('first line', [''], 100, ['  second line', '  third line']))).toBe('ready')
    expect(composerState('claude', claudeBox('下一步：修复登录 🎉👩‍💻', ['']))).toBe('ready')
  })

  it('is ready while a turn runs, under its notices and in a narrow pane, its top rule carrying text', () => {
    // Typing is taken while a turn runs, and queued.
    expect(composerState('claude', `✶ Pondering… (12s · esc to interrupt)\n\n${CLAUDE_EMPTY}`)).toBe('ready')
    expect(composerState('claude', claudeBox('next', ['  ⏵⏵ accept edits on (shift+tab to cycle)', '  Starting MCP servers (1/3)…', '  Update available! Run: claude update']))).toBe('ready')
    expect(composerState('claude', claudeBox('\u001b[2mTry "fix"\u001b[0m', ['  ? for shortcuts'], 20))).toBe('ready')
    expect(composerState('claude', [`${'─'.repeat(40)} ↯ fast ${'─'.repeat(40)}`, '❯ next', '─'.repeat(88), ''].join('\n'))).toBe('ready')
    // Scrolled: the conversation's own `❯` lines above the box are not the box.
    expect(composerState('claude', `\u001b[48;5;237m❯ an earlier prompt\u001b[49m\n\n⏺ its answer\n\n${CLAUDE_EMPTY}`)).toBe('ready')
  })

  it('is ready with a draft taller than the pane, its top rule and `❯` row scrolled off', () => {
    // 2.1.289 caps the prompt's height only in its fullscreen renderer; inline, the box outgrows the pane.
    const rows = Array.from({ length: 20 }, (_, index) => `  line ${index + 2} of a long draft 下一步 🎉`)
    expect(composerState('claude', [...rows, rule(), ''].join('\n'))).toBe('ready')
    expect(composerState('claude', [...rows.slice(0, 18), '', '  /mo', rule(), '', '', '', '', '', '  /model          Set the AI model'].join('\n'))).toBe('popup')
    // Not a dialog's rows (indented by one column), nor the conversation's (at the edge).
    expect(composerState('claude', [' Bash command', '   printf hi', ' Do you want to proceed?', rule(), ''].join('\n'))).toBe('absent')
    expect(composerState('claude', ['⏺ the answer', '  more of it', rule(), ''].join('\n'))).toBe('absent')
    expect(composerState('claude', [rule(), ''].join('\n'))).toBe('absent')
  })

  it('has a popup open while a /command or an @mention is suggested under it, and only then', () => {
    expect(composerState('claude', claudeBox('/mo', ['', '', '', '', '', '  \u001b[38;5;153m/model          Set the AI model\u001b[39m']))).toBe('popup')
    expect(composerState('claude', claudeBox('look at @src/lo', ['', '', '', '', '', '  \u001b[38;5;153msrc/login.ts\u001b[39m']))).toBe('popup')
    expect(composerState('claude', claudeBox('@', ['', '', '', '  README.md', '  src/index.ts', '  src/login.ts']))).toBe('popup')
    // Nothing suggested, or put away with Esc: the footer is back.
    expect(composerState('claude', claudeBox('/mo', ['']))).toBe('ready')
    expect(composerState('claude', claudeBox('mail @bob', ['  ⏵⏵ accept edits on (shift+tab to cycle)']))).toBe('ready')
  })

  it('is absent when anything else is on screen: a dialog, a view, a screen never seen, or nothing yet', () => {
    expect(composerState('claude', fixture('permission-claude.txt'))).toBe('absent')
    expect(composerState('claude', fixture('question-single.txt'))).toBe('absent')
    // Its settings (/config): a dialog ruled at the top, its rows under a `❯`.
    expect(composerState('claude', [rule(), ' Settings:  Status  Config  Usage', '', ' ⌕ Search settings…', '', ' ❯ Auto-compact     true', '   Show tips        true', '', ' Enter/Space to change · Esc to close'].join('\n'))).toBe('absent')
    // A dialog drawn ruled under what was the box.
    expect(composerState('claude', `${CLAUDE_EMPTY}\n${rule()}\n Something new\n ❯ 1. Yes`)).toBe('absent')
    expect(composerState('claude', '')).toBe('absent')
    expect(composerState('claude', '✻ Welcome to Claude Code\n\n  /help for help')).toBe('absent')
    // A box with no bottom rule yet, half drawn.
    expect(composerState('claude', `${rule()}\n❯ next`)).toBe('absent')
  })
})

describe('Codex\'s composer', () => {
  it('is ready empty, with a draft, a draft over several lines, or one in CJK and emoji', () => {
    expect(composerState('codex', CODEX_EMPTY)).toBe('ready')
    expect(composerState('codex', codexComposer('Explore the night sky', '                                         100% context left'))).toBe('ready')
    expect(composerState('codex', codexComposer('first line', '  ? for shortcuts', ['  second line']))).toBe('ready')
    expect(composerState('codex', codexComposer('下一步：修复登录 🎉👩‍💻'))).toBe('ready')
    // At its top reasoning effort the glyph is `»`, still bold.
    expect(composerState('codex', ['', '\u001b[1;38;2;186;130;255m»\u001b[0m next', '', '  ? for shortcuts'].join('\n'))).toBe('ready')
  })

  it('is ready while a turn runs with messages queued, while MCP servers start, and in a narrow pane', () => {
    // Snapshot `status_and_queued_messages`.
    expect(composerState('codex', ['• Working (0s • esc to interrupt)', '', '• Queued follow-up inputs', '  ↳ Queued follow-up question',
      '    shift+← edit last queued message', CODEX_EMPTY].join('\n'))).toBe('ready')
    expect(composerState('codex', `• Starting MCP servers (0/2): docs, search\n${CODEX_EMPTY}`)).toBe('ready')
    expect(composerState('codex', codexComposer('\u001b[2mAsk Codex to do a\u001b[0m', '  ? for shortcuts'))).toBe('ready')
    // Find in its transcript keeps the composer, two footer rows under it.
    expect(composerState('codex', ['', '\u001b[1m›\u001b[0m /', '', '', '  Find: needle', '  Enter next · Esc close'].join('\n'))).toBe('ready')
  })

  it('has a popup open while its /command list or mention menu is drawn above it, and only then', () => {
    // Snapshot `slash_popup_footer_wide`.
    expect(composerState('codex', ['  /model     choose what model and reasoning effort to use', '\u001b[1;7m› /memories  configure memory use\u001b[0m',
      '  /mention   mention a file', '', '\u001b[1m›\u001b[0m /m', '', '  model · high · fast'].join('\n'))).toBe('popup')
    // Snapshot `default_unified_mention_popup`.
    expect(composerState('codex', ['  Mentions', '   All Results   Filesystem Only   Plugins', '  sa', '› Sample Plugin   Plugin with skills',
      '  enter/tab insert · esc close · ↑/↓ select · ←/→ filter', '', '\u001b[1m›\u001b[0m @sa', '', '   100% context left'].join('\n'))).toBe('popup')
    // The same drafts with nothing drawn above.
    expect(composerState('codex', codexComposer('/m'))).toBe('ready')
    expect(composerState('codex', codexComposer('ask @sa'))).toBe('ready')
  })

  it('does not mistake conversation text for a popup after suggestions were dismissed', () => {
    const commandExample = '  /model     choose what model and reasoning effort to use'
    expect(composerState('codex', `${commandExample}\n${codexComposer('/m')}`)).toBe('ready')
    // A path at the end of ordinary prose cannot open Codex's initial /command menu.
    expect(composerState('codex', `${commandExample}\n${codexComposer('look in /model')}`)).toBe('ready')
    const oldMenu = ['\u001b[1;7m› /model     choose what model\u001b[0m', '', '• The menu is closed.']
    expect(composerState('codex', [...oldMenu, codexComposer('/m')].join('\n'))).toBe('ready')
    const oldMention = ['  enter/tab insert · esc close · ↑/↓ select · ←/→ filter', '', '• The menu is closed.']
    expect(composerState('codex', [...oldMention, codexComposer('look at @src')].join('\n'))).toBe('ready')
  })

  it('is absent under its session picker, whose highlighted row is drawn two columns in', () => {
    // resume_picker/layout.rs renders the list at `list.x + 2`, the header and search one column in, a dim
    // rule over its footer; the selected row is `› ` in the selection style (resume_picker.rs
    // `selection_marker`), so never at the left edge, bold or not.
    expect(composerState('codex', [' \u001b[1mResume a previous session\u001b[0m', ' All   This folder', ' \u001b[2mType to search\u001b[0m',
      '  \u001b[1;7m› \u001b[0m\u001b[7m15m ago     Propose session picker redesign\u001b[0m', '    2h ago      Fix the login bug', '',
      `\u001b[2m${'─'.repeat(80)}\u001b[0m`, '  enter resume · esc new session'].join('\n'))).toBe('absent')
  })

  it('is absent when anything else is on screen: a picker, a screen never seen, a line of the conversation, or nothing yet', () => {
    // Its agent command center (snapshot `agents_overview_recent_sessions`): its highlighted row is indented.
    expect(composerState('codex', ['  Agent command center  Group: Project  g', '      Tasks          Status', '  › ○ Task 12      Inactive',
      '    ○ Task 11      Inactive', '', '  ? help  esc back  ↑/↓ move  enter open  n new'].join('\n'))).toBe('absent')
    // A picker's rows are numbered (picker_option.rs).
    expect(composerState('codex', ['  Update available', '', '\u001b[1;36m› 1. Update now\u001b[0m', '  2. Skip', '', '  enter continue'].join('\n'))).toBe('absent')
    // The conversation's own `›` line with its answer under it, the composer gone.
    expect(composerState('codex', ['', '\u001b[1m›\u001b[0m fix the bug', '', '• Fixed it.', '  Details one.', '  Details two.', '  Details three.',
      '  Would you like to run the following command?'].join('\n'))).toBe('absent')
    // Input disabled: the glyph is dim.
    expect(composerState('codex', ['', '\u001b[2m›\u001b[0m \u001b[2mInput disabled.\u001b[0m', '', '  ? for shortcuts'].join('\n'))).toBe('absent')
    // Shell mode: `!` in its place.
    expect(composerState('codex', ['', '\u001b[1;91m!\u001b[0m ls', '', '  ? for shortcuts'].join('\n'))).toBe('absent')
    // Not under a blank row.
    expect(composerState('codex', ['something', '\u001b[1m›\u001b[0m next', '', '  ? for shortcuts'].join('\n'))).toBe('absent')
    expect(composerState('codex', '')).toBe('absent')
  })
})
