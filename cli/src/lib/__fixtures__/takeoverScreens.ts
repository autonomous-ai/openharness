/**
 * Screens that take the composer's place in Claude Code 2.1.289 and Codex 0.160, where a pasted message
 * and its Enter do something other than send it. Built from the engines' own code, read only: Codex's
 * insta snapshots and render code at rust-v0.160.0 (the text and layout are theirs), Claude Code's
 * bundled components (its Dialog pane: a rule in the dialog's colour, the bold title, the body, the dim
 * italic key hints; its Select rows: `❯` on the highlighted row). Not captures: the engines were not run.
 */

const RULE = '─'.repeat(100)

/** Codex at startup with a newer release out (update_prompt.rs, snapshot `update_prompt_modal`). Enter
 *  runs the update: its own test `update_prompt_confirm_selects_update`. A paste is ignored. */
export const CODEX_UPDATE_PROMPT = [
  '',
  '  \u001b[1mUpdate available\u001b[0m\u001b[2m · \u001b[0m0.160.0 → 0.161.0',
  '  \u001b[2mRelease notes: \u001b[0mhttps://github.com/openai/codex/releases/latest',
  '',
  '\u001b[36m› 1. Update now (runs `npm install -g @openai/codex`)\u001b[39m',
  '  2. Skip',
  '  3. Skip until next version',
  '',
  '  enter\u001b[2m continue · \u001b[0mesc\u001b[2m skip\u001b[0m',
].join('\n')

/** Codex asked to trust the folder it starts in (onboarding/trust_directory.rs). `Trust and continue` is
 *  highlighted, Enter saves the trust; a paste is ignored. */
export const CODEX_TRUST_PROMPT = [
  '> You are in \u001b[1m/tmp/project\u001b[0m',
  '',
  '  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.',
  '  Folder settings can run code automatically, even without a model request. Continue only if you',
  '  trust these files. Your trust decision will be saved.',
  '',
  '\u001b[36m› 1. Trust and continue\u001b[39m',
  '  2. Quit',
  '',
  '  enter\u001b[2m continue · \u001b[0mesc\u001b[2m quit\u001b[0m',
].join('\n')

/** The same question as 0.147 words it, captured live (`permission-codex.txt`). */
export const CODEX_TRUST_PROMPT_0147 = [
  '> \u001b[1mYou are in \u001b[0m/tmp/project',
  '',
  '  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.',
  '',
  '\u001b[38;5;6m› 1. Yes, continue\u001b[39m',
  '  2. No, quit',
  '',
  '  \u001b[2mPress enter to continue\u001b[0m',
].join('\n')

/** Codex offering a newer model at startup (model_migration.rs, snapshot `model_migration_prompt`).
 *  Enter, and Esc too, confirm the highlighted row, `Try new model`; a paste is ignored. */
export const CODEX_MODEL_MIGRATION = [
  '',
  '  \u001b[1mCodex just got an upgrade. Introducing\u001b[0m',
  '  \u001b[1mgpt-5.1-codex-max.\u001b[0m',
  '',
  '  Upgrade to gpt-5.2-codex for the latest and greatest',
  '  agentic coding model.',
  '',
  '  You can continue using gpt-5.1-codex-mini if you prefer.',
  '',
  '\u001b[36m› 1. Try new model\u001b[39m',
  '  2. Use existing model',
  '',
  '  enter/esc\u001b[2m confirm · \u001b[0mctrl + c\u001b[2m quit\u001b[0m',
].join('\n')

/** Codex asking how to sign in (onboarding/auth.rs, its inline snapshot). Enter starts the highlighted
 *  sign-in; a paste is ignored. */
export const CODEX_SIGN_IN = [
  '  Choose how you want to use Codex.',
  '',
  '\u001b[36m> 1. Sign in with ChatGPT\u001b[39m',
  '     \u001b[2mUsage included with Plus, Pro, Business, and Enterprise plans\u001b[0m',
  '',
  '  2. Sign in with Device Code',
  '     \u001b[2mSign in from another device with a one-time code\u001b[0m',
  '',
  '  3. Use an OpenAI API key',
  '     \u001b[2mPay for what you use\u001b[0m',
  '',
  '  \u001b[2mPress enter to continue\u001b[0m',
].join('\n')

/** Codex searching its prompt history, ctrl+r (chat_composer/history_search.rs, snapshot
 *  `history_search_pasted_query`): a paste extends the search and Enter only accepts the match into the
 *  composer, so the message becomes the search and an earlier prompt the draft. */
export const CODEX_HISTORY_SEARCH = [
  '\u001b[1m›\u001b[0m git status',
  '',
  '',
  '  \u001b[2mreverse-i-search: \u001b[0mgit status  \u001b[2menter accept · esc cancel\u001b[0m',
].join('\n')

/** Codex finding text in its transcript, F3 (transcript_view/search.rs): a paste becomes what it finds,
 *  and Enter goes to the next match. */
export const CODEX_TRANSCRIPT_FIND = [
  '\u001b[1m›\u001b[0m fix the login bug',
  '',
  '\u001b[2m•\u001b[0m Fixed: the session cookie was never refreshed.',
  '',
  '\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m',
  '',
  '\u001b[2mFind: \u001b[0mlogin                                        \u001b[2menter next · ctrl+p previous · esc close\u001b[0m',
].join('\n')

/** Codex's transcript overlay, ctrl+t, in its scrollback mode (pager_overlay/transcript.rs, snapshot
 *  `transcript_flag_off_viewer`): over the whole pane, a paste is dropped and Enter does nothing. */
export const CODEX_TRANSCRIPT_OVERLAY = [
  `\u001b[2m/ T R A N S C R I P T ${'/ '.repeat(39)}\u001b[0m`,
  '',
  '\u001b[1m›\u001b[0m fix the login bug',
  '',
  '\u001b[2m•\u001b[0m Fixed: the session cookie was never refreshed.',
  '',
  '\u001b[2mCtrl+Space select\u001b[0m',
  '\u001b[2m ↑/↓ to scroll · pgup/pgdn to page · home/end to jump\u001b[0m',
  '\u001b[2m q close · f3 find · esc browse prompts\u001b[0m',
].join('\n')

/** Claude Code searching its prompt history, ctrl+r (2.1.289): the search line under the prompt, which
 *  shows the match. A paste extends the search and Enter SENDS the match, an earlier prompt; Esc puts it
 *  in the prompt, ctrl+c closes the search as it was. */
export const CLAUDE_HISTORY_SEARCH = [
  `\u001b[38;5;244m${RULE}\u001b[39m`,
  '\u001b[39m❯ fix the login bug',
  `\u001b[38;5;244m${RULE}\u001b[39m`,
  '  \u001b[2msearch prompts:\u001b[0m login',
].join('\n')

/** The same with no match yet. */
export const CLAUDE_HISTORY_SEARCH_NO_MATCH = CLAUDE_HISTORY_SEARCH.replace('search prompts:', 'no matching prompt:')

/** Claude Code asked to trust the folder it starts in (2.1.289): its confirm lists `No, exit` first and
 *  highlights it, unnumbered, so Enter quits Claude Code. A paste is dropped. */
export const CLAUDE_TRUST_PROMPT = [
  `\u001b[38;5;220m${RULE}\u001b[39m`,
  ' \u001b[1m\u001b[38;5;220mAccessing workspace:\u001b[0m',
  '',
  ' \u001b[1m/tmp/project\u001b[0m',
  '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open',
  ' source project, or work from your team). If not, take a moment to review what’s in this folder first.',
  '',
  ' Claude Code’ll be able to read, edit, and execute files here.',
  '',
  ' \u001b[2mSecurity guide\u001b[0m',
  '',
  ' \u001b[38;5;153m❯\u001b[39m \u001b[38;5;153mNo, exit\u001b[39m',
  '   Yes, I trust this folder',
  '',
  ' \u001b[2m\u001b[3mEnter to confirm · Esc to cancel\u001b[0m',
].join('\n')

/** Claude Code asking how to sign in (2.1.289): Enter starts the highlighted sign-in. */
export const CLAUDE_SIGN_IN = [
  ' Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.',
  '',
  ' Select login method:',
  '',
  ' \u001b[38;5;153m❯\u001b[39m \u001b[38;5;153m1. Claude account with subscription · \u001b[2mPro, Max, Team, or Enterprise\u001b[0m',
  '',
  '   2. Anthropic Console account · \u001b[2mAPI usage billing\u001b[0m',
  '',
  '   3. 3rd-party platform · \u001b[2mAmazon Bedrock, Microsoft Foundry, or Vertex AI\u001b[0m',
].join('\n')
