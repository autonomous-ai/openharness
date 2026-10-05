// A deterministic stand-in for Claude Code and Codex, run inside a real tmux pane by the daemon
// under test. It behaves the way the daemon depends on the real CLIs behaving, and nothing more:
//
//   - answers `--version` / `--help` probes;
//   - announces its session through the same authenticated hook the real `notify.mjs` uses, from
//     inside the pane (so the daemon's pane/process binding is exercised for real);
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
// mode, and `!browse scrollback` in its scrollback mode, `!exit` ends the process.
// Everything else is echoed as the answer.
//
// Which release is installed is the config's business, so a test can update an engine in place by
// rewriting its wrapper: `version` is what it reports and writes, `without` lists the flags and
// subcommands that release no longer has, and `startDelayMs` is how long it takes, once started, before
// it draws or announces anything (an engine's first run after an update).
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
  /** Whether this engine's own settings carry the daemon's hooks: a moved home has none unless the daemon put them there. */
  const hooksInstalled = () => {
    const file = claudeHome ? join(claudeHome, 'settings.json') : ownCodexHome ? join(ownCodexHome, 'hooks.json') : null
    if (!file) return true
    try { return readFileSync(file, 'utf8').includes('notify.mjs') } catch { return false }
  }
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

  // The port the daemon actually bound, which it saves beside its data (lib/daemonEndpoint.ts) and
  // writes into the hook command it installs: a daemon whose configured port was taken serves another.
  const daemonPort = () => {
    try {
      const { port } = JSON.parse(readFileSync(join(config.dataDir, `daemon-${config.port}.json`), 'utf8'))
      if (Number.isInteger(port) && port > 0) return port
    } catch { /* not bound yet, or bound where it was asked to */ }
    return config.port
  }
  const hook = async (path, body) => {
    if (!hooksInstalled()) return
    const token = readFileSync(join(config.dataDir, 'hook-credential'), 'utf8').trim()
    const pane = process.env.TMUX_PANE
    const response = await fetch(`http://127.0.0.1:${daemonPort()}/api/hook/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-harness-hook-token': token },
      body: JSON.stringify({
        engine, sessionId, transcriptPath: transcript, cwd,
        tmuxPane: pane, runtimeHints: pane ? [{ backend: 'tmux', paneId: pane }] : [], callerPid: process.pid,
        ...body,
      }),
    }).catch((error) => ({ ok: false, status: 0, text: async () => String(error) }))
    // Said in a file, never in the pane. The real hook (hook/notify.mjs) gives up silently and exits 0
    // when the daemon cannot be reached, so the engine draws nothing; this line, printed under the
    // composer while the daemon was stopped, read to the daemon as a draft the person had not sent, and a
    // close waiting for the agent to be idle waited for ever (e2e/ends.e2e.ts).
    if (!response.ok) appendFileSync(join(dirname(config.dataDir), 'fake-engine-hooks.log'), `${new Date().toISOString()} ${engine} ${sessionId} hook ${path} failed: ${response.status}\n`)
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
  await hook('session-start', { hookEvent: resumed ? 'SessionStart' : 'SessionStart', source: resumed ? 'resume' : 'startup' })

  let turn = 0
  let open = null
  // The question dialog `!ask` draws, as the real CLIs draw theirs (the parser's fixtures,
  // src/lib/__fixtures__/question-single.txt and question-codex.txt). Claude takes a digit as the
  // choice; Codex moves its cursor on a digit and takes Enter; Esc cancels either.
  let dialog = null
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
  const dialogKeys = (chunk) => {
    for (const key of chunk.match(/\x1b\[[AB]|\x1b|\r|\n|./gs) ?? []) {
      if (!dialog) return
      const settle = (choice) => { eraseDialog(); const asked = dialog; dialog = null; asked.resolve(choice) }
      const rows = dialog.kind === 'permit' ? 3 : engine === 'claude' ? CHOICES.length : CHOICES.length + 1
      if (dialog.kind === 'permit') {
        // Both CLIs take a row's digit (and Codex its letter) as the decision; Esc declines.
        if (key === '\x1b') settle(null)
        else if (key === 'y' && engine === 'codex') settle(0)
        else if (key === '\r' || key === '\n') settle(dialog.cursor)
        else if (/^[1-3]$/.test(key)) settle(Number(key) - 1)
        continue
      }
      if (key === '\x1b[B') { dialog.cursor = Math.min(dialog.cursor + 1, rows - 1); drawDialog() }
      else if (key === '\x1b[A') { dialog.cursor = Math.max(dialog.cursor - 1, 0); drawDialog() }
      else if (key === '\x1b') settle(null)
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
  const finish = (text) => {
    if (engine === 'claude') {
      claude({ type: 'assistant', message: { id: `msg_${turn}`, role: 'assistant', model: config.claudeModel ?? 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn' } })
    } else {
      codex('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text }], phase: 'final_answer' } })
      codex('event_msg', { type: 'task_complete', turn_id: open, last_agent_message: text })
    }
    process.stdout.write(`\r\n${text}\r\n\r\n`)
    open = null
    draw()
    if (engine === 'claude') void hook('turn-stop', { status: 'ok' })
  }

  const handle = async (raw) => {
    const prompt = raw.trim()
    if (!prompt) { draw(); return }
    if (prompt === '!exit') { process.stdout.write('\x1b[?2004l\r\n'); process.exit(0) }
    if (prompt === '!compact') {
      // `/compact` is a command, not a turn: a summary replaces the history, and Claude Code announces
      // the same session again (SessionStart, source compact), which makes the daemon re-read it.
      compact()
      process.stdout.write('\r\n(compacted)\r\n')
      draw()
      if (engine === 'claude') await hook('session-start', { hookEvent: 'SessionStart', source: 'compact' })
      return
    }
    if (prompt === '!clear') {
      // The old conversation ends (its open turn first), a new id and transcript begin, and the engine
      // says both through its hooks, as the real CLIs do.
      if (open) finish('(interrupted by a new conversation)')
      await hook('session-end', { reason: 'clear' })
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
      await hook('session-start', { hookEvent: 'SessionStart', source: 'clear' })
      return
    }
    if (open) finish('(interrupted by a new prompt)')
    // Claude Code runs its UserPromptSubmit hook on every prompt, through the same door as SessionStart:
    // the catch hook, which re-registers a session whose start-up announcement the daemon missed.
    if (engine === 'claude') await hook('session-start', { hookEvent: 'UserPromptSubmit', prompt })
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
      finish(`flooded ${kib} KiB`)
      return
    }
    if (directive?.[1] === 'compactmid') {
      // An automatic compaction in the middle of a turn: the turn goes on after it and ends once.
      await new Promise((resolve) => setTimeout(resolve, 300))
      compact()
      if (engine === 'claude') await hook('session-start', { hookEvent: 'SessionStart', source: 'compact' })
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
      finish(allowed ? `ran ${command}` : `did not run ${command}`)
      return
    }
    if (directive?.[1] === 'ask') {
      // A real engine thinks before it asks; a dialog already on screen when its turn began reads to the
      // daemon as the previous turn's (askQuestion.ts `noteTurnStart`).
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      const choice = await new Promise((resolve) => { dialog = { cursor: 0, drawn: 0, resolve }; drawDialog() })
      if (choice === null) {
        process.stdout.write('\r\n(question cancelled)\r\n')
        finish('(question cancelled)')
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
      finish(`you chose ${choice}`)
      return
    }
    if (directive?.[1] === 'version') { finish(versionLine); return }
    if (engine === 'codex' && directive?.[1] === 'goal') {
      bottom = goalBottom(directive[2] === 'done' ? 'Goal achieved (1m)' : 'Pursuing goal (1m)')
      finish(`answer ${turn}: ${prompt}`)
      return
    }
    if (engine === 'codex' && directive?.[1] === 'browse') {
      // Reached in Codex by Esc twice on an empty composer; the directive goes straight there.
      bottom = directive[2] === 'scrollback' ? pagerBottom(prompt, `answer ${turn}: ${prompt}`) : browsingBottom
      finish(`answer ${turn}: ${prompt}`)
      return
    }
    if (directive?.[1] === 'slow') await new Promise((resolve) => setTimeout(resolve, Number(directive[2]) || 1000))
    finish(`answer ${turn}: ${prompt}`)
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
