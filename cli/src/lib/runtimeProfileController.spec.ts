import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexEffortRows, parseCodexPicker } from '../engines/codex/modelPicker.js'
import type { RegisteredSession } from './registry.js'
import { encodeRuntimeProfile, parseRuntimeProfile, RuntimeProfileManager } from './runtimeProfile.js'
import {
  inspectRuntimePane,
  parseCursorModelPicker,
  parseCursorParameterRows,
  paneModal,
  RuntimeProfileController,
} from './runtimeProfileController.js'
import {
  CLAUDE_PROMPT, CLAUDE_REWIND_CONFIRM, CLAUDE_REWIND_EMPTY, CLAUDE_REWIND_LIST, CLAUDE_REWIND_LIST_MESSAGE_FOCUSED,
  CODEX_BROWSING_FULLSCREEN, CODEX_BROWSING_SCROLLBACK, CODEX_PROMPT,
} from './__fixtures__/rewindPickers.js'
import { CLAUDE_HISTORY_SEARCH, CLAUDE_TRUST_PROMPT, CODEX_TRANSCRIPT_FIND, CODEX_TRANSCRIPT_OVERLAY, CODEX_UPDATE_PROMPT } from './__fixtures__/takeoverScreens.js'
import {
  CODEX_0160_ADVANCED, CODEX_0160_ALL_MODELS, CODEX_0160_ALL_MODELS_REFRESHED, CODEX_0160_ALL_MODELS_SPACED, CODEX_0160_COMPOSER, CODEX_0160_QUICK_MENU,
  CODEX_0160_REASONING, CODEX_0160_REASONING_SPACED, CODEX_0160_RESERVE, CODEX_0160_RESERVE_REASONING,
} from './__fixtures__/codexModelPickers.js'

/**
 * Codex's own catalog, where the controller reads the display names its picker shows. Every Codex
 * session here points at it (or at a throwaway home): with no `codexHome`, the manager would read the
 * developer's real ~/.codex.
 */
const CODEX_HOME_0160 = join(import.meta.dirname, '__fixtures__', 'codex-home-0.160')
const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))) })
/** A throwaway CODEX_HOME whose models_cache.json lists these models. */
async function codexHome(models: Array<Record<string, unknown>>): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codex-home-'))
  homes.push(home)
  await writeFile(join(home, 'models_cache.json'), JSON.stringify({ fetched_at: '2026-10-05T09:00:00Z', client_version: '0.160.0', models }))
  return home
}

// The id inside a `runtime-v1:` string is the AGENT id ('h1' here) — a client only ever echoes back an id
// the catalog minted, and the catalog is agent-scoped. `setProfile` is still addressed with either id.
function session(engine: 'claude' | 'codex' | 'cursor' | 'opencode'): RegisteredSession {
  return {
    schemaVersion: 2,
    active: true,
    sessionId: 's1', engine, launcherId: 'h1', agentId: 'h1', boundAt: 0, transcriptPath: '/tmp/s1.jsonl', projectDir: 'tmp', cwd: '/tmp',
    tmuxPane: '%1', source: null, title: null, model: null,
    runtimes: [{ backend: 'tmux', paneId: '%1' }], primaryRuntimeKey: 'tmux\u0000%1',
    cliVersion: engine === 'codex' ? '0.144.5' : engine === 'cursor' ? '2026.07.20-8cc9c0b' : engine === 'opencode' ? '1.18.31' : '2.1.212', processIdentity: null,
    registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
    ...(engine === 'codex' ? { codexHome: CODEX_HOME_0160 } : {}),
  }
}

describe('runtime pane parsing', () => {
  it('distinguishes dim placeholders from real drafts', () => {
    expect(inspectRuntimePane('codex', '\u001b[1m›\u001b[0m \u001b[2mWrite tests\u001b[0m')).toMatchObject({ idle: true, draft: false })
    expect(inspectRuntimePane('codex', '\u001b[1m›\u001b[0m write tests')).toMatchObject({ idle: false, draft: true })
    expect(inspectRuntimePane('claude', '\u001b[39m❯\u00a0\u001b[2mAsk about the codebase\u001b[0m')).toMatchObject({ idle: true, draft: false })
    expect(inspectRuntimePane('claude', '\u001b[39m❯\u00a0Ask about the codebase')).toMatchObject({ idle: false, draft: true })
    expect(inspectRuntimePane(
      'cursor',
      '\u001b[48;2;21;21;21m \u001b[2m→ \u001b[0;7mP\u001b[0;2mlan, search, build anything\u001b[0m',
    )).toMatchObject({ idle: true, draft: false })
  })

  it('reads Codex browsing its transcript as a modal, at every width, with or without a draft dimmed under it', () => {
    // As 0.160 draws it (tui/src/app_backtrack/prompt_navigation.rs): the composer dimmed whole, and the
    // footer row naming the mode, its keys and their actions, cut down as the pane narrows.
    const composer = '\u001b[2m\u001b[1m›\u001b[0m\u001b[2m \u001b[2mAsk Codex to do anything\u001b[0m'
    const dot = '\u001b[2m · \u001b[0m'
    const footers = [
      `\u001b[36mBrowsing transcript\u001b[0m${dot}↑↓/jk\u001b[2m scroll\u001b[0m${dot}←→/hl\u001b[2m prompts\u001b[0m${dot}ctrl + t\u001b[2m details\u001b[0m${dot}↵\u001b[2m rewind\u001b[0m${dot}esc\u001b[2m back\u001b[0m`,
      `\u001b[36mBrowsing\u001b[0m${dot}↵\u001b[2m rewind\u001b[0m${dot}esc\u001b[2m back\u001b[0m`,
      `\u001b[36mBrowsing\u001b[0m${dot}esc`,
      '\u001b[36mBrowsing\u001b[0m',
    ]
    for (const footer of footers) {
      expect(inspectRuntimePane('codex', `${composer}\n\n${footer}`), footer).toMatchObject({ idle: false, dialog: true })
    }
    // A draft is dimmed with everything else in the composer while browsing: still not a pane to type into.
    expect(inspectRuntimePane('codex', `\u001b[2m› keep this draft\u001b[0m\n\n${footers[0]}`)).toMatchObject({ idle: false, dialog: true })
    // Other engines, and Codex's own transcript text, are not read for it.
    expect(inspectRuntimePane('claude', `\u001b[39m❯\u00a0\u001b[2mAsk about the codebase\u001b[0m\n  Browsing · esc`)).toMatchObject({ idle: true, dialog: false })
    expect(inspectRuntimePane('codex', `  Browsing transcript · as before\n${composer}\n\n  gpt-5.6-sol default · /tmp/project`)).toMatchObject({ dialog: false })
  })

  it('reads Claude Code\'s Rewind menu as a modal, in each of its views, and as closed once its prompt is back', () => {
    // Its focused row is `❯ (current)` in italics: read as an empty, idle prompt, where Enter closes the
    // menu and drops what was pasted, and, on a message, takes it a step from restoring the conversation.
    for (const [view, screen] of Object.entries({ CLAUDE_REWIND_LIST, CLAUDE_REWIND_LIST_MESSAGE_FOCUSED, CLAUDE_REWIND_CONFIRM, CLAUDE_REWIND_EMPTY })) {
      expect(inspectRuntimePane('claude', screen), view).toMatchObject({ idle: false, dialog: true })
      expect(paneModal('claude', screen), view).toBe('rewind')
    }
    // Its prompt back between its rules under any leftover of it, it is closed.
    expect(inspectRuntimePane('claude', `${CLAUDE_REWIND_LIST}\n${CLAUDE_PROMPT}`)).toMatchObject({ idle: true, dialog: false })
    expect(paneModal('claude', `${CLAUDE_REWIND_LIST}\n${CLAUDE_PROMPT}`)).toBeNull()
    // A message that reads `Rewind`, in the transcript or the list, is not the menu's title.
    expect(paneModal('claude', `\u001b[38;5;239m\u001b[48;5;237m❯ \u001b[38;5;231mRewind\u001b[39m\u001b[49m\n\n${CLAUDE_PROMPT}`)).toBeNull()
    expect(paneModal('claude', CLAUDE_REWIND_LIST.replace('   fix the login bug', '   Rewind'))).toBe('rewind')
    // Another engine's pane is not read for it.
    expect(paneModal('cursor', CLAUDE_REWIND_LIST)).toBeNull()
  })

  it('finds Codex browsing its transcript in both its screen modes', () => {
    for (const [mode, screen] of Object.entries({ CODEX_BROWSING_FULLSCREEN, CODEX_BROWSING_SCROLLBACK })) {
      expect(inspectRuntimePane('codex', screen), mode).toMatchObject({ idle: false, dialog: true })
      expect(paneModal('codex', screen), mode).toBe('rewind')
    }
    expect(paneModal('codex', CODEX_PROMPT)).toBeNull()
    expect(paneModal('claude', '')).toBeNull()
  })

  it('reads the engines\' own screens that take the composer\'s place as dialogs, so no work is typed into them', () => {
    // A ready-looking composer stays on screen under Codex's find and Claude Code's history search.
    expect(inspectRuntimePane('codex', CODEX_TRANSCRIPT_FIND)).toMatchObject({ dialog: true, idle: false })
    expect(paneModal('codex', CODEX_TRANSCRIPT_FIND)).toBe('search')
    expect(inspectRuntimePane('claude', CLAUDE_HISTORY_SEARCH)).toMatchObject({ dialog: true, idle: false })
    expect(paneModal('codex', CODEX_TRANSCRIPT_OVERLAY)).toBe('transcript')
    expect(paneModal('codex', CODEX_UPDATE_PROMPT)).toBe('update')
    expect(paneModal('claude', CLAUDE_TRUST_PROMPT)).toBe('trust')
    // Codex browsing its transcript in its scrollback mode draws the same header: a rewind picker still.
    expect(paneModal('codex', CODEX_BROWSING_SCROLLBACK)).toBe('rewind')
  })

  it('tells an approval prompt and a menu from the MCP boot notice, which takes typing and is no modal for a message', () => {
    expect(paneModal('claude', ' Bash command\n   printf hi\n Do you want to proceed?\n ❯ 1. Yes\n   2. No')).toBe('permission')
    expect(paneModal('codex', 'Select Model and Effort\n› 1. gpt-5.6-sol (current)')).toBe('menu')
    const booting = `${CLAUDE_PROMPT}\n  Starting MCP servers (1/3)…`
    expect(paneModal('claude', booting)).toBeNull()
    // Still a dialog to every reader that holds work back from a booting pane.
    expect(inspectRuntimePane('claude', booting)).toMatchObject({ dialog: true })
  })

  it('reads hermes, which italicises its placeholder instead of dimming it', () => {
    // Copied byte-for-byte off a live pane. Hermes carries no SGR 2 at all: the placeholder is
    // italic (3) over a 256-colour gold, so a dim-only rule read every hermes pane as holding a
    // draft — `idle` false for the agent's whole life, and every retarget answered AGENT_BUSY over an
    // engine sitting at an empty prompt.
    const placeholder = '❯ \u001b[3m\u001b[38;5;136mAsk anything, or type / for commands…\u001b[0m'
    expect(inspectRuntimePane('hermes', placeholder)).toMatchObject({ idle: true, draft: false })
    expect(inspectRuntimePane('hermes', '❯ what changed in this repo')).toMatchObject({ idle: false, draft: true })
  })

  it('reads opencode past the status strip its own gutter runs through', () => {
    // The box: three composer rows, then the strip that names the mode, model and account, then the
    // rule that closes it. Every one of those rows carries the `┃` gutter, so the last-marker rule
    // landed on the strip and read the BOX describing itself as something the user had typed —
    // opencode was never idle, and every retarget came back AGENT_BUSY over an empty composer.
    const box = (composer: readonly string[]) => [
      '     ▣  Build · DeepSeek-V4-Flash-0731 · 6.0s',
      '',
      ...composer.map((line) => `  ┃${line}`),
      '  ┃  Build · DeepSeek-V4-Flash-0731 autonomous.ai',
      '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      '   /Users/example/Downloads/20260907',
    ].join('\n')

    expect(inspectRuntimePane('opencode', box(['', '', '']))).toMatchObject({ idle: true, draft: false })
    // Wrapped text counts wherever in the box it sits: reading only the row above the strip would
    // call a full composer empty.
    expect(inspectRuntimePane('opencode', box(['', '  what changed in', '  this repo'])))
      .toMatchObject({ idle: false, draft: true })
    // No closing rule is a layout we do not recognise, and then nothing is assumed to be a status
    // strip — a line the user typed must never be swallowed by a guess about the frame.
    expect(inspectRuntimePane('opencode', ['  ┃', '  ┃  fix the parser'].join('\n')))
      .toMatchObject({ idle: false, draft: true })
    // An earlier box still in scrollback is a message already SENT, not a draft.
    expect(inspectRuntimePane(
      'opencode',
      [box(['', '  LSP là gì thế', '']), 'answer text', box(['', '', ''])].join('\n'),
    )).toMatchObject({ idle: true, draft: false })
  })

  it('reads opencode past a card floating over its composer', () => {
    // Copied off a live pane (2026-09-15). OpenCode's `Getting started` card is drawn on the RIGHT,
    // which puts its text on the composer's own rows — a TUI paints one terminal row at a time, so
    // anything floating over the box lands inside the box's lines. Reading to end-of-line took
    // `Connect provider /connect` as something the user had typed, so an EMPTY composer read as a
    // draft, the pane was never idle, and every model switch came back AGENT_BUSY.
    const PANE = '\u001b[48;2;10;10;10m'
    const BOX = '\u001b[48;2;30;30;30m'
    const SIDEBAR = '\u001b[48;2;20;20;20m'
    const BLUE = '\u001b[38;2;92;156;245m'
    const WHITE = '\u001b[38;2;255;255;255m'
    const row = (composer: string, card: string) =>
      `${PANE}  ${BLUE}┃${WHITE}${BOX}${composer.padEnd(40)}`
      + `${PANE}  ${SIDEBAR}  ${BOX}    \u001b[38;2;238;238;238m${card}`
    const pane = (composer: readonly string[]) => [
      ...composer.map((line) => row(line, 'Connect provider        /connect')),
      row('  Build · Big Pickle OpenCode Zen', ''),
      `  ${BLUE}╹\u001b[38;2;30;30;30m▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀`,
    ].join('\n')

    expect(inspectRuntimePane('opencode', pane(['', '', '']))).toMatchObject({ idle: true, draft: false })
    // The card must not be able to hide a draft either: text INSIDE the box still counts, on the
    // very row the card writes into. Reading a real draft as an empty prompt respawns the engine
    // under text the user typed — the one direction this must never be wrong in.
    expect(inspectRuntimePane('opencode', pane(['', '  what changed in this repo', ''])))
      .toMatchObject({ idle: false, draft: true })
  })

  it('reads OpenCode\'s grey placeholder as a placeholder, not a draft', () => {
    // Copied off a live pane (1.18.31). The third placeholder styling this module has had to learn:
    // claude/codex/devin draw dim, hermes draws italic, and OpenCode draws a plain TRUECOLOR GREY
    // with neither attribute — so nothing recognised it and a BRAND-NEW pane read as one holding a
    // draft. It was never idle, and every model switch on an agent with no messages yet refused as
    // AGENT_BUSY over an empty composer.
    const BOX = '\u001b[48;2;30;30;30m'
    const PANE = '\u001b[48;2;10;10;10m'
    const WHITE = '\u001b[38;2;255;255;255m'
    const GREY = '\u001b[38;2;128;128;128m'
    const pane = (composer: string) => [
      `  \u001b[38;2;92;156;245m┃${WHITE}${BOX}  ${composer}${WHITE}     ${PANE}`,
      `  \u001b[38;2;92;156;245m┃${WHITE}${BOX}  \u001b[38;2;92;156;245mBuild${WHITE} ${GREY}·${WHITE} Big Pickle${PANE}`,
      '  \u001b[38;2;92;156;245m╹\u001b[38;2;30;30;30m▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
    ].join('\n')

    expect(inspectRuntimePane('opencode', pane(`${GREY}Ask anything… "What is the tech stack of this project?"`)))
      .toMatchObject({ idle: true, draft: false })
    // ⚠️ The direction that must never be wrong: text the user typed is drawn in the composer's own
    // near-white, and reading it as a placeholder would respawn the engine under a real draft.
    expect(inspectRuntimePane('opencode', pane(`${WHITE}switch me please`)))
      .toMatchObject({ idle: false, draft: true })
    // A grey hint sitting BESIDE typed text does not make the line a placeholder — every visible
    // character has to be muted, not merely some of them.
    expect(inspectRuntimePane('opencode', pane(`${WHITE}fix the parser${GREY}  ⏎ send`)))
      .toMatchObject({ idle: false, draft: true })
  })

  it('reads copilot, whose composer carries no marker while its sent messages do', () => {
    // Copied off a live pane. Copilot echoes every message the user has ALREADY SENT into the
    // transcript as `❯ <text>` in full brightness, and draws its composer as a `┃` box that carries
    // no marker at all — so the generic reader walked back to the last echo and read `hi`, a message
    // sent minutes ago, as a draft. Copilot was never idle for the life of the agent, and every
    // model switch came back AGENT_BUSY over an empty prompt.
    const pane = (composer: string) => [
      ' ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
      '  \u001b[38;2;240;246;252m❯ hi\u001b[39m',
      ' ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      ' ● Hi! What would you like to work on?',
      ' \u001b[38;2;145;152;161m~/Downloads/20260907\u001b[39m',
      '\u001b[38;2;129;139;152m╻\u001b[38;2;20;27;34m▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
      `\u001b[38;2;129;139;152m┃\u001b[39m\u001b[48;2;20;27;34m${composer}`,
      '\u001b[38;2;129;139;152m\u001b[49m╹\u001b[38;2;20;27;34m▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      '\u001b[39m ← open sidebar · / commands · ? help · tab next tab',
    ].join('\n')

    expect(inspectRuntimePane('copilot', pane(''))).toMatchObject({ idle: true, draft: false })
    // Copilot's box has no status strip, so its single gutter line IS the composer. Dropping it the
    // way opencode's last row is dropped would read a real draft as an empty prompt and respawn the
    // pane out from under it.
    expect(inspectRuntimePane('copilot', pane(' fix the parser'))).toMatchObject({ idle: false, draft: true })
    // A picker or a permission prompt REPLACES the box, so there is no gutter on screen and the pane
    // reads not-idle without [DIALOG_UI] having to name copilot's dialogs.
    expect(inspectRuntimePane('copilot', [
      '│ Do you want to allow this access?',
      '│ ❯ 1. Yes',
      '│   2. No, and tell Copilot what to do differently (Esc to stop)',
    ].join('\n'))).toMatchObject({ idle: false })
  })

  it('reads grok past the right-hand edge of its own composer box', () => {
    // Measured on a live pane (`harness-grok-*`, grok 4.6, 2026-09-09) with NOTHING typed into it.
    // The shared reader takes everything after `❯` and finds the box's closing `│`: one character,
    // non-empty, so `draft` was true on an empty composer. Not a transient — that edge is drawn on
    // every frame, so `idle` was false for the agent's whole life and every model switch came back
    // AGENT_BUSY. Same family as the hermes and opencode cases above; here the culprit is the box.
    const W = 60
    const box = (composer: readonly string[]) => [
      '  ╭' + '─'.repeat(W) + '╮',
      ...composer.map((line) => '  │ ' + line.padEnd(W - 2) + '│'),
      '  ╰' + '─'.repeat(W - 20) + ' Grok 4.6 (xhigh) ─╯',
      '',
      // The footer separator is also `│`, and it sits below the box. A body line must carry BOTH
      // edges, which this — one separator, no edges — never does.
      '  Shift+Tab:mode  │  Ctrl+x:shortcuts',
    ].join('\n')

    expect(inspectRuntimePane('grok', box(['❯']))).toMatchObject({ idle: true, draft: false })
    expect(inspectRuntimePane('grok', box(['❯ fix the parser']))).toMatchObject({ idle: false, draft: true })
    // Wrapped text counts wherever in the box it sits — the marker is only on the first row.
    expect(inspectRuntimePane('grok', box(['❯ a very long message', '  that wrapped down'])))
      .toMatchObject({ idle: false, draft: true })
    // An earlier box still in scrollback is a message already SENT, not a draft.
    expect(inspectRuntimePane('grok', [box(['❯ what is an LSP']), 'answer text', box(['❯'])].join('\n')))
      .toMatchObject({ idle: true, draft: false })
    // A picker over the pane is not something to respawn under, empty composer or not.
    expect(inspectRuntimePane('grok', box(['❯']) + '\n  Select Model and Effort'))
      .toMatchObject({ idle: false, dialog: true })
    // A layout with no recognisable box is "we cannot tell", which the caller reads as busy. Refusing
    // a switch costs a retry; respawning a pane we misread would discard whatever was in it.
    expect(inspectRuntimePane('grok', '  │ ❯ fix the parser')).toMatchObject({ idle: false })
  })

  it('does not read a truecolor foreground as a dim placeholder', () => {
    // `38;2;<r>;<g>;<b>` carries a literal 2 that is a colour-space selector, not the dim attribute.
    // Counting it would make a line the user had TYPED look like an empty composer — the one
    // direction this must never be wrong in, since the pane would read idle and be respawned under
    // the draft.
    expect(inspectRuntimePane('claude', '\u001b[39m❯\u00a0\u001b[38;2;255;170;0mfix the parser\u001b[0m'))
      .toMatchObject({ idle: false, draft: true })
  })

  it('reads devin and pi panes, whose composers look nothing like the others', () => {
    // Devin's marker is ❭ (U+276D), not claude's ❯ (U+276F) — reading it as claude's found no prompt at
    // all, and a pane with no prompt is never idle, so every switch would have been refused as BUSY.
    const devinPane = (composer: string) => [
      composer,
      '────────────────────────────',
      'SWE-1.6 Slow                       See all keyboard shortcuts: /shortcuts',
    ].join('\n')
    // Devin dims its placeholder the way claude does, so the same SGR rule separates it from a draft.
    expect(inspectRuntimePane('devin', devinPane('\u001b[39m❭ \u001b[2mAsk Devin to build features\u001b[0m')))
      .toMatchObject({ idle: true, draft: false })
    expect(inspectRuntimePane('devin', devinPane('\u001b[39m❭ fix the parser')))
      .toMatchObject({ idle: false, draft: true })

    // Pi draws no marker: its composer is the band between the last two rules, and the footer only
    // exists in the normal view.
    const piIdle = [
      '────────────────────────────',
      '',
      '────────────────────────────',
      '/private/tmp/rp-probe/pi',
      '0.0%/500k (auto)                          minimax/minimax-m3 • high',
    ].join('\n')
    expect(inspectRuntimePane('pi', piIdle)).toMatchObject({ idle: true, draft: false, dialog: false })
    expect(inspectRuntimePane('pi', piIdle.replace('\n\n', '\n/model something\n')))
      .toMatchObject({ idle: false, draft: true })
    expect(inspectRuntimePane('pi', [
      'Thinking Level',
      'Select reasoning depth for thinking-capable models',
      '→ medium      Moderate reasoning (~8k tokens)',
      '  Enter to select · Esc to go back',
    ].join('\n'))).toMatchObject({ idle: false, dialog: true })

    // A model with no thinking ladder draws no `• <level>`, so the footer ends at the model name.
    // EVERY grid model is that shape (`gridLaunch.ts` declares `reasoning: false`), and reading
    // idleness through the strict profile parser left every Pi agent on a grid permanently
    // AGENT_BUSY. Captured live from pi 0.82 on grid-3378218621364f16.
    const piGridIdle = [
      '───────────────────────────────────────────',
      '',
      '───────────────────────────────────────────',
      '~/KloveY/sandbox (main)',
      '↑5.4k ↓292 1.5%/200k (auto)                                       Auto',
    ].join('\n')
    expect(inspectRuntimePane('pi', piGridIdle))
      .toMatchObject({ idle: true, draft: false, dialog: false })
    // The band still decides what a draft is — the looser footer check must not make Pi look idle
    // while somebody is mid-sentence.
    expect(inspectRuntimePane('pi', piGridIdle.replace('\n\n', '\n/model something\n')))
      .toMatchObject({ idle: false, draft: true })
    // And a picker over that same footer is still a dialog, not idleness.
    expect(inspectRuntimePane('pi', `Type to search\n${piGridIdle}`))
      .toMatchObject({ idle: false, dialog: true })
  })

  it('ignores picker and Plan mode text left above the latest prompt', () => {
    const capture = 'Select Model and Effort\nPlan mode\n› old\ncompleted\n› \ngpt-5.6-sol high ·'
    expect(inspectRuntimePane('codex', capture)).toMatchObject({ idle: true, dialog: false, plan: false })
  })

  it('parses the version-gated Codex picker rows', () => {
    const menu = parseCodexPicker([
      'Select Model',
      'Pick a quick auto mode or browse all models.',
      '  1. codex-auto-review     Balanced agentic coding model for everyday work.',
      '› 2. All models (current)  Choose a specific model and reasoning level',
    ].join('\n'))
    expect(menu).toMatchObject({ kind: 'quick', rows: [{ number: 1, name: 'codex-auto-review' }, { number: 2, name: 'All models', current: true }] })

    const models = parseCodexPicker('Select Model and Effort\n  1. gpt-5.6-sol (default)          Latest frontier model.\n  2. gpt-5.6-terra\n› 3. gpt-5.6-luna (current)  Fast model.')
    expect(models?.rows.map((row) => [row.number, row.name])).toEqual([[1, 'gpt-5.6-sol'], [2, 'gpt-5.6-terra'], [3, 'gpt-5.6-luna']])
    const efforts = codexEffortRows(parseCodexPicker('Select Reasoning Level for gpt-5.6-sol\n  1. Low\n  2. High (default)\n  3. Extra high\n  4. More reasoning options')!)
    expect(efforts.efforts.get('xhigh')).toBe(3)
    expect(efforts.defaultRow).toBe(2)
    expect(efforts.advancedRow).toBe(4)
    const advanced = codexEffortRows(parseCodexPicker('Advanced Reasoning\n› 1. Max (current)  Higher usage\n  2. Ultra          Highest usage')!)
    expect(advanced.efforts.get('max')).toBe(1)
    expect(advanced.efforts.get('ultra')).toBe(2)
  })

  it('treats both Codex model picker generations as active dialogs', () => {
    expect(inspectRuntimePane(
      'codex',
      'Select Model\nPick a quick auto mode or browse all models.\n› 2. All models (current)',
    )).toMatchObject({ idle: false, dialog: true })
    expect(inspectRuntimePane(
      'codex',
      'Select Model and Effort\n› 1. gpt-5.6-sol (current)',
    )).toMatchObject({ idle: false, dialog: true })
  })

  it('does not reuse picker rows left before a newer composer prompt', () => {
    const stale = 'Select Model and Effort\n  1. gpt-old\n› 1. gpt-old\n› \ngpt-current high ·'
    expect(parseCodexPicker(stale)).toBeNull()
  })

  it('parses the gated Cursor picker and parameter rows by meaning', () => {
    const picker = [
      ' Available models                                    Max mode: OFF',
      ' Filter:',
      '    Auto',
      ' →  GPT-5.6 Sol              272K Medium (Tab to modify)',
      ' Type to filter • Enter to select • Tab to edit',
    ].join('\n')
    expect(parseCursorModelPicker(picker)).toEqual({ selectedFamily: 'GPT-5.6 Sol' })

    const parameters = [
      ' GPT-5.6 Sol — Edit Parameters',
      '  Context',
      '  → ● 272K ✓',
      '    ○ 1M',
      '  Reasoning',
      '    ○ None',
      '    ● Medium ✓',
      '    ○ Extra High',
      '    ◯ Fast',
    ].join('\n')
    expect(parseCursorParameterRows(parameters)).toEqual([
      { kind: 'context', value: '272k', selected: true, cursor: true, index: 0 },
      { kind: 'context', value: '1m', selected: false, cursor: false, index: 1 },
      { kind: 'reasoning', value: 'none', selected: false, cursor: false, index: 2 },
      { kind: 'reasoning', value: 'medium', selected: true, cursor: false, index: 3 },
      { kind: 'reasoning', value: 'xhigh', selected: false, cursor: false, index: 4 },
      { kind: 'fast', value: 'true', selected: false, cursor: false, index: 5 },
    ])
  })
})

describe('RuntimeProfileController', () => {
  it('sets Claude model and effort only after transcript confirmations', async () => {
    const value = session('claude')
    const manager = new RuntimeProfileManager()
    manager.hydrate(value, [])
    manager.ingestPane(value, 'Sonnet 5 with low effort\n❯ ', true)
    value.cliVersion = null // simulate an old persisted registry entry after manager hydration
    const commands: string[] = []
    const release = vi.fn()
    const controller = new RuntimeProfileController({
      manager,
      getSession: () => value,
      validateRuntime: async () => true,
      capture: async () => 'Opus 4.8 with high effort\n❯ ',
      sendText: async (_pane, command) => {
        commands.push(command)
        if (command.startsWith('/model ')) {
          manager.ingest(value, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Set model to Opus 4.8' }] } }))
        } else {
          manager.ingest(value, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Set effort level to high' }] } }))
        }
        return true
      },
      sendLiteral: async () => true,
      sendKey: async () => true,
      acquireInput: () => release,
    })
    const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'claude', model: 'opus', effort: 'high' })

    await controller.setProfile('s1', target)

    expect(commands).toEqual(['/model opus', '/effort high'])
    expect(manager.selectedModel(value)).toBe(target)
    expect(release).toHaveBeenCalledOnce()
  })

  it('does not reset unchanged auto effort after switching from Haiku to Sonnet', async () => {
    const value = session('claude')
    const manager = new RuntimeProfileManager()
    manager.hydrate(value, [JSON.stringify({
      type: 'user', message: { content: '<local-command-stdout>Set model to Haiku 4.5</local-command-stdout>' },
    })])
    expect(manager.selectedModel(value)).toBe(encodeRuntimeProfile({
      sessionId: 'h1', engine: 'claude', model: 'haiku', effort: 'auto',
    }))
    const commands: string[] = []
    const controller = new RuntimeProfileController({
      manager,
      getSession: () => value,
      validateRuntime: async () => true,
      capture: async () => '\u001b[39m\u276f\u00a0\u001b[2mAsk about the codebase\u001b[0m',
      sendText: async (_pane, command) => {
        commands.push(command)
        const output = command.startsWith('/model ')
          ? 'Set model to \u001b[1mSonnet 5\u001b[22m and saved as your default for new sessions'
          : 'Effort level set to auto'
        manager.ingest(value, JSON.stringify({
          type: 'user', message: { content: `<local-command-stdout>${output}</local-command-stdout>` },
        }))
        return true
      },
      sendLiteral: async () => true,
      sendKey: async () => true,
      acquireInput: () => () => undefined,
    })
    const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'claude', model: 'sonnet', effort: 'auto' })

    await controller.setProfile('s1', target)

    expect(commands).toEqual(['/model sonnet'])
    expect(manager.selectedModel(value)).toBe(target)
  })

  it('sets Claude ultracode effort through its native command value', async () => {
    const value = session('claude')
    const manager = new RuntimeProfileManager()
    manager.hydrate(value, [])
    manager.ingestPane(value, 'Sonnet 5 with high effort\n❯ ', true)
    const commands: string[] = []
    const controller = new RuntimeProfileController({
      manager,
      getSession: () => value,
      validateRuntime: async () => true,
      capture: async () => '\u001b[39m\u276f\u00a0\u001b[2mAsk about the codebase\u001b[0m',
      sendText: async (_pane, command) => {
        commands.push(command)
        const output = command.startsWith('/model ')
          ? 'Set model to Sonnet 5 and saved as your default for new sessions'
          : 'Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration'
        manager.ingest(value, JSON.stringify({
          type: 'user', message: { content: `<local-command-stdout>${output}</local-command-stdout>` },
        }))
        return true
      },
      sendLiteral: async () => true,
      sendKey: async () => true,
      acquireInput: () => () => undefined,
    })
    const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'claude', model: 'sonnet', effort: 'ultracode' })

    await controller.setProfile('s1', target)

    expect(commands).toEqual(['/effort ultracode'])
    expect(manager.selectedModel(value)).toBe(target)
  })

  it('does not touch tmux when the requested profile is already current', async () => {
    const value = session('claude')
    const manager = new RuntimeProfileManager()
    manager.hydrate(value, [])
    manager.ingestPane(value, 'Sonnet 5 with high effort\n❯ ', true)
    const validateRuntime = vi.fn(async () => true)
    const sendText = vi.fn(async () => true)
    const acquireInput = vi.fn(() => () => undefined)
    const controller = new RuntimeProfileController({
      manager,
      getSession: () => value,
      validateRuntime,
      capture: async () => '\u001b[39m\u276f\u00a0\u001b[2mAsk about the codebase\u001b[0m',
      sendText,
      sendLiteral: async () => true,
      sendKey: async () => true,
      acquireInput,
    })
    const current = encodeRuntimeProfile({ sessionId: 'h1', engine: 'claude', model: 'sonnet', effort: 'high' })

    await controller.setProfile('s1', current)

    expect(validateRuntime).not.toHaveBeenCalled()
    expect(acquireInput).not.toHaveBeenCalled()
    expect(sendText).not.toHaveBeenCalled()
  })

  it('rejects remote Codex changes while the native session is in Plan mode', async () => {
    const value = session('codex')
    const manager = new RuntimeProfileManager()
    manager.hydrate(value, [JSON.stringify({
      type: 'turn_context', payload: { model: 'gpt-5.6-sol', reasoning_effort: 'high', collaboration_mode: { mode: 'plan' } },
    })])
    const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'gpt-5.6-sol', effort: 'low' })
    vi.spyOn(manager, 'modelsForSession').mockResolvedValue([{ id: target, displayName: 'GPT-5.6-Sol / Low' }])
    const controller = new RuntimeProfileController({
      manager, getSession: () => value, validateRuntime: async () => true,
      capture: async () => '› \ngpt-5.6-sol high ·', sendText: vi.fn(), sendLiteral: vi.fn(), sendKey: vi.fn(), acquireInput: vi.fn(),
    })

    await expect(controller.setProfile('s1', target)).rejects.toMatchObject({ code: 'PLAN_SCOPE_AMBIGUOUS' })
  })

  it('selects Codex Ultra through the Advanced Reasoning submenu', async () => {
    const value = session('codex')
    const manager = new RuntimeProfileManager()
    manager.hydrate(value, [JSON.stringify({
      type: 'turn_context', payload: { model: 'gpt-5.6-sol', reasoning_effort: 'high' },
    })])
    const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'gpt-5.6-sol', effort: 'ultra' })
    vi.spyOn(manager, 'modelsForSession').mockResolvedValue([{ id: target, displayName: 'GPT-5.6-Sol / Ultra' }])
    let phase: 'idle' | 'models' | 'efforts' | 'advanced' = 'idle'
    const keys: string[] = []
    const controller = new RuntimeProfileController({
      manager,
      getSession: () => value,
      validateRuntime: async () => true,
      capture: async () => {
        if (phase === 'models') return 'Select Model and Effort\n  1. gpt-5.6-sol (current)'
        if (phase === 'efforts') return 'Select Reasoning Level for gpt-5.6-sol\n  5. More reasoning options'
        if (phase === 'advanced') return 'Advanced Reasoning\n  1. Max\n  2. Ultra'
        return '› \ngpt-5.6-sol high ·'
      },
      sendText: async () => { phase = 'models'; return true },
      sendLiteral: async () => true,
      sendKey: async (_pane, key) => {
        keys.push(key)
        if (phase === 'models' && key === '1') phase = 'efforts'
        else if (phase === 'efforts' && key === '5') phase = 'advanced'
        else if (phase === 'advanced' && key === '2') {
          phase = 'idle'
          manager.ingest(value, JSON.stringify({
            type: 'turn_context', payload: { model: 'gpt-5.6-sol', reasoning_effort: 'ultra' },
          }))
        }
        return true
      },
      acquireInput: () => () => undefined,
    })

    await controller.setProfile('s1', target)

    expect(keys).toEqual(['1', '5', '2'])
    expect(manager.selectedModel(value)).toBe(target)
  })

  it('selects an explicit Codex model through the 0.145 All models pre-menu', async () => {
    const value = session('codex')
    value.cliVersion = '0.145.0'
    const manager = new RuntimeProfileManager()
    manager.hydrate(value, [JSON.stringify({
      type: 'turn_context', payload: { model: 'gpt-5.6-sol', reasoning_effort: 'high' },
    })])
    const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'gpt-5.6-terra', effort: 'low' })
    vi.spyOn(manager, 'modelsForSession').mockResolvedValue([{ id: target, displayName: 'GPT-5.6-Terra / Low' }])
    let phase: 'idle' | 'menu' | 'models' | 'efforts' = 'idle'
    const keys: string[] = []
    const controller = new RuntimeProfileController({
      manager,
      getSession: () => value,
      validateRuntime: async () => true,
      capture: async () => {
        if (phase === 'menu') {
          return 'Select Model\nPick a quick auto mode or browse all models.\n  1. codex-auto-review\n› 2. All models (current)'
        }
        if (phase === 'models') {
          return 'Select Model and Effort\n  1. gpt-5.6-sol (current)\n  2. gpt-5.6-terra'
        }
        if (phase === 'efforts') return 'Select Reasoning Level for gpt-5.6-terra\n  1. Low\n  2. High (default)'
        return '› \ngpt-5.6-sol high ·'
      },
      sendText: async () => { phase = 'menu'; return true },
      sendLiteral: async () => true,
      sendKey: async (_pane, key) => {
        keys.push(key)
        if (phase === 'menu' && key === '2') phase = 'models'
        else if (phase === 'models' && key === '2') phase = 'efforts'
        else if (phase === 'efforts' && key === '1') {
          phase = 'idle'
          manager.ingest(value, JSON.stringify({
            type: 'turn_context', payload: { model: 'gpt-5.6-terra', reasoning_effort: 'low' },
          }))
        }
        return true
      },
      acquireInput: () => () => undefined,
    })

    await controller.setProfile('s1', target)

    expect(keys).toEqual(['2', '2', '1'])
    expect(manager.selectedModel(value)).toBe(target)
  })

  it('selects a Codex quick profile directly from the 0.145 pre-menu', async () => {
    const value = session('codex')
    value.cliVersion = '0.145.0'
    const manager = new RuntimeProfileManager()
    manager.hydrate(value, [JSON.stringify({
      type: 'turn_context', payload: { model: 'gpt-5.6-sol', reasoning_effort: 'high' },
    })])
    const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'codex-auto-review', effort: 'high' })
    vi.spyOn(manager, 'modelsForSession').mockResolvedValue([{ id: target, displayName: 'GPT-5.6-Terra / High' }])
    let phase: 'idle' | 'menu' | 'efforts' = 'idle'
    const keys: string[] = []
    const controller = new RuntimeProfileController({
      manager,
      getSession: () => value,
      validateRuntime: async () => true,
      capture: async () => {
        if (phase === 'menu') {
          return 'Select Model\nPick a quick auto mode or browse all models.\n  1. codex-auto-review\n› 2. All models (current)'
        }
        if (phase === 'efforts') {
          return 'Select Reasoning Level for codex-auto-review\n  1. Low\n  2. Medium (default)\n  3. High'
        }
        return '› \ngpt-5.6-sol high ·'
      },
      sendText: async () => { phase = 'menu'; return true },
      sendLiteral: async () => true,
      sendKey: async (_pane, key) => {
        keys.push(key)
        if (phase === 'menu' && key === '1') phase = 'efforts'
        else if (phase === 'efforts' && key === '3') {
          phase = 'idle'
          manager.ingest(value, JSON.stringify({
            type: 'turn_context', payload: { model: 'codex-auto-review', reasoning_effort: 'high' },
          }))
        }
        return true
      },
      acquireInput: () => () => undefined,
    })

    await controller.setProfile('s1', target)

    expect(keys).toEqual(['1', '3'])
    expect(manager.selectedModel(value)).toBe(target)
  })

  describe('Codex 0.160', () => {
    /** Codex's settings record once a choice is applied: what the switch is confirmed by. */
    const applied = (manager: RuntimeProfileManager, value: RegisteredSession, model: string, effort: string) =>
      manager.ingest(value, JSON.stringify({
        type: 'event_msg',
        payload: { type: 'thread_settings_applied', thread_settings: { model, reasoning_effort: effort, collaboration_mode: { mode: 'default' } } },
      }))
    const reasoningFor = (name: string) => CODEX_0160_REASONING.replace('Select Reasoning Level for GPT-5.5', `Select Reasoning Level for ${name}`)
    /** A 0.160 agent on `model` at `effort`, as its rollout says. */
    const agent = (model: string, effort: string, home = CODEX_HOME_0160) => {
      const value = { ...session('codex'), cliVersion: '0.160.0', codexHome: home }
      const manager = new RuntimeProfileManager()
      manager.hydrate(value, [JSON.stringify({ type: 'turn_context', payload: { model, reasoning_effort: effort } })])
      return { value, manager }
    }
    /**
     * A pane that answers as Codex's picker does: `/model` opens `opened`, and `press` says where each
     * key leads from the screen on show. The digits pressed are kept, in order.
     */
    const drive = (manager: RuntimeProfileManager, value: RegisteredSession, opened: string,
      press: (screen: string, key: string) => string, read: (screen: string) => string = (screen) => screen, ownEscape = false) => {
      let screen = CODEX_0160_COMPOSER
      const keys: string[] = []
      const controller = new RuntimeProfileController({
        manager,
        getSession: () => value,
        validateRuntime: async () => true,
        capture: async () => read(screen),
        sendText: async (_pane, text) => { if (text === '/model') screen = opened; return true },
        sendLiteral: async () => true,
        sendKey: async (_pane, key) => {
          keys.push(key)
          screen = key === 'Escape' && !ownEscape ? CODEX_0160_COMPOSER : press(read(screen), key)
          return true
        },
        acquireInput: () => () => undefined,
      })
      return { controller, keys }
    }

    it('switches the effort by the display-named rows, to the new Persistent', async () => {
      const models = JSON.parse(await readFile(join(CODEX_HOME_0160, 'models_cache.json'), 'utf8')).models
      // As Codex's own test gives gpt-5.5 the effort (popups_and_settings.rs `model_reasoning_selection_popup_snapshot`).
      for (const entry of models) {
        if (entry.slug === 'gpt-5.5') entry.supported_reasoning_levels.push({ effort: 'persistent', description: 'Continue working until put to sleep' })
      }
      const { value, manager } = agent('gpt-5.5', 'high', await codexHome(models))
      const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'gpt-5.5', effort: 'persistent' })
      // The catalog offers it: Harness lists persistent now that it knows the word.
      expect((await manager.modelsForSession(value)).map((option) => option.id)).toContain(target)
      const { controller, keys } = drive(manager, value, CODEX_0160_ALL_MODELS, (screen, key) => {
        if (screen === CODEX_0160_ALL_MODELS && key === '8') return CODEX_0160_REASONING
        if (screen === CODEX_0160_REASONING && key === '5') { applied(manager, value, 'gpt-5.5', 'persistent'); return CODEX_0160_COMPOSER }
        throw new Error(`unexpected ${key}`)
      })

      await controller.setProfile('s1', target)

      expect(keys).toEqual(['8', '5'])
      expect(manager.selectedModel(value)).toBe(target)
    })

    it('reaches a model whose name has a space through All models', async () => {
      const home = await codexHome([
        { slug: 'codex-auto-fast', display_name: 'Auto Fast', visibility: 'list', default_reasoning_level: 'high',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
        { slug: 'us.openai.gpt-5.6-luna', display_name: 'GPT-5.6 Luna', visibility: 'list', default_reasoning_level: 'high',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
      ])
      const { value, manager } = agent('us.openai.gpt-5.6-luna', 'high', home)
      const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'us.openai.gpt-5.6-luna', effort: 'low' })
      const { controller, keys } = drive(manager, value, CODEX_0160_QUICK_MENU, (screen, key) => {
        if (screen === CODEX_0160_QUICK_MENU && key === '2') return CODEX_0160_ALL_MODELS_SPACED
        if (screen === CODEX_0160_ALL_MODELS_SPACED && key === '1') return CODEX_0160_REASONING_SPACED
        if (screen === CODEX_0160_REASONING_SPACED && key === '1') { applied(manager, value, 'us.openai.gpt-5.6-luna', 'low'); return CODEX_0160_COMPOSER }
        throw new Error(`unexpected ${key}`)
      })

      await controller.setProfile('s1', target)

      expect(keys).toEqual(['2', '1', '1'])
      expect(manager.selectedModel(value)).toBe(target)
    })

    it('applies a quick preset with one press, and presses nothing for an effort it cannot give', async () => {
      const home = await codexHome([
        { slug: 'codex-auto-fast', display_name: 'Auto Fast', visibility: 'list', default_reasoning_level: 'high',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
        { slug: 'us.openai.gpt-5.6-luna', display_name: 'GPT-5.6 Luna', visibility: 'list', default_reasoning_level: 'high',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
      ])
      const { value, manager } = agent('us.openai.gpt-5.6-luna', 'high', home)
      const run = drive(manager, value, CODEX_0160_QUICK_MENU, (screen, key) => {
        // The row applies its default effort at once and saves it (model_popups.rs `model_selection_actions`).
        if (screen === CODEX_0160_QUICK_MENU && key === '1') { applied(manager, value, 'codex-auto-fast', 'high'); return CODEX_0160_COMPOSER }
        throw new Error(`unexpected ${key}`)
      })
      const auto = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'codex-auto-fast', effort: 'auto' })
      await run.controller.setProfile('s1', auto)
      expect(run.keys).toEqual(['1'])
      expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ model: 'codex-auto-fast', effort: 'high' })

      // Low: the preset can only apply High, so the switch is refused and the picker closed untouched.
      const again = drive(manager, value, CODEX_0160_QUICK_MENU, () => { throw new Error('no row may be pressed') })
      const low = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'codex-auto-fast', effort: 'low' })
      await expect(again.controller.setProfile('s1', low)).rejects.toMatchObject({ code: 'EFFORT_UNSUPPORTED' })
      expect(again.keys).toEqual(['Escape'])
    })

    it('presses the row the list shows once Codex has refreshed it, not the row it first drew', async () => {
      // Codex 0.160 draws its cached models at once and redraws the list when the server answers; here
      // the answer brings a new model first, and GPT-6-Luna moves from row 4 to row 5.
      const { value, manager } = agent('gpt-5.5', 'high')
      const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'gpt-6-luna', effort: 'high' })
      let reads = 0
      const { controller, keys } = drive(manager, value, CODEX_0160_ALL_MODELS, (screen, key) => {
        const row = parseCodexPicker(screen)?.rows.find((candidate) => String(candidate.number) === key)
        if (screen === CODEX_0160_ALL_MODELS_REFRESHED && row) return reasoningFor(row.name)
        if (screen === reasoningFor('GPT-6-Luna') && key === '3') { applied(manager, value, 'gpt-6-luna', 'high'); return CODEX_0160_COMPOSER }
        throw new Error(`unexpected ${key} on ${row?.name ?? 'a reasoning screen'}`)
      }, (screen) => (screen === CODEX_0160_ALL_MODELS && ++reads > 1 ? CODEX_0160_ALL_MODELS_REFRESHED : screen))

      await controller.setProfile('s1', target)

      expect(keys).toEqual(['5', '3'])
      expect(manager.selectedModel(value)).toBe(target)
    })

    it('stops when the reasoning picker that opens names another model than the row pressed', async () => {
      // The list read the same twice, and was renumbered between the second read and the digit.
      const { value, manager } = agent('gpt-5.5', 'high')
      const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'gpt-6-luna', effort: 'high' })
      const { controller, keys } = drive(manager, value, CODEX_0160_ALL_MODELS, (screen, key) => {
        const row = parseCodexPicker(CODEX_0160_ALL_MODELS_REFRESHED)?.rows.find((candidate) => String(candidate.number) === key)
        if (screen === CODEX_0160_ALL_MODELS && row) return reasoningFor(row.name)
        throw new Error(`unexpected ${key}`)
      })

      await expect(controller.setProfile('s1', target)).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
      // Row 4 was GPT-6-Luna when read and GPT-6-Sol when pressed: no effort was chosen for it.
      expect(keys).toEqual(['4', 'Escape'])
    })

    it('presses nothing for a model the list does not show exactly', async () => {
      const { value, manager } = agent('gpt-5.5', 'high')
      const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'gpt-7', effort: 'high' })
      vi.spyOn(manager, 'modelsForSession').mockResolvedValue([{ id: target, displayName: 'GPT-7 / High' }])
      const catalog = vi.spyOn(manager, 'codexCatalog')
      const { controller, keys } = drive(manager, value, CODEX_0160_ALL_MODELS, () => { throw new Error('no row may be pressed') })

      await expect(controller.setProfile('s1', target)).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
      expect(keys).toEqual(['Escape'])
      // The catalog is read again once before giving up: a refresh may have brought the name.
      expect(catalog).toHaveBeenCalledTimes(2)
    })

    it('offers an account held to the reserve model nothing else, and changes the reserve effort', async () => {
      const held = agent('gpt-reserve', 'medium')
      const other = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'gpt-6-luna', effort: 'high' })
      const refused = drive(held.manager, held.value, CODEX_0160_RESERVE, () => { throw new Error('no row may be pressed') })
      await expect(refused.controller.setProfile('s1', other)).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
      // Neither its one row nor Enter: the picker is recognised, and closed.
      expect(refused.keys).toEqual(['Escape'])

      const high = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'gpt-reserve', effort: 'high' })
      vi.spyOn(held.manager, 'modelsForSession').mockResolvedValue([{ id: high, displayName: 'Luna Reserve / High' }])
      const { controller, keys } = drive(held.manager, held.value, CODEX_0160_RESERVE, (screen, key) => {
        if (screen === CODEX_0160_RESERVE && key === '1') return CODEX_0160_RESERVE_REASONING
        if (screen === CODEX_0160_RESERVE_REASONING && key === '3') { applied(held.manager, held.value, 'gpt-reserve', 'high'); return CODEX_0160_COMPOSER }
        throw new Error(`unexpected ${key}`)
      })
      await controller.setProfile('s1', high)
      expect(keys).toEqual(['1', '3'])
      expect(held.manager.selectedModel(held.value)).toBe(high)
    })

    it('reaches Max through Advanced Reasoning, from a picker that opened on a reasoning screen', async () => {
      const { value, manager } = agent('gpt-5.6-sol', 'high')
      const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'gpt-5.6-sol', effort: 'max' })
      const reasoning = reasoningFor('GPT-5.6-Sol')
      let opened = false
      const { controller, keys } = drive(manager, value, reasoning, (screen, key) => {
        if (key === 'Escape' && !opened) { opened = true; return CODEX_0160_ALL_MODELS }
        if (screen === CODEX_0160_ALL_MODELS && key === '5') return reasoning
        if (screen === reasoning && key === '6') return CODEX_0160_ADVANCED
        if (screen === CODEX_0160_ADVANCED && key === '1') { applied(manager, value, 'gpt-5.6-sol', 'max'); return CODEX_0160_COMPOSER }
        throw new Error(`unexpected ${key}`)
      }, undefined, true)

      await controller.setProfile('s1', target)

      expect(keys).toEqual(['Escape', '5', '6', '1'])
      expect(manager.selectedModel(value)).toBe(target)
    })

    it('reaches Ultra on a GPT-6 model, as Codex catalog lists it there, and refuses Max where it does not', async () => {
      const { value, manager } = agent('gpt-5.5', 'high')
      const ultra = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' })
      const reasoning = reasoningFor('GPT-6.1-Sol')
      const { controller, keys } = drive(manager, value, CODEX_0160_ALL_MODELS, (screen, key) => {
        if (screen === CODEX_0160_ALL_MODELS && key === '1') return reasoning
        if (screen === reasoning && key === '6') return CODEX_0160_ADVANCED
        if (screen === CODEX_0160_ADVANCED && key === '2') { applied(manager, value, 'gpt-6.1-sol', 'ultra'); return CODEX_0160_COMPOSER }
        throw new Error(`unexpected ${key}`)
      })
      await controller.setProfile('s1', ultra)
      expect(keys).toEqual(['1', '6', '2'])
      expect(manager.selectedModel(value)).toBe(ultra)

      // gpt-5.5 lists no Max: refused before `/model` is typed.
      const refused = drive(manager, value, CODEX_0160_ALL_MODELS, () => { throw new Error('no key may be pressed') })
      await expect(refused.controller.setProfile('s1', encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'gpt-5.5', effort: 'max' })))
        .rejects.toMatchObject({ code: 'EFFORT_UNSUPPORTED' })
      expect(refused.keys).toEqual([])
    })

    it('presses nothing on a list that never reads the same twice', async () => {
      const { value, manager } = agent('gpt-5.5', 'high')
      const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'gpt-6-luna', effort: 'high' })
      let reads = 0
      const { controller, keys } = drive(manager, value, CODEX_0160_ALL_MODELS, () => { throw new Error('no row may be pressed') },
        (screen) => (screen === CODEX_0160_ALL_MODELS && ++reads % 2 === 0 ? CODEX_0160_ALL_MODELS_REFRESHED : screen))

      await expect(controller.setProfile('s1', target)).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
      expect(keys).toEqual(['Escape'])
    })

    it('takes the next switch after a refused one, when the app names the agent', async () => {
      // The apps address an agent by its agent id ('h1'), not by the engine session ('s1').
      const held = agent('gpt-reserve', 'medium')
      const refused = drive(held.manager, held.value, CODEX_0160_RESERVE, () => { throw new Error('no row may be pressed') })
      await expect(refused.controller.setProfile('h1', encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'gpt-6-luna', effort: 'high' })))
        .rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })

      const high = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'gpt-reserve', effort: 'high' })
      vi.spyOn(held.manager, 'modelsForSession').mockResolvedValue([{ id: high, displayName: 'Luna Reserve / High' }])
      const { controller } = drive(held.manager, held.value, CODEX_0160_RESERVE, (screen, key) => {
        if (screen === CODEX_0160_RESERVE && key === '1') return CODEX_0160_RESERVE_REASONING
        if (screen === CODEX_0160_RESERVE_REASONING && key === '3') { applied(held.manager, held.value, 'gpt-reserve', 'high'); return CODEX_0160_COMPOSER }
        throw new Error(`unexpected ${key}`)
      })
      await controller.setProfile('h1', high)
      expect(held.manager.selectedModel(held.value)).toBe(high)
    })

    it('confirms a model the catalog does not describe that applied its one effort at once', async () => {
      const { value, manager } = agent('gpt-5.5', 'high', await codexHome([]))
      const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'gpt-6-luna', effort: 'auto' })
      vi.spyOn(manager, 'modelsForSession').mockResolvedValue([{ id: target, displayName: 'GPT-6-Luna / Auto' }])
      const list = '  Select Model and Effort\n\n› 1. gpt-6-luna  Fast and affordable model for easier tasks.'
      const { controller, keys } = drive(manager, value, list, (screen, key) => {
        if (screen === list && key === '1') { applied(manager, value, 'gpt-6-luna', 'medium'); return CODEX_0160_COMPOSER }
        throw new Error(`unexpected ${key}`)
      })

      await controller.setProfile('s1', target)

      expect(keys).toEqual(['1'])
      expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ model: 'gpt-6-luna', effort: 'medium' })
    })
  })

  it('refuses to drive an engine the owner made view-only', async () => {
    // Switching is Claude and Codex only (owner, 2026-07-31). This replaces two tests that drove Cursor's
    // picker end to end: setCursor and the other per-engine drivers are still in the code, deliberately —
    // this policy has already flipped twice — but nothing can reach them while the gate is shut, so what
    // is worth asserting now is the refusal, and that it costs the user's pane nothing.
    const value = session('cursor')
    const manager = new RuntimeProfileManager()
    manager.hydrate(value, [])
    const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'cursor', model: 'claude-4.5-sonnet', effort: 'auto' })
    vi.spyOn(manager, 'modelsForSession').mockResolvedValue([{ id: target, displayName: 'Sonnet 4.5 / Auto' }])
    const sendKey = vi.fn().mockResolvedValue(true)
    const sendText = vi.fn().mockResolvedValue(true)
    const controller = new RuntimeProfileController({
      manager,
      getSession: () => value,
      validateRuntime: async () => true,
      capture: async () => '→ Add a follow-up',
      sendText,
      sendKey,
      sendLiteral: vi.fn().mockResolvedValue(true),
      acquireInput: () => () => undefined,
    })

    await expect(controller.setProfile('s1', target)).rejects.toMatchObject({ code: 'UNSUPPORTED_CLI_VERSION' })
    expect(sendKey).not.toHaveBeenCalled()
    expect(sendText).not.toHaveBeenCalled()
  })
})
