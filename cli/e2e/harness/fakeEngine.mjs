// A deterministic stand-in for Claude Code and Codex, run inside a real tmux pane by the daemon
// under test. It behaves the way the daemon depends on the real CLIs behaving, and nothing more:
//
//   - answers `--version` / `--help` probes;
//   - runs the hooks its own settings carry, as the real CLIs run them: the commands the daemon
//     installed (lib/hooks.ts), through a shell, from inside the pane, with the event on stdin, killed at
//     their timeout and waited for. So the real `hook/notify.mjs` is what reaches the daemon, with its
//     500 ms deadline and its offline registry writes, and the daemon's pane/process binding is
//     exercised for real;
//   - draws a composer, turns on bracketed paste, and treats Enter as submit;
//   - writes its conversation to a transcript in the engine's real record shapes, so the daemon's
//     normalizers, turn lifecycle, chips and attach read are exercised for real.
//
// A prompt can carry directives that script the turn: `!slow <ms>` holds the answer back,
// `!tool <command>` runs a tool call first, `!grow <MiB>` appends that much compaction history
// before answering (the transcripts that crashed the daemon on 2026-10-03), `!hold` leaves the turn
// open until the next prompt, `!ask` asks the person which drink they would like in the engine's own
// dialog and answers with their choice, `!permit <command>` asks permission to run a command the way
// the engine does and runs it only if allowed, `!flood <KiB>` prints that much to the terminal, in
// numbered lines, the way a build log or a long diff does, `!clear` starts a new conversation in the
// same pane as Claude Code's `/clear` and Codex's `/new` do, `!compact` compacts the conversation as
// `/compact` does (and Claude Code then announces the same session again), `!compactmid` compacts in the
// middle of a turn as an automatic compaction does, `!version` answers with the version this
// process is, `!goal` and `!goal done` (Codex) start and achieve a goal the way Codex 0.160 shows one
// under its composer, `!browse` (Codex) leaves Codex browsing its transcript in its default fullscreen
// mode, and `!browse scrollback` in its scrollback mode, `!transcript` (Claude Code) leaves it in its
// transcript view, as ctrl+o does, `!overlay` (Codex) in its transcript overlay, as ctrl+t does in its
// scrollback mode, `!search` searching its prompt history, as ctrl+r does, `!exit` ends the process.
// Everything else is echoed as the answer.
//
// Which release is installed is the config's business, so a test can update an engine in place by
// rewriting its wrapper: `version` is what it reports and writes, `without` lists the flags and
// subcommands that release no longer has, `updateAvailable` (Codex) names a newer release it asks to update
// to before it starts, and `startDelayMs` is how long it takes, once started, before
// it draws or announces anything (an engine's first run after an update). `firstHookDelayMs` is how long
// its first SessionStart takes to reach the daemon once the engine is up: the hook command starting on a
// loaded machine, while the daemon has already found the engine and its conversation. `root` is the
// test's throwaway root, the only place whose hooks it will run, and `hookLog` where it notes every hook
// it ran.
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * The events each CLI fires that the daemon installs hooks for (lib/hooks.ts): Claude Code's session,
 * prompt and turn-end events, and Codex's SessionStart and UserPromptSubmit, the two it installs for
 * Codex and the two notify.mjs reads from it. A hook for any other event in the settings is not run,
 * as the CLI has no such moment to run it at.
 */
const HOOK_EVENTS = {
  claude: new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd']),
  codex: new Set(['SessionStart', 'UserPromptSubmit']),
}

/** Inside `root`, or `root` itself. */
const within = (root, path) => {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Whether a hook block's matcher takes this value. Only SessionStart's matcher means anything to these
 * two CLIs (Codex's block carries `startup|resume|clear|compact`, matched against the event's source);
 * Stop and StopFailure ignore one (lib/hooks.ts). No matcher, an empty one or `*` takes everything.
 */
const matcherTakes = (matcher, value) => {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true
  try { return new RegExp(`^(?:${matcher})$`).test(String(value ?? '')) } catch { return false }
}

export async function run(engine, config) {
  const args = process.argv.slice(2)
  const version = config.version ?? (engine === 'claude' ? '2.1.270' : '0.159.0')
  const versionLine = engine === 'claude' ? `${version} (Claude Code)` : `codex-cli ${version}`
  const without = new Set(config.without ?? [])
  if (args.includes('--version') || args.includes('-V')) {
    process.stdout.write(`${versionLine}\n`)
    return
  }
  if (args.includes('--help') || args.includes('-h')) {
    // The flags the daemon looks for in the real CLIs' help before it launches them, less the ones this
    // release has dropped.
    process.stdout.write((engine === 'codex'
      ? [
          'Usage: codex [OPTIONS] [PROMPT]', '',
          '  -c, --config <key=value>', '  -m, --model <MODEL>', '  -s, --sandbox <SANDBOX_MODE>',
          '  -a, --ask-for-approval <APPROVAL_POLICY>', '      --approve-for-me',
          '      --dangerously-bypass-approvals-and-sandbox', '      --no-daemon',
          'Commands:', '  resume  Resume a previous interactive session', '',
        ]
      : [
          'Usage: claude [options] [command] [prompt]', '', 'Arguments:', '  prompt  Your prompt', '',
          '  --model <model>', '  --permission-mode <mode>  (choices: "acceptEdits", "auto", "bypassPermissions", "default", "plan")',
          '  --dangerously-skip-permissions', '  -r, --resume [value]', '  --fork-session', '  --session-id <uuid>', '',
        ]).filter((line) => !line.split(/[^A-Za-z0-9-]+/).some((word) => without.has(word))).join('\n'))
    return
  }
  // A flag or subcommand this release does not have is refused before anything is drawn, as the real
  // CLIs' parsers refuse one: Commander (Claude Code) exits 1, clap (Codex) exits 2.
  const refused = args.find((arg) => without.has(arg))
  if (refused) {
    process.stderr.write(engine === 'claude'
      ? `error: unknown option '${refused}'\n`
      : `error: unexpected argument '${refused}' found\n\nUsage: codex [OPTIONS] [PROMPT]\n\nFor more information, try '--help'.\n`)
    process.exit(engine === 'claude' ? 1 : 2)
  }
  process.title = engine
  // Raw at once, as the real CLIs are (Ink and ratatui take the terminal before they draw anything): a
  // terminal still in line mode keeps at most 1 KiB of a line, so a paste that arrived before the
  // engine was ready lost the rest of itself (measured: 1,018 of 2,406 characters).
  process.stdin.setRawMode?.(true)
  // Slow to start, as an engine is on its first run after an update: the process is there and holds
  // the terminal, and nothing is drawn, announced or read until it is ready.
  if (config.startDelayMs) await new Promise((resolve) => setTimeout(resolve, config.startDelayMs))
  // A newer release out (`updateAvailable`): Codex 0.160 asks first, before its session starts
  // (update_prompt.rs, snapshot `update_prompt_modal`). It drops a paste; Enter takes the highlighted row,
  // `Update now`, runs the update and asks to be restarted; Esc, 2 or ctrl+c skip it.
  if (engine === 'codex' && config.updateAvailable) {
    process.stdout.write(`\r\n  \x1b[1mUpdate available\x1b[0m\x1b[2m · \x1b[0m${config.version ?? '0.159.0'} → ${config.updateAvailable}\r\n`
      + '  \x1b[2mRelease notes: \x1b[0mhttps://github.com/openai/codex/releases/latest\r\n\r\n'
      + '\x1b[36m› 1. Update now (runs `npm install -g @openai/codex`)\x1b[39m\r\n  2. Skip\r\n  3. Skip until next version\r\n\r\n'
      + '  enter\x1b[2m continue · \x1b[0mesc\x1b[2m skip\x1b[0m\r\n')
    // Input that came before the prompt was drawn is thrown away, as Codex does
    // (`discard_pending_input_before_interactive_screen`).
    while (process.stdin.read() !== null) { /* discarded */ }
    const updateNow = await new Promise((resolve) => {
      const keys = (chunk) => {
        for (const token of String(chunk).match(/\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)|\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/g) ?? []) {
          if (token === '\r' || token === '\n' || token === '1') { process.stdin.off('data', keys); resolve(true); return }
          if (token === '\x1b' || token === '2' || token === '3' || token === '\x03') { process.stdin.off('data', keys); resolve(false); return }
        }
      }
      process.stdin.on('data', keys)
    })
    if (updateNow) {
      process.stdout.write('\x1b[H\x1b[2JUpdating Codex via `npm install -g @openai/codex`...\r\n\r\n🎉 Update ran successfully! Please restart Codex.\r\n')
      process.exit(0)
    }
    process.stdout.write('\x1b[H\x1b[2J')
  }

  const resumeAt = engine === 'claude' ? args.indexOf('--resume') : args.indexOf('resume')
  const resumed = resumeAt >= 0 && args[resumeAt + 1] && !args[resumeAt + 1].startsWith('-') ? args[resumeAt + 1] : null
  const fork = args.includes('--fork-session')
  let sessionId = resumed && !fork ? resumed : randomUUID()
  const cwd = process.cwd()
  // The person's own data folders, as the real CLIs honour them: CLAUDE_CONFIG_DIR moves Claude Code's
  // settings (its hooks with them), its transcripts and its process records; CODEX_HOME moves Codex's
  // hooks.json and its rollouts. Set in the person's shell profile, they reach the engine through the
  // shell it is launched in, whatever the daemon's own environment says. Unset (or Codex's the same as
  // the daemon's), everything is where it always was.
  const claudeHome = engine === 'claude' && process.env.CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CONFIG_DIR : null
  const ownCodexHome = engine === 'codex' && process.env.CODEX_HOME && process.env.CODEX_HOME !== config.codexHome ? process.env.CODEX_HOME : null
  const projectsDir = claudeHome ? join(claudeHome, 'projects') : config.claudeProjectsDir
  const codexHome = ownCodexHome ?? config.codexHome
  // The hooks this engine's settings carry, read once as it starts, where the real CLI reads them:
  // Claude Code's `settings.json` in its config folder (CLAUDE_CONFIG_DIR, else ~/.claude), Codex's
  // `hooks.json` in its CODEX_HOME. Claude Code snapshots its hooks at start-up ("takes effect on the
  // next claude session start", lib/hooks.ts) and Codex runs a user hook only once it was reviewed, so
  // a change reaches the next process, not this one: a moved home the daemon had not yet put its hooks
  // in starts an engine that never runs them. A settings file outside the test's root is refused out
  // loud before anything is run: those would be the person's own hooks, talking to their own daemon.
  const hookSettingsFile = engine === 'claude'
    ? join(claudeHome ?? join(homedir(), '.claude'), 'settings.json')
    : join(codexHome, 'hooks.json')
  // Every hook it ran, and how it ended, noted in a file and never in the pane: the real CLIs draw
  // nothing for a hook that exits 0, as notify.mjs always does, and a failure the fake once printed under
  // its composer read to the daemon as a draft the person had not sent, so a close waiting for the agent
  // to be idle waited for ever (e2e/ends.e2e.ts).
  const hookLog = (line) => {
    if (!config.hookLog) return
    try { appendFileSync(config.hookLog, `${new Date().toISOString()} ${engine} pid=${process.pid} ${line}\n`) } catch { /* a note, never a failure */ }
  }
  if (!config.root || !within(config.root, hookSettingsFile)) {
    hookLog(`REFUSED hooks outside the test root: ${hookSettingsFile}`)
    process.stderr.write(`[fake ${engine}] refusing to run the hooks in ${hookSettingsFile}: outside the test root ${config.root ?? '(none given)'}\r\n`)
    process.exit(78)
  }
  const hookSettings = (() => {
    try {
      const parsed = JSON.parse(readFileSync(hookSettingsFile, 'utf8'))
      return parsed && typeof parsed.hooks === 'object' && parsed.hooks ? parsed.hooks : {}
    } catch { return {} }
  })()
  let transcript = engine === 'claude'
    ? join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
    : resumed && !fork && config.rolloutFor?.[resumed]
      ? config.rolloutFor[resumed]
      : join(codexHome, 'sessions', '2026', '10', '03', `rollout-2026-10-03T00-00-00-${sessionId}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  if (!existsSync(transcript)) writeFileSync(transcript, '')
  // What each CLI leaves for whoever needs to know which conversation this process is writing, as the
  // daemon does when the conversation's start-up hook was lost. Codex holds its rollout open for the
  // session; Claude Code keeps a record per process, `~/.claude/sessions/<pid>.json`.
  let held = null
  const procStart = (() => { try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)]).toString().trim() } catch { return '' } })()
  const announceProcess = () => {
    if (engine === 'codex') {
      if (held !== null) closeSync(held)
      held = openSync(transcript, 'r')
    } else if (procStart) {
      const sessions = join(dirname(projectsDir), 'sessions')
      mkdirSync(sessions, { recursive: true })
      writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId, cwd: process.cwd(), procStart }))
    }
  }

  const now = () => new Date().toISOString()
  const write = (record) => appendFileSync(transcript, JSON.stringify(record) + '\n')
  let parent = null
  const claude = (record) => {
    const uuid = randomUUID()
    write({ parentUuid: parent, isSidechain: false, userType: 'external', cwd, sessionId, version, timestamp: now(), uuid, ...record })
    parent = uuid
  }
  const codex = (type, payload) => write({ timestamp: now(), type, payload })
  if (engine === 'codex' && readFileSync(transcript, 'utf8') === '') {
    codex('session_meta', { id: sessionId, cli_version: version, cwd, source: 'cli' })
  }

  // What the CLI says about its permission mode in an event, read off its own argv as it reads it.
  const permissionMode = engine === 'claude'
    ? (args.includes('--dangerously-skip-permissions') ? 'bypassPermissions'
      : args.includes('--permission-mode') ? args[args.indexOf('--permission-mode') + 1] ?? 'default' : 'default')
    : (args.includes('--dangerously-bypass-approvals-and-sandbox') ? 'bypassPermissions' : 'default')
  const codexModel = config.codexModel ?? 'gpt-6'
  /**
   * The JSON an event hands its hooks on stdin, in each CLI's own shape: what notify.mjs reads (session,
   * transcript, folder, the event and its source, prompt or reason) and the rest of what the real CLIs
   * were recorded sending (src/lib/__fixtures__/swarm-prompt-hooks.json: Claude Code's prompt id and
   * permission mode, Codex's turn id, model and permission mode).
   */
  const hookInput = (event, fields) => ({
    session_id: sessionId,
    transcript_path: transcript,
    cwd,
    hook_event_name: event,
    ...(engine === 'codex' ? { model: codexModel, permission_mode: permissionMode } : {}),
    ...fields,
  })
  /**
   * One hook command, as the CLIs run one: through a shell, in the engine's folder and with its
   * environment (Claude Code adds CLAUDE_PROJECT_DIR), the event on stdin, killed once its `timeout`
   * (seconds) is up. Resolves when it exits or is killed: the CLI waits for its hooks before it goes on.
   */
  const runHookCommand = (event, command, timeoutSeconds, input) => new Promise((done) => {
    const started = Date.now()
    // What a test reads back: the event, why it fired, and the conversation it named.
    const what = `${event}${input.source || input.reason ? `(${input.source || input.reason})` : ''} session=${input.session_id}`
    const env = engine === 'claude' ? { ...process.env, CLAUDE_PROJECT_DIR: cwd } : process.env
    let child
    try {
      child = spawn('/bin/sh', ['-c', command], { cwd, env, stdio: ['pipe', 'ignore', 'pipe'] })
    } catch (error) {
      hookLog(`${what} could not start: ${error?.message ?? error}`)
      done()
      return
    }
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { if (stderr.length < 2_000) stderr += chunk })
    const limit = (Number(timeoutSeconds) > 0 ? Number(timeoutSeconds) : 60) * 1000
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      hookLog(`${what} killed at its timeout of ${limit} ms`)
      child.kill('SIGTERM')
      done()
    }, limit)
    child.on('error', (error) => { clearTimeout(timer); hookLog(`${what} failed: ${error.message}`); done() })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      hookLog(`${what} ${killed ? 'ended after it was killed' : 'ran'} in ${Date.now() - started} ms · exit=${code ?? signal}`
        + (stderr.trim() ? ` · stderr=${JSON.stringify(stderr.trim().slice(0, 500))}` : ''))
      done()
    })
    child.stdin.on('error', () => { /* a hook that exits without reading its input */ })
    child.stdin.end(JSON.stringify(input))
  })
  /** Every hook the settings carry for this event, at once, each command once, and wait for them all. */
  const runHooks = async (event, fields = {}) => {
    if (!HOOK_EVENTS[engine].has(event)) return
    const blocks = Array.isArray(hookSettings[event]) ? hookSettings[event] : []
    const commands = new Map()
    for (const block of blocks) {
      if (event === 'SessionStart' && !matcherTakes(block?.matcher, fields.source)) continue
      for (const entry of Array.isArray(block?.hooks) ? block.hooks : []) {
        if (entry?.type !== 'command' || typeof entry.command !== 'string' || !entry.command) continue
        if (!commands.has(entry.command)) commands.set(entry.command, entry.timeout)
      }
    }
    if (!commands.size) return
    const input = hookInput(event, fields)
    await Promise.all([...commands].map(([command, timeout]) => runHookCommand(event, command, timeout, input)))
  }

  announceProcess()
  // What Codex 0.160 draws under its empty composer in the two states the daemon must read off the pane
  // (tui/src/bottom_pane): a goal it is pursuing, on the right of its status line, and the footer of
  // its transcript browser, with the composer dimmed whole. Null draws the composer alone, as before.
  // Browsing in its scrollback mode is a transcript pager over the whole pane instead, on the alternate
  // screen, with the same footer on its last row (pager_overlay/transcript.rs).
  let bottom = null
  const placeholder = '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m'
  const goalBottom = (goal) => ({ composer: placeholder, footer: `  gpt-6 high · ${cwd}   \x1b[35m${goal}\x1b[0m` })
  const browsingFooter = '\x1b[36mBrowsing transcript\x1b[0m\x1b[2m · \x1b[0m↑↓/jk\x1b[2m scroll · \x1b[0m←→/hl\x1b[2m prompts · \x1b[0m↵\x1b[2m rewind · \x1b[0mesc\x1b[2m back\x1b[0m'
  const browsingBottom = { composer: '\x1b[2m› Ask Codex to do anything\x1b[0m', footer: browsingFooter, browsing: true }
  const pagerBottom = (prompt, answer) => ({ browsing: true, pager: `\x1b[?1049h\x1b[H\x1b[2J\x1b[2m/ T R A N S C R I P T ${'/ '.repeat(30)}\x1b[0m`
    + `\r\n\x1b[7m› ${prompt}\x1b[0m\r\n\r\n\x1b[2m•\x1b[0m ${answer}\x1b[999;1H${browsingFooter}` })
  // Claude Code's transcript view (ctrl+o, 2.1.289): the conversation over the whole pane, its prompt
  // hidden, and its footer row under a dim rule.
  const transcriptBottom = (prompt, answer) => ({ transcript: true, pager: `\x1b[?1049h\x1b[H\x1b[2J\x1b[48;5;237m❯ ${prompt}\x1b[49m`
    + `\r\n\r\n⏺ ${answer}\x1b[998;1H\x1b[2m${'─'.repeat(60)}\x1b[0m\x1b[999;1H  \x1b[2mShowing detailed transcript · ctrl+o to toggle · ctrl+e to show all\x1b[0m` })
  // Codex's transcript overlay, ctrl+t, in its scrollback mode (pager_overlay/transcript.rs, snapshot
  // `transcript_flag_off_viewer`): over the whole pane, its hints on the last rows.
  const overlayBottom = (prompt, answer) => ({ overlay: true, prompt, answer, pager: `\x1b[?1049h\x1b[H\x1b[2J\x1b[2m/ T R A N S C R I P T ${'/ '.repeat(30)}\x1b[0m`
    + `\r\n\r\n\x1b[1m›\x1b[0m ${prompt}\r\n\r\n\x1b[2m•\x1b[0m ${answer}\x1b[997;1H\x1b[2mCtrl+Space select\x1b[0m`
    + '\x1b[998;1H\x1b[2m ↑/↓ to scroll · pgup/pgdn to page · home/end to jump\x1b[0m\x1b[999;1H\x1b[2m q close · f3 find · esc browse prompts\x1b[0m' })
  // The prompts sent so far, newest last, which a search through the prompt history (ctrl+r) looks in.
  const history = []
  // Searching them, as each engine draws it under its composer: the match in the composer, and Claude
  // Code's `search prompts: …` (or `no matching prompt: …`) or Codex's `reverse-i-search: …` footer.
  const searchBottom = (query) => {
    const match = query ? history.findLast((sent) => sent.toLowerCase().includes(query.toLowerCase())) ?? null : null
    const footer = engine === 'claude'
      ? `  \x1b[2m${query && !match ? 'no matching prompt:' : 'search prompts:'}\x1b[0m ${query}`
      : `  \x1b[2mreverse-i-search: \x1b[0m${query}  \x1b[2menter accept · esc cancel\x1b[0m`
    return { search: true, query, match, composer: `› ${match ?? ''}`, footer }
  }
  const draw = (line = '') => {
    if (bottom?.pager) { process.stdout.write(bottom.pager); return }
    if (bottom && !line) {
      // The footer on the row under the composer, then the cursor back to the composer, after its glyph.
      process.stdout.write(`\r\x1b[2K${bottom.composer}\r\n\x1b[2K${bottom.footer}\x1b[1A\r\x1b[2C`)
      return
    }
    process.stdout.write(`\r\x1b[2K› ${line}`)
  }
  // Out of the browser, back to the composer: the pager's alternate screen left, or the footer row
  // under the composer cleared. Enter rewinds on the way out.
  const leaveBrowsing = (rewound) => {
    if (bottom.pager) process.stdout.write('\x1b[?1049l')
    else process.stdout.write('\r\n\x1b[2K\x1b[1A')
    if (rewound) process.stdout.write('\r\x1b[2K(rewound to an earlier prompt)\r\n')
    bottom = null
    draw()
  }
  process.stdout.write(`\x1b[?2004h${engine === 'claude' ? '✻ Welcome to Claude Code (fake)' : '>_ OpenAI Codex (fake)'}\r\n`)
  process.stdout.write(`  session ${sessionId}${resumed ? ' (resumed)' : ''}\r\n\r\n`)
  draw()
  if (config.firstHookDelayMs && !resumed) await new Promise((resolve) => setTimeout(resolve, config.firstHookDelayMs))
  await runHooks('SessionStart', { source: resumed ? 'resume' : 'startup' })

  let turn = 0
  let open = null
  // The question dialog `!ask` draws, as the real CLIs draw theirs (the parser's fixtures,
  // src/lib/__fixtures__/question-single.txt and question-codex.txt). Claude takes a digit as the
  // choice; Codex moves its cursor on a digit and takes Enter; Esc cancels either.
  let dialog = null
  // What a person pasted as notes on the option Codex then submitted, for the answer to say.
  let notes = ''
  const QUESTION = 'Which drink would you like?'
  const CHOICES = [['Tea', 'Lighter, steeped leaves.'], ['Coffee', 'Stronger, roasted beans.']]
  const drawDialog = () => {
    const rule = '─'.repeat(60)
    const mark = (i, on) => (dialog.cursor === i ? on : ' ')
    // A permission prompt, as the CLIs draw one (__fixtures__/permission-claude.txt, permission-codex.txt).
    const command = dialog.command
    const lines = dialog.kind === 'permit' ? (engine === 'claude'
      ? [rule, ' Bash command', `   ${command}`, '   Run the command', ' This command requires approval', ' Do you want to proceed?',
          ...['Yes', `Yes, and don’t ask again for: ${command} *`, 'No'].map((label, i) => `${dialog.cursor === i ? ' ❯ ' : '   '}${i + 1}. ${label}`),
          ' Esc to cancel · Tab to amend · ctrl+e to explain']
      : [`  $ ${command}`, '',
          `${mark(0, '›')} 1. Yes, proceed (y)`, `${mark(1, '›')} 2. Yes, and don't ask again for commands that start with \`${command}\` (p)`,
          `${mark(2, '›')} 3. No, and tell Codex what to do differently (esc)`, '', '  Press enter to confirm or esc to cancel'])
      : engine === 'claude'
      ? [rule, ' ☐ Drink', '', QUESTION, '',
          ...CHOICES.flatMap(([label, description], i) => [`${mark(i, '❯')} ${i + 1}. ${label}`, `     ${description}`]),
          '  3. Type something.', rule, '  4. Chat about this', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel']
      : ['  Question 1/1 (1 unanswered)', `  ${QUESTION}`,
          ...CHOICES.map(([label, description], i) => `  ${mark(i, '›')} ${i + 1}. ${label.padEnd(7)} ${description}`),
          `  ${mark(2, '›')} 3. None of the above  Optionally, add details in notes (tab).`,
          `  option ${dialog.cursor + 1}/3 | tab to add notes`, '  enter to submit answer | esc to interrupt']
    // Repainted in place, as a TUI does: a redraw replaces the dialog, it does not stack another below.
    eraseDialog()
    process.stdout.write(`\r\n${lines.join('\r\n')}\r\n`)
    dialog.drawn = lines.length + 1
  }
  const eraseDialog = () => {
    if (dialog?.drawn) process.stdout.write(`\x1b[${dialog.drawn}A\r\x1b[0J`)
    if (dialog) dialog.drawn = 0
  }
  // Keys and pastes as the real CLIs take them while a dialog is up. A bracketed paste is one event, never
  // keys, in both (Claude Code's Ink input parser; Codex's crossterm): neither engine's permission prompt
  // takes a paste (Claude Code's Select has no paste handler, Codex's ApprovalOverlay leaves
  // `handle_paste` to its default), so it is dropped, and Enter then confirms the focused row, which is
  // the first: approve (Codex's own test, approval_overlay.rs `enter_sets_last_selected_index…`, expects
  // Accept). In a question, Claude Code drops the paste the same way and Enter picks the focused option;
  // Codex takes a paste as notes on the focused option (request_user_input `handle_paste`) and Enter
  // submits it. Digits pick a row; Codex's `y` approves; arrows move; Esc declines or cancels.
  const dialogKeys = (chunk) => {
    for (const key of chunk.match(/\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)|\x1b\[[AB]|\x1b|\r|\n|./gs) ?? []) {
      if (!dialog) return
      const settle = (choice) => { eraseDialog(); const asked = dialog; dialog = null; notes = asked.notes ?? ''; asked.resolve(choice) }
      const rows = dialog.kind === 'permit' ? 3 : engine === 'claude' ? CHOICES.length : CHOICES.length + 1
      if (key.startsWith('\x1b[200~')) {
        if (dialog.kind !== 'permit' && engine === 'codex') dialog.notes = key.slice(6).replace(/\x1b\[201~$/, '')
        continue
      }
      if (key === '\x1b[B') { dialog.cursor = Math.min(dialog.cursor + 1, rows - 1); drawDialog(); continue }
      if (key === '\x1b[A') { dialog.cursor = Math.max(dialog.cursor - 1, 0); drawDialog(); continue }
      if (dialog.kind === 'permit') {
        if (key === '\x1b') settle(null)
        else if (key === 'y' && engine === 'codex') settle(0)
        else if (key === '\r' || key === '\n') settle(dialog.cursor)
        else if (/^[1-3]$/.test(key)) settle(Number(key) - 1)
        continue
      }
      if (key === '\x1b') settle(null)
      else if (key === '\r' || key === '\n') settle(CHOICES[dialog.cursor]?.[0] ?? 'None of the above')
      else if (/^[1-9]$/.test(key) && Number(key) <= rows) {
        dialog.cursor = Number(key) - 1
        if (engine === 'claude') settle(CHOICES[dialog.cursor][0])
        else drawDialog()
      }
    }
  }
  const compact = () => {
    if (engine === 'claude') {
      claude({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 4096 } })
      claude({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' } })
    } else {
      codex('compacted', { message: 'Summary of the conversation so far.', replacement_history: [] })
    }
  }
  const finish = async (text) => {
    if (engine === 'claude') {
      claude({ type: 'assistant', message: { id: `msg_${turn}`, role: 'assistant', model: config.claudeModel ?? 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn' } })
    } else {
      codex('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text }], phase: 'final_answer' } })
      codex('event_msg', { type: 'task_complete', turn_id: open, last_agent_message: text })
    }
    process.stdout.write(`\r\n${text}\r\n\r\n`)
    open = null
    draw()
    // Claude Code's Stop hooks run once the answer is in, and the CLI waits for them before it takes the
    // next prompt; an interrupt ends a turn without them.
    await runHooks('Stop', { stop_hook_active: false })
  }

  const handle = async (raw) => {
    const prompt = raw.trim()
    if (!prompt) { draw(); return }
    history.push(prompt)
    if (prompt === '!exit') {
      // Leaving at the prompt is the end of the session to Claude Code, and it says so to its hooks.
      await runHooks('SessionEnd', { reason: 'prompt_input_exit' })
      process.stdout.write('\x1b[?2004l\r\n')
      process.exit(0)
    }
    if (prompt === '!compact') {
      // `/compact` is a command, not a turn: a summary replaces the history, and Claude Code announces
      // the same session again (SessionStart, source compact), which makes the daemon re-read it.
      compact()
      process.stdout.write('\r\n(compacted)\r\n')
      draw()
      if (engine === 'claude') await runHooks('SessionStart', { source: 'compact' })
      return
    }
    if (prompt === '!clear') {
      // The old conversation ends (its open turn first), a new id and transcript begin, and the engine
      // says both through its hooks, as the real CLIs do.
      if (open) await finish('(interrupted by a new conversation)')
      await runHooks('SessionEnd', { reason: 'clear' })
      sessionId = randomUUID()
      transcript = engine === 'claude'
        ? join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
        : join(codexHome, 'sessions', '2026', '10', '03', `rollout-2026-10-03T00-00-00-${sessionId}.jsonl`)
      mkdirSync(dirname(transcript), { recursive: true })
      writeFileSync(transcript, '')
      parent = null
      turn = 0
      if (engine === 'codex') codex('session_meta', { id: sessionId, cli_version: version, cwd, source: 'cli' })
      announceProcess()
      process.stdout.write('\r\n(new conversation)\r\n')
      draw()
      await runHooks('SessionStart', { source: 'clear' })
      return
    }
    if (open) await finish('(interrupted by a new prompt)')
    // Both CLIs run their UserPromptSubmit hooks on every prompt, before the prompt is taken: notify.mjs
    // sends it through the same door as SessionStart, the catch hook that re-registers a session whose
    // start-up announcement the daemon missed. The fields beyond the prompt are those each CLI was
    // recorded sending.
    await runHooks('UserPromptSubmit', engine === 'claude'
      ? { prompt_id: randomUUID(), permission_mode: permissionMode, prompt }
      : { turn_id: `turn-${turn + 1}`, prompt })
    turn++
    open = `turn-${turn}`
    // Onto the row under the composer, which holds a footer while one is drawn: cleared, as Codex redraws
    // its whole bottom pane rather than leave the old one in the history above.
    process.stdout.write(`\r\n\x1b[2K`)
    if (engine === 'claude') {
      claude({ type: 'user', message: { role: 'user', content: prompt } })
      claude({ type: 'assistant', message: { id: `msg_${turn}_t`, role: 'assistant', model: config.claudeModel ?? 'claude-opus-5-5', content: [{ type: 'thinking', thinking: `considering: ${prompt}` }], stop_reason: null } })
    } else {
      codex('event_msg', { type: 'task_started', turn_id: open })
      codex('turn_context', { turn_id: open, model: config.codexModel ?? 'gpt-6', reasoning_effort: 'high', collaboration_mode: { mode: 'default' } })
      codex('event_msg', { type: 'item_completed', turn_id: open, item: { type: 'UserMessage', id: open, content: [{ type: 'text', text: prompt, text_elements: [] }] } })
      codex('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: `considering: ${prompt}` }] })
    }
    const directive = /^!(\w+)\s*(.*)$/.exec(prompt)
    if (directive?.[1] === 'grow' || directive?.[1] === 'burst') {
      // `grow` writes the way Codex compacts — a snapshot at a time, with the engine still working in
      // between — so a live tail sees a few MiB per read. `burst` writes it all at once.
      const mib = Number(directive[2]) || 1
      const chunk = 'x'.repeat(1024 * 1024 - 256)
      for (let i = 0; i < mib; i++) {
        if (engine === 'claude') claude({ type: 'user', isCompactSummary: true, message: { role: 'user', content: chunk } })
        else codex('compacted', { message: chunk, replacement_history: [] })
        if (directive[1] === 'grow' && i % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 60))
      }
    }
    if (directive?.[1] === 'tool') {
      const id = `call_${turn}`
      if (engine === 'claude') {
        claude({ type: 'assistant', message: { id: `msg_${turn}_u`, role: 'assistant', model: config.claudeModel ?? 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: directive[2] } }], stop_reason: 'tool_use' } })
        claude({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `ran ${directive[2]}` }] } })
      } else {
        codex('response_item', { type: 'function_call', call_id: id, name: 'exec_command', arguments: JSON.stringify({ cmd: directive[2] }) })
        codex('response_item', { type: 'function_call_output', call_id: id, output: `ran ${directive[2]}` })
      }
    }
    if (directive?.[1] === 'flood') {
      // Numbered, so whoever reads the terminal can tell a lost, repeated or reordered line.
      const kib = Number(directive[2]) || 256
      let written = 0
      for (let line = 0; written < kib * 1024; line++) {
        const text = `flood ${String(line).padStart(7, '0')} ${'.'.repeat(80)}\r\n`
        process.stdout.write(text)
        written += text.length
      }
      await finish(`flooded ${kib} KiB`)
      return
    }
    if (directive?.[1] === 'compactmid') {
      // An automatic compaction in the middle of a turn: the turn goes on after it and ends once.
      await new Promise((resolve) => setTimeout(resolve, 300))
      compact()
      if (engine === 'claude') await runHooks('SessionStart', { source: 'compact' })
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    if (directive?.[1] === 'hold') return
    if (directive?.[1] === 'permit') {
      const command = directive[2] || 'printf hi'
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      const row = await new Promise((resolve) => { dialog = { kind: 'permit', command, cursor: 0, drawn: 0, resolve }; drawDialog() })
      const allowed = row === 0 || row === 1
      const id = `call_${turn}_p`
      if (allowed) {
        if (engine === 'claude') {
          claude({ type: 'assistant', message: { id: `msg_${turn}_p`, role: 'assistant', model: config.claudeModel ?? 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }], stop_reason: 'tool_use' } })
          claude({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `ran ${command}` }] } })
        } else {
          codex('response_item', { type: 'function_call', call_id: id, name: 'exec_command', arguments: JSON.stringify({ cmd: command }) })
          codex('response_item', { type: 'function_call_output', call_id: id, output: `ran ${command}` })
        }
      }
      await finish(allowed ? `ran ${command}` : `did not run ${command}`)
      return
    }
    if (directive?.[1] === 'ask') {
      // A real engine thinks before it asks; a dialog already on screen when its turn began reads to the
      // daemon as the previous turn's (askQuestion.ts `noteTurnStart`).
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      const choice = await new Promise((resolve) => { dialog = { cursor: 0, drawn: 0, resolve }; drawDialog() })
      if (choice === null) {
        process.stdout.write('\r\n(question cancelled)\r\n')
        await finish('(question cancelled)')
        return
      }
      // The tool call is written once it is answered, as the real CLIs flush it.
      const questions = [{ question: QUESTION, header: 'Drink', multiSelect: false, options: CHOICES.map(([label, description]) => ({ label, description })) }]
      if (engine === 'claude') {
        const id = `toolu_${turn}`
        claude({ type: 'assistant', message: { id: `msg_${turn}_q`, role: 'assistant', model: config.claudeModel ?? 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }], stop_reason: 'tool_use' } })
        claude({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `User has answered your questions: "${QUESTION}"="${choice}"` }] } })
        process.stdout.write(`\r\n⏺ User answered Claude's questions:\r\n  ⎿  · ${QUESTION} → ${choice}\r\n`)
      } else {
        const id = `call_${turn}_q`
        codex('response_item', { type: 'function_call', call_id: id, name: 'request_user_input', arguments: JSON.stringify({ questions }) })
        codex('response_item', { type: 'function_call_output', call_id: id, output: JSON.stringify({ answers: { [QUESTION]: choice } }) })
        process.stdout.write(`\r\n• ${QUESTION} → ${choice}\r\n`)
      }
      await finish(`you chose ${choice}${notes ? ` (notes: ${notes})` : ''}`)
      return
    }
    if (directive?.[1] === 'version') { await finish(versionLine); return }
    if (engine === 'codex' && directive?.[1] === 'goal') {
      bottom = goalBottom(directive[2] === 'done' ? 'Goal achieved (1m)' : 'Pursuing goal (1m)')
      await finish(`answer ${turn}: ${prompt}`)
      return
    }
    if (engine === 'claude' && directive?.[1] === 'transcript') {
      bottom = transcriptBottom(prompt, `answer ${turn}: ${prompt}`)
      await finish(`answer ${turn}: ${prompt}`)
      return
    }
    if (engine === 'codex' && directive?.[1] === 'overlay') {
      bottom = overlayBottom(prompt, `answer ${turn}: ${prompt}`)
      finish(`answer ${turn}: ${prompt}`)
      return
    }
    if (directive?.[1] === 'search') {
      bottom = searchBottom(directive[2] ?? '')
      finish(`answer ${turn}: ${prompt}`)
      return
    }
    if (engine === 'codex' && directive?.[1] === 'browse') {
      // Reached in Codex by Esc twice on an empty composer; the directive goes straight there.
      bottom = directive[2] === 'scrollback' ? pagerBottom(prompt, `answer ${turn}: ${prompt}`) : browsingBottom
      await finish(`answer ${turn}: ${prompt}`)
      return
    }
    if (directive?.[1] === 'slow') await new Promise((resolve) => setTimeout(resolve, Number(directive[2]) || 1000))
    await finish(`answer ${turn}: ${prompt}`)
  }

  // Raw input: bracketed paste brackets the text, Enter (\r) submits, Ctrl-C interrupts.
  process.stdin.setEncoding('utf8')
  let buffer = ''
  let queue = Promise.resolve()
  // Inside a bracketed paste a carriage return or newline is a newline in the prompt, as Ink and
  // ratatui read it; only one typed outside a paste submits. The paste's markers say which.
  let pasting = false
  process.stdin.on('data', (input) => {
    if (dialog) { dialogKeys(input); return }
    let chunk = input
    if (bottom?.transcript) {
      // As Claude Code takes input in its transcript view: its Transcript keys only, where Esc, q and ctrl+c
      // close it; it has no Enter and no paste, so a message is lost there. Keys after the one that closes
      // it reach the prompt.
      let rest = ''
      for (const token of chunk.match(/\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)|\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/g) ?? []) {
        if (!bottom?.transcript) rest += token
        else if (token === '\x1b' || token === 'q' || token === '\x03') { process.stdout.write('\x1b[?1049l'); bottom = null; draw() }
      }
      if (!rest) return
      chunk = rest
    }
    if (bottom?.overlay) {
      // As Codex 0.160 takes input in its transcript overlay: q, ctrl+c or ctrl+t close it, Esc starts
      // browsing prompts in it; a paste is dropped and Enter does nothing, so a message is lost there.
      let rest = ''
      for (const token of chunk.match(/\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)|\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/g) ?? []) {
        if (!bottom?.overlay) rest += token
        else if (token === 'q' || token === '\x03' || token === '\x14') { process.stdout.write('\x1b[?1049l'); bottom = null; draw() }
        else if (token === '\x1b') { bottom = pagerBottom(bottom.prompt, bottom.answer); draw() }
      }
      if (!rest) return
      chunk = rest
    }
    if (bottom?.search) {
      // As each engine takes input while searching its prompt history. A paste and typing extend the
      // search. Claude Code's Enter SENDS the earlier prompt found (2.1.289, historySearch:execute), its Esc
      // puts it in the prompt, its ctrl+c leaves the prompt as it was; Codex's Enter puts the match in the
      // composer (chat_composer/history_search.rs), its Esc and ctrl+c leave the composer as it was.
      let rest = ''
      const leave = (draft) => {
        process.stdout.write('\r\n\x1b[2K\x1b[1A')
        bottom = null
        buffer = draft
        draw(buffer)
      }
      for (const token of chunk.match(/\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)|\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/g) ?? []) {
        if (!bottom?.search) { rest += token; continue }
        const { query, match } = bottom
        if (token.startsWith('\x1b[200~')) { bottom = searchBottom(query + token.slice(6).replace(/\x1b\[201~$/, '')); draw() }
        else if (token === '\r' || token === '\n') {
          if (engine === 'claude') { leave(''); if (query && match) queue = queue.then(() => handle(match)) }
          else leave(match ?? '')
        } else if (token === '\x03') leave('')
        else if (token === '\x1b') leave(engine === 'claude' ? match ?? '' : '')
        else if (token.length === 1 && token >= ' ') { bottom = searchBottom(query + token); draw() }
      }
      if (!rest) return
      chunk = rest
    }
    if (bottom?.browsing) {
      // As Codex 0.160 takes input while browsing (app.rs, app_backtrack): Esc goes back to the composer
      // and Enter reverts the conversation to the prompt in view, in both modes; arrows and hjkl move
      // through the transcript. Anything else, a paste included, leaves the fullscreen browser for the
      // composer it was meant for, while the scrollback pager drops it, so the Enter behind it rewinds.
      let rest = ''
      for (const token of chunk.match(/\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)|\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/g) ?? []) {
        if (!bottom?.browsing) rest += token
        else if (token === '\x1b') leaveBrowsing(false)
        else if (token === '\r' || token === '\n') leaveBrowsing(true)
        else if (/^(?:\x1b\[[ABCD]|[hjkl])$/.test(token) || bottom.pager) continue
        else { leaveBrowsing(false); rest += token }
      }
      if (!rest) return
      chunk = rest
    }
    for (const part of chunk.split(/(\x1b\[20[01]~|\r|\n|\x03)/)) {
      if (part === '\x1b[200~') { pasting = true; continue }
      if (part === '\x1b[201~') { pasting = false; continue }
      if (pasting && (part === '\r' || part === '\n')) { buffer += '\n'; continue }
      if (part === '\x03') {
        if (open) {
          if (engine === 'claude') claude({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })
          else codex('event_msg', { type: 'turn_aborted', turn_id: open })
          open = null
          process.stdout.write('\r\n(interrupted)\r\n')
          draw()
        }
        buffer = ''
      } else if (part === '\r' || part === '\n') {
        const line = buffer
        buffer = ''
        queue = queue.then(() => handle(line))
      } else if (part) {
        buffer += part
        draw(buffer)
      }
    }
  })
  process.on('SIGTERM', () => process.exit(0))
  setInterval(() => {}, 60_000)
}
