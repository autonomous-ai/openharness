/**
 * The pickers for a point to rewind the conversation to, as the engines draw them in a tmux pane. Built
 * from the engines' own code, read only: Claude Code 2.1.289's bundled MessageSelector (its Dialog pane:
 * a blank row, a rule in the dialog's colour, the bold title, then the body a blank row below it, padded
 * one column; its list rows: the `❯` pointer on the focused row, one column, then the row), and Codex
 * 0.160's tui/src (app_backtrack/prompt_navigation.rs for the footer, bottom_pane for the dimmed
 * composer, pager_overlay/transcript.rs for the scrollback pager). Not captures: the engines were not
 * run, so colours are the ones their code names, in tmux's 256-colour spelling.
 */

const RULE = '─'.repeat(100)
const dot = '\u001b[2m · \u001b[0m'

/** Claude Code with its Rewind menu just opened: earlier messages listed, `(current)` focused. */
export const CLAUDE_REWIND_LIST = [
  '\u001b[38;5;239m\u001b[48;5;237m❯ \u001b[38;5;231mfix the login bug\u001b[39m\u001b[49m',
  '',
  '\u001b[38;5;246m⏺\u001b[39m Fixed: the session cookie was never refreshed.',
  '',
  `\u001b[38;5;153m${RULE}\u001b[39m`,
  ' \u001b[1m\u001b[38;5;153mRewind\u001b[0m',
  '',
  ' Restore the code and/or conversation to the point before…',
  '',
  '   fix the login bug',
  '   \u001b[38;5;246mauth.ts \u001b[32m+4\u001b[39m \u001b[31m-1\u001b[39m\u001b[39m',
  '',
  ' \u001b[38;5;153m❯\u001b[39m \u001b[3m\u001b[38;5;153m(current)\u001b[0m',
  '',
  '',
  ' \u001b[2m\u001b[3mEnter to continue · Esc to cancel\u001b[0m',
].join('\n')

/** The same menu with an earlier message focused, Enter away from the confirmation. */
export const CLAUDE_REWIND_LIST_MESSAGE_FOCUSED = CLAUDE_REWIND_LIST
  .replace('   fix the login bug', ' \u001b[38;5;153m❯\u001b[39m \u001b[38;5;153mfix the login bug\u001b[39m')
  .replace(' \u001b[38;5;153m❯\u001b[39m \u001b[3m\u001b[38;5;153m(current)\u001b[0m', '   \u001b[3m(current)\u001b[0m')

/** A message picked: Enter on the focused option restores the conversation to before it. */
export const CLAUDE_REWIND_CONFIRM = [
  '\u001b[38;5;239m\u001b[48;5;237m❯ \u001b[38;5;231mfix the login bug\u001b[39m\u001b[49m',
  '',
  `\u001b[38;5;153m${RULE}\u001b[39m`,
  ' \u001b[1m\u001b[38;5;153mRewind\u001b[0m',
  '',
  ' Confirm you want to restore to the point before you sent this message:',
  ' \u001b[2m│\u001b[0m fix the login bug',
  ' \u001b[2m│\u001b[0m \u001b[2m(2m ago)\u001b[0m',
  ' \u001b[2mThe conversation will be forked.\u001b[0m',
  ' \u001b[2mThe code will be restored \u001b[32m+4\u001b[39m \u001b[31m-1\u001b[39m in auth.ts.\u001b[0m',
  ' \u001b[38;5;153m❯\u001b[39m \u001b[2m1.\u001b[0m \u001b[38;5;153mRestore code and conversation\u001b[39m',
  '   \u001b[2m2.\u001b[0m Restore conversation',
  '   \u001b[2m3.\u001b[0m Restore code',
  '   \u001b[2m4.\u001b[0m Summarize from here',
  '   \u001b[2m5.\u001b[0m Summarize up to here',
  '   \u001b[2m6.\u001b[0m Never mind',
  '',
  ' \u001b[2m⚠ Rewinding does not affect files edited manually or via bash.\u001b[0m',
].join('\n')

/** The menu opened before anything was sent. */
export const CLAUDE_REWIND_EMPTY = [
  `\u001b[38;5;153m${RULE}\u001b[39m`,
  ' \u001b[1m\u001b[38;5;153mRewind\u001b[0m',
  '',
  ' \u001b[2mNothing to rewind to yet.\u001b[0m',
  '',
  ' \u001b[2m\u001b[3mEsc to cancel\u001b[0m',
].join('\n')

/** Claude Code's empty prompt, between its two rules, footer below. */
export const CLAUDE_PROMPT = [
  `\u001b[38;5;244m${RULE}\u001b[39m`,
  '\u001b[39m❯ \u001b[2mTry "fix lint errors"\u001b[0m',
  `\u001b[38;5;244m${RULE}\u001b[39m`,
  '  \u001b[2m? for shortcuts\u001b[0m',
].join('\n')

/** Codex's transcript browser footer, at full width. */
export const CODEX_BROWSING_FOOTER = `\u001b[36mBrowsing transcript\u001b[0m${dot}↑↓/jk\u001b[2m scroll\u001b[0m${dot}←→/hl\u001b[2m prompts\u001b[0m${dot}ctrl + t\u001b[2m details\u001b[0m${dot}↵\u001b[2m rewind\u001b[0m${dot}esc\u001b[2m back\u001b[0m`

/** Codex browsing in its default fullscreen mode: the composer stays, dimmed whole, over the footer. */
export const CODEX_BROWSING_FULLSCREEN = [
  '\u001b[1m›\u001b[0m fix the login bug',
  '',
  '\u001b[2m•\u001b[0m Fixed: the session cookie was never refreshed.',
  '',
  '\u001b[2m\u001b[1m›\u001b[0m\u001b[2m \u001b[2mAsk Codex to do anything\u001b[0m',
  '',
  CODEX_BROWSING_FOOTER,
].join('\n')

/** Codex browsing in its scrollback mode: a transcript pager over the whole pane, its footer last. */
export const CODEX_BROWSING_SCROLLBACK = [
  `\u001b[2m/ T R A N S C R I P T ${'/ '.repeat(39)}\u001b[0m`,
  '\u001b[7m\u001b[1m›\u001b[0m\u001b[7m fix the login bug\u001b[0m',
  '',
  '\u001b[2m•\u001b[0m Fixed: the session cookie was never refreshed.',
  '',
  '',
  CODEX_BROWSING_FOOTER,
].join('\n')

/** Codex's empty composer with its status line under it. */
export const CODEX_PROMPT = '\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m\n\n  gpt-5.6-sol default · /tmp/project'
