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
// open until the next prompt, `!holdtool <command>` leaves it open with that tool still running (an
// interrupt then writes the tool's aborted output before the turn's end, as the CLIs do), `!ask` asks the person which drink they would like in the engine's own
// dialog and answers with their choice, `!permit <command>` asks permission to run a command the way
// the engine does and runs it only if allowed, `!flood <KiB>` prints that much to the terminal, in
// numbered lines, the way a build log or a long diff does, `!clear` starts a new conversation in the
// same pane as Claude Code's `/clear` and Codex's `/new` do, `!compact` compacts the conversation as
// `/compact` does (a real `/compact` (Claude Code) is written exactly as Claude Code writes it, with no turn) (and Claude Code then announces the same session again), `!goalloop <condition>`
// (Claude Code) works on after its first stop because the /goal hook refused it (`!goalpause <condition>`:
// refused, and the goal paused with no further output), `!compactmid` compacts in the
// middle of a turn as an automatic compaction does, `!version` answers with the version this
// process is, `!goal` and `!goal done` (Codex) start and achieve a goal the way Codex 0.160 shows one
// under its composer, `!browse` (Codex) leaves Codex browsing its transcript in its default fullscreen
// mode, and `!browse scrollback` in its scrollback mode, `!transcript` (Claude Code) leaves it in its
// transcript view, as ctrl+o does, `!overlay` (Codex) in its transcript overlay, as ctrl+t does in its
// scrollback mode, `!search` searching its prompt history, as ctrl+r does, `!config` (Claude Code) in its
// settings and `!center` (Codex) in its agent command center, screens the daemon has no name for,
// `!permitnext <command>` keeps its turn open and asks permission to run the command the moment a
// message is pasted, before its Enter (a request arriving mid-turn), `!exit` ends the process.
// Everything else is echoed as the answer. Codex's `/model` is not a prompt: it opens 0.160's model
// picker over the `models_cache.json` in its CODEX_HOME, and a choice in it is applied to the turns
// that follow (see `openModelPicker`).
//
// Which release is installed is the config's business, so a test can update an engine in place by
// rewriting its wrapper: `version` is what it reports and writes, `without` lists the flags and
// subcommands that release no longer has, `updateAvailable` (Codex) names a newer release it asks to update
// to before it starts, and `startDelayMs` is how long it takes, once started, before
// it draws or announces anything (an engine's first run after an update). `firstHookDelayMs` is how long
// its first SessionStart takes to reach the daemon once the engine is up: the hook command starting on a
// loaded machine, while the daemon has already found the engine and its conversation. `root` is the
// test's throwaway root, the only place whose hooks it will run, and `hookLog` where it notes every hook
// it ran. `trustPrompt` makes it ask whether to trust a folder its own config has no answer for. Codex
// refuses to resume a conversation it archived, as the real one does.
//
// Ctrl+Z suspends it, as both CLIs do on Unix (Claude Code 2.1.289: "Claude Code has been suspended.
// Run `fg` to bring Claude Code back."; Codex 0.160: "`ctrl-z` is reserved for suspending the terminal
// on Unix"): it gives the terminal back and stops its whole process group with SIGTSTP. Continued from
// that stop it takes the terminal again; continued from any stop it repaints, and nothing more.
//
// Codex runs as npm installs it: a Node wrapper, the command the pane starts, with the engine as its
// child in the same process group and terminal (`codexWrapper`).
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

/** What the npm wrapper hands its child, the Codex engine itself: this module, run as a script. */
const CODEX_NATIVE = 'HARNESS_FAKE_CODEX_NATIVE'

/**
 * `@openai/codex`'s bin/codex.js (0.160.0): it starts the native binary as its child with the same
 * terminal, process group and arguments, forwards SIGINT, SIGTERM and SIGHUP to it, and ends as the
 * child ended — re-raising a signal the child died of, which ends the wrapper with that signal unless
 * it is one the wrapper listens for (then the wrapper exits 0).
 */
async function codexWrapper(config) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, [CODEX_NATIVE]: JSON.stringify(config) },
  })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { try { child.kill(signal) } catch { /* gone */ } })
  const ended = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  if (ended.signal) process.kill(process.pid, ended.signal)
  else process.exit(ended.code ?? 1)
}

export async function run(engine, config = {}, { native = false } = {}) {
  if (engine === 'codex' && !native) return codexWrapper(config)
  const args = process.argv.slice(2)
  if (engine === 'codex' && args[0] === 'app-server' && args[1] === 'proxy') {
    // Found by QA on a quiet machine: moved-home close/activity must reach that home's shared server.
    // Real Codex proxy carries raw WebSocket bytes and fails when the profile has no server; it starts none.
    const home = process.env.CODEX_HOME || config.codexHome
    if (!within(config.root, home)) throw new Error('fake Codex proxy outside its throwaway home')
    const { port } = JSON.parse(readFileSync(join(home, 'app-server-daemon', 'fake-proxy.json'), 'utf8'))
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid fixture server port')
    const { createConnection } = await import('node:net')
    const socket = createConnection({ host: '127.0.0.1', port })
    process.stdin.pipe(socket).pipe(process.stdout)
    socket.on('error', () => process.exit(1))
    socket.on('close', () => process.exit(0))
    return
  }
  const version = config.version ?? (engine === 'claude' ? '2.1.270' : '0.160.0')
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
  // The process table shows it as it shows the real CLI: named `claude` or `codex`, with the command line
  // it was started with, both of which discovery reads (tmux.ts: a resume typed into a pane names its
  // conversation on that command line). The title used to be the name alone, so no argument was ever on
  // the command line discovery read. The name is padded to the 16 columns macOS's `ps` gives a name in a
  // table, so the arguments are not read as part of it; a control character is shown as `ps` shows one.
  process.title = [engine.padEnd(16), ...args].join(' ').replace(/[\x00-\x1f\x7f]/g, '?')
  // Raw at once, as the real CLIs are (Ink and ratatui take the terminal before they draw anything): a
  // terminal still in line mode keeps at most 1 KiB of a line, so a paste that arrived before the
  // engine was ready lost the rest of itself (measured: 1,018 of 2,406 characters).
  process.stdin.setRawMode?.(true)
  // Slow to start, as an engine is on its first run after an update: the process is there and holds
  // the terminal, and nothing is drawn, announced or read until it is ready.
  // October 6 sibling-conversation incident: hold startup before this process has a transcript, while
  // another process in the same folder writes its own. Only the disposable fixture can release it.
  if (config.startupGate) {
    if (!within(config.root, config.startupGate)) throw new Error('startup gate outside its throwaway home')
    writeFileSync(`${config.startupGate}.waiting`, String(process.pid))
    const deadline = performance.now() + 60_000
    while (!existsSync(`${config.startupGate}.release`)) {
      if (performance.now() > deadline) throw new Error('startup gate was not released')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  if (config.startDelayMs) await new Promise((resolve) => setTimeout(resolve, config.startDelayMs))
  // A newer release out (`updateAvailable`): Codex 0.160 asks first, before its session starts
  // (update_prompt.rs, snapshot `update_prompt_modal`). It drops a paste; Enter takes the highlighted row,
  // `Update now`, runs the update and asks to be restarted; Esc, 2 or ctrl+c skip it.
  if (engine === 'codex' && config.updateAvailable) {
    process.stdout.write(`\r\n  \x1b[1mUpdate available\x1b[0m\x1b[2m · \x1b[0m${version} → ${config.updateAvailable}\r\n`
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
  // Beside the daemon's data folder when a wrapper names no log, as IsolatedDaemon's would be: a refusal
  // must reach the harness, which fails the test on it, from a wrapper a test wrote by hand as well.
  const hookLogFile = config.hookLog ?? (config.dataDir ? join(dirname(config.dataDir), 'fake-engine-hooks.log') : null)
  const hookLog = (line) => {
    if (!hookLogFile) return
    try { appendFileSync(hookLogFile, `${new Date().toISOString()} ${engine} pid=${process.pid} ${line}\n`) } catch { /* a note, never a failure */ }
  }
  if (!config.root || !within(config.root, hookSettingsFile)) {
    hookLog(config.root ? `REFUSED hooks outside the test root: ${hookSettingsFile}` : `REFUSED hooks: the wrapper names no test root (use IsolatedDaemon.engineConfig)`)
    process.stderr.write(`[fake ${engine}] refusing to run the hooks in ${hookSettingsFile}: outside the test root ${config.root ?? '(none given)'}\r\n`)
    process.exit(78)
  }
  const hookSettings = (() => {
    try {
      const parsed = JSON.parse(readFileSync(hookSettingsFile, 'utf8'))
      return parsed && typeof parsed.hooks === 'object' && parsed.hooks ? parsed.hooks : {}
    } catch { return {} }
  })()
  // A conversation Codex archived (its rollout moved to `archived_sessions/`) is not resumed: Codex
  // refuses before its TUI is up (codex-rs app-server thread_processor.rs) until `codex unarchive <id>`
  // moves it back under `sessions/`.
  if (engine === 'codex' && resumed && !fork) {
    const holds = (dir) => {
      let names = []
      try { names = readdirSync(dir, { withFileTypes: true }) } catch { return false }
      return names.some((entry) => entry.isDirectory() ? holds(join(dir, entry.name)) : entry.name.startsWith('rollout-') && entry.name.endsWith(`-${resumed}.jsonl`))
    }
    if (!holds(join(codexHome, 'sessions')) && holds(join(codexHome, 'archived_sessions'))) {
      process.stderr.write(`Error: session ${resumed} is archived. Run \`codex unarchive ${resumed}\` to unarchive it first.\n`)
      process.exit(1)
    }
  }
  // Asking whether to trust the folder (`trustPrompt`), before any conversation starts, as both CLIs
  // ask in a folder they have no answer for, reading the answer from their own config: Claude Code's
  // `projects[<folder or one above it>].hasTrustDialogAccepted` in `.claude.json` in CLAUDE_CONFIG_DIR,
  // else the home folder (2.1.290: `join(CLAUDE_CONFIG_DIR || homedir(), '.claude.json')`); Codex's
  // `[projects."<folder>"] trust_level = "trusted"` in its CODEX_HOME's config.toml (0.160:
  // onboarding/directory_trust.rs, whatever the permission flags). Enter or 1 trusts and saves it as they
  // do; Esc, 2 or ctrl+c quits. Off unless a test asks: the real ones also skip folders this models
  // nothing of (Codex a folder outside any project, Claude Code a sandbox), and the daemon answers the
  // question only for folders it made empty (lib/claudeTrust.ts).
  if (config.trustPrompt) {
    const trustFile = engine === 'claude' ? join(claudeHome ?? homedir(), '.claude.json') : join(codexHome, 'config.toml')
    const trusted = (() => {
      let text = ''
      try { text = readFileSync(trustFile, 'utf8') } catch { return false }
      if (engine === 'codex') {
        const at = text.indexOf(`[projects.${JSON.stringify(cwd)}]`)
        return at >= 0 && /^trust_level\s*=\s*"trusted"/m.test(text.slice(at).split(/\n\[/)[0])
      }
      try {
        const projects = JSON.parse(text).projects ?? {}
        return Object.entries(projects).some(([key, entry]) => entry?.hasTrustDialogAccepted === true
          && (cwd === key.replace(/\/+$/, '') || cwd.startsWith(`${key.replace(/\/+$/, '')}/`)))
      } catch { return false }
    })()
    if (!trusted) {
      process.stdout.write(engine === 'claude'
        ? `\r\n Accessing workspace:\r\n\r\n ${cwd}\r\n\r\n Quick safety check: Is this a project you created or one you trust?\r\n\r\n`
          + ' \x1b[36m❯ 1. Yes, I trust this folder\x1b[39m\r\n   2. No, exit\r\n\r\n Enter to confirm · Esc to cancel\r\n'
        : `\r\n> You are in ${cwd}\r\n\r\n  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.\r\n\r\n`
          + '\x1b[36m› 1. Trust and continue\x1b[39m\r\n  2. Quit\r\n\r\n  enter\x1b[2m continue · \x1b[0mesc\x1b[2m quit\x1b[0m\r\n')
      const trust = await new Promise((resolve) => {
        const keys = (chunk) => {
          for (const token of String(chunk).match(/\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)|\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/g) ?? []) {
            if (token === '\r' || token === '\n' || token === '1') { process.stdin.off('data', keys); resolve(true); return }
            if (token === '\x1b' || token === '2' || token === '\x03') { process.stdin.off('data', keys); resolve(false); return }
          }
        }
        process.stdin.on('data', keys)
      })
      if (!trust) process.exit(1)
      if (engine === 'codex') appendFileSync(trustFile, `\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`)
      else {
        let saved = {}
        try { saved = JSON.parse(readFileSync(trustFile, 'utf8')) } catch { /* none yet */ }
        writeFileSync(trustFile, JSON.stringify({ ...saved, projects: { ...saved.projects, [cwd]: { ...saved.projects?.[cwd], hasTrustDialogAccepted: true } } }))
      }
      process.stdout.write('\x1b[H\x1b[2J')
    }
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

  // What the CLI says about its permission mode in an event, read off its own argv as it reads it.
  const permissionMode = engine === 'claude'
    ? (args.includes('--dangerously-skip-permissions') ? 'bypassPermissions'
      : args.includes('--permission-mode') ? args[args.indexOf('--permission-mode') + 1] ?? 'default' : 'default')
    : (args.includes('--dangerously-bypass-approvals-and-sandbox') ? 'bypassPermissions' : 'default')
  // The model and effort the thread runs on: what Codex writes in each turn's context, and what its
  // `/model` picker changes (below). Its `-m`/`--model` on the command line outranks the configured one, as
  // in the real CLI: that is how a relaunch puts an agent back on the model it had before a grid
  // (subscriptionModel.ts).
  const modelAt = engine === 'codex' ? args.findIndex((arg) => arg === '-m' || arg === '--model') : -1
  let current = { model: (modelAt >= 0 && args[modelAt + 1]) || config.codexModel || 'gpt-6', effort: 'high' }
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
    ...(engine === 'codex' ? { model: current.model, permission_mode: permissionMode } : {}),
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
  // The composer, as both CLIs keep it: the bottom of the screen, holding what is being typed and nothing
  // else. Enter takes the prompt off it at once and into the conversation; the turn's output is written
  // above it, and it is drawn again below. The fake used to leave a submitted prompt on its composer line
  // until the answer came, which the daemon reads as a draft never sent: it pressed Enter again for it
  // (sessionInput.ts) whenever the turn was slow to start, as one is behind its UserPromptSubmit hook.
  //
  // Drawn as each engine draws its own, as the daemon reads it to know a message can be typed there
  // (lib/composerScreen.ts): Claude Code 2.1.289's box ruled above and below (its `borderStyle: "round"`
  // with no sides), `❯` and the prompt or a dim example in it, and its footer row under the box
  // (`? for shortcuts` while the prompt is empty); Codex 0.160's blank row, bold `›` and the draft or its
  // dim placeholder, a blank row, and its status line (tui/src/bottom_pane, snapshot `empty`). A draft's
  // further lines are indented under the first.
  let buffer = ''
  let composerRows = 0
  // What else is drawn there (`bottom`): Codex's footer pursuing a goal (on the right of its status line),
  // the footer of its transcript browser with the composer dimmed whole, a search through the prompt
  // history (the match in the composer, the search under it), a screen of the engine's own in the
  // composer's place (`screen`), and the screens drawn over the whole pane instead (`pager`, on the
  // alternate screen): Codex's transcript browser and overlay in its scrollback mode, Claude Code's
  // transcript view.
  let bottom = null
  let dialog = null
  // Codex's `/model` picker while it is open, in the composer's place (see `openModelPicker`).
  let picker = null
  const columns = () => Math.max(20, process.stdout.columns || 80)
  // Cut to the pane's width, as Codex fits its status line to one row. It names the model and effort the
  // thread runs on, which `/model` changes.
  const statusLine = () => `  \x1b[2m${`${current.model} ${current.effort} · ${cwd}`.slice(0, columns() - 3)}\x1b[0m`
  const goalBottom = (goal) => ({ footer: `  ${current.model} ${current.effort} · ${cwd}   \x1b[35m${goal}\x1b[0m` })
  const browsingFooter = '\x1b[36mBrowsing transcript\x1b[0m\x1b[2m · \x1b[0m↑↓/jk\x1b[2m scroll · \x1b[0m←→/hl\x1b[2m prompts · \x1b[0m↵\x1b[2m rewind · \x1b[0mesc\x1b[2m back\x1b[0m'
  const browsingBottom = { dim: true, footer: browsingFooter, browsing: true }
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
  // Screens of the engines' own, drawn in the composer's place, that the daemon has no name for: Claude
  // Code's settings (/config, 2.1.289: its Settings tabs, `Search settings…`, and its rows, where Enter
  // and Space change the highlighted setting) and Codex's agent command center (0.160, snapshot
  // `agents_overview_recent_sessions`, where Enter opens the highlighted task). Esc closes either.
  const SETTINGS = [['Auto-compact', 'true'], ['Show tips', 'true'], ['Thinking mode', 'true']]
  const configScreen = () => {
    const state = { query: '', config: true }
    state.screen = () => {
      const rows = SETTINGS.filter(([name]) => name.toLowerCase().includes(state.query.toLowerCase()))
      return [`\x1b[38;5;153m${'─'.repeat(columns())}\x1b[39m`,
        ' \x1b[1m\x1b[38;5;153mSettings:\x1b[0m  \x1b[7m Status \x1b[0m  Config   Usage   \x1b[2m(←/→ or tab to cycle)\x1b[0m', '',
        ` ⌕ ${state.query || '\x1b[2mSearch settings…\x1b[0m'}`, '',
        ...rows.map(([name, value], index) => `${index === 0 ? ' \x1b[38;5;153m❯\x1b[39m' : '  '} ${name.padEnd(40)}${value}`),
        '', ' \x1b[2m\x1b[3mEnter/Space to change · Esc to close\x1b[0m']
    }
    return state
  }
  const centerScreen = () => ({ center: true, screen: () => [
    '  Agent command center  Group: Project  g',
    '   All 2   Needs you 0   Working 0   Ready 0   Inactive 2',
    `  ${'─'.repeat(Math.max(10, columns() - 4))}`,
    '      Tasks                                            Status         Updated',
    '  /  2',
    '  › ○ Task 2                                           Inactive 1m',
    '    ○ Task 1                                           Inactive 2m',
    '', '  ? help  esc back  ↑/↓ move  enter open  n new'] })
  // The prompts sent so far, newest last, which a search through the prompt history (ctrl+r) looks in.
  const history = []
  // Searching them, as each engine draws it: the match in the composer, and Claude Code's
  // `search prompts: …` (or `no matching prompt: …`) or Codex's `reverse-i-search: …` under it.
  const searchBottom = (query) => {
    const match = query ? history.findLast((sent) => sent.toLowerCase().includes(query.toLowerCase())) ?? null : null
    const footer = engine === 'claude'
      ? `  \x1b[2m${query && !match ? 'no matching prompt:' : 'search prompts:'}\x1b[0m ${query}`
      : `  \x1b[2mreverse-i-search: \x1b[0m${query}  \x1b[2menter accept · esc cancel\x1b[0m`
    return { search: true, query, match, text: match ?? '', footer }
  }
  // The suggestions each engine opens while a `/command` or an `@mention` is typed at the end of the
  // draft, until Esc puts them away: Claude Code's under its box, in its footer's place, padded to six rows
  // and the highlighted one coloured (2.1.289, `Kge`); Codex's above its composer, the `/command` list
  // (snapshot `slash_popup_footer_wide`) or the mention menu (`default_unified_mention_popup`).
  const COMMANDS = [['/model', 'Set the AI model'], ['/memory', 'Edit memory files'], ['/mcp', 'Manage MCP servers'], ['/compact', 'Compact the conversation']]
  const FILES = ['README.md', 'src/index.ts', 'src/login.ts']
  let dismissed = null
  const suggestions = (text) => {
    const token = text.split(/\s/).at(-1) ?? ''
    if (bottom || token === dismissed || !/^[/@]/.test(token)) return null
    const found = token.startsWith('/')
      ? COMMANDS.filter(([name]) => name.startsWith(token))
      : FILES.filter((file) => file.startsWith(token.slice(1))).map((file) => [file, ''])
    return found.length ? { token, found } : null
  }
  const popupRows = (popup) => {
    if (engine === 'claude') {
      const rows = popup.found.map(([name, description], index) => `  ${index === 0 ? '\x1b[38;5;153m' : ''}${name.padEnd(16)}${description}${index === 0 ? '\x1b[39m' : ''}`)
      return [...Array(Math.max(0, 6 - rows.length)).fill(''), ...rows]
    }
    if (popup.token.startsWith('/')) {
      return [...popup.found.map(([name, description], index) => index === 0
        ? `\x1b[1;7m› ${name.padEnd(9)}\x1b[22m ${description}\x1b[0m`
        : `  \x1b[1m${name.padEnd(9)}\x1b[0m \x1b[2m${description}\x1b[0m`), '']
    }
    return ['  Mentions', '   All Results   Filesystem Only   Plugins', `  ${popup.token.slice(1)}`,
      ...popup.found.map(([file], index) => `${index === 0 ? '›' : ' '} ${file}`),
      '  enter/tab insert · esc close · ↑/↓ select · ←/→ filter', '']
  }
  /** The rows of the pane a row of text takes, wide (CJK, emoji) characters taking two columns. */
  const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u
  const rowsOf = (row) => {
    let width = 0
    for (const char of row.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')) width += WIDE.test(char) ? 2 : 1
    return Math.max(1, Math.ceil(width / columns()))
  }
  // A draft's lines wrapped to the composer, as both engines wrap theirs, two columns in from the edge
  // where their prompt glyph stands: every row after the first is indented under the text.
  const wrapDraft = (text) => text.split('\n').flatMap((line) => {
    const rows = []
    let row = ''
    let width = 0
    for (const char of line) {
      const w = WIDE.test(char) ? 2 : 1
      if (width + w > columns() - 3) { rows.push(row); row = ''; width = 0 }
      row += char
      width += w
    }
    return [...rows, row]
  })
  /** What the composer draws, row by row. */
  const composerLines = () => {
    if (bottom?.screen) return bottom.screen()
    const text = bottom?.text ?? buffer
    const [first = '', ...more] = wrapDraft(text)
    const rest = more.map((row) => `  ${row}`)
    if (engine === 'claude') {
      const rule = `\x1b[38;5;244m${'─'.repeat(columns())}\x1b[39m`
      const input = text ? `\x1b[39m❯ ${first}` : '\x1b[39m❯ \x1b[2mTry "fix lint errors"\x1b[0m'
      const popup = suggestions(text)
      return [rule, input, ...rest, rule, ...(popup ? popupRows(popup) : [bottom?.footer ?? (text ? '' : '  \x1b[2m? for shortcuts\x1b[0m')])]
    }
    const input = bottom?.dim ? '\x1b[2m› Ask Codex to do anything\x1b[0m'
      : text ? `\x1b[1m›\x1b[0m ${first}` : '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m'
    const popup = suggestions(text)
    return [...(popup ? popupRows(popup) : ['']), input, ...rest, '', bottom?.footer ?? statusLine()]
  }
  /** Clears the composer and what is drawn under it, leaving the cursor where it began. */
  const eraseComposer = () => {
    process.stdout.write(`${composerRows > 1 ? `\x1b[${composerRows - 1}A` : ''}\r\x1b[0J`)
    composerRows = 0
  }
  const drawComposer = () => {
    if (bottom?.pager) { process.stdout.write(bottom.pager); composerRows = 0; return }
    // A dialog takes the composer's place, as the CLIs draw theirs, until it is answered; so does Codex's
    // model picker, until a choice or Esc closes it.
    if (dialog || picker) return
    const rows = composerLines()
    process.stdout.write(rows.join('\r\n'))
    composerRows = rows.reduce((sum, row) => sum + rowsOf(row), 0)
  }
  const draw = () => { eraseComposer(); drawComposer() }
  /** The conversation, written above the composer, or above Codex's model picker while it is open, as
   *  its history cells are. `text` ends at the start of a line. */
  const say = (text) => {
    if (picker) { erasePicker(); process.stdout.write(text); drawPicker(); return }
    eraseComposer(); process.stdout.write(text); drawComposer()
  }
  // A resize redraws the whole frame, as the TUIs do: the composer measured at the old width cannot be
  // taken back row by row.
  process.stdout.on?.('resize', () => {
    if (bottom?.pager || dialog || picker) return
    process.stdout.write('\x1b[H\x1b[2J')
    composerRows = 0
    drawComposer()
  })
  // Out of the browser, back to the composer: the pager's alternate screen left, or the dimmed composer
  // and its footer redrawn. Enter rewinds on the way out.
  const leaveBrowsing = (rewound) => {
    if (bottom.pager) { process.stdout.write('\x1b[?1049l'); bottom = null }
    else { eraseComposer(); bottom = null; composerRows = 0 }
    if (rewound) say('(rewound to an earlier prompt)\r\n')
    else draw()
  }
  process.stdout.write(`\x1b[?2004h${engine === 'claude' ? '✻ Welcome to Claude Code (fake)' : '>_ OpenAI Codex (fake)'}\r\n`)
  process.stdout.write(`  session ${sessionId}${resumed ? ' (resumed)' : ''}\r\n\r\n`)
  drawComposer()
  if (config.firstHookDelayMs && !resumed) await new Promise((resolve) => setTimeout(resolve, config.firstHookDelayMs))
  await runHooks('SessionStart', { source: resumed ? 'resume' : 'startup' })

  let turn = 0
  let open = null
  // The tool `!holdtool` left running: an interrupt flushes its output, marked aborted, before the turn ends.
  let runningTool = null
  // The question dialog `!ask` draws, as the real CLIs draw theirs (the parser's fixtures,
  // src/lib/__fixtures__/question-single.txt and question-codex.txt). Claude takes a digit as the
  // choice; Codex moves its cursor on a digit and takes Enter; Esc cancels either.
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
      const settle = (choice) => { eraseDialog(); const asked = dialog; dialog = null; notes = asked.notes ?? ''; drawComposer(); asked.resolve(choice) }
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
  // Codex 0.160's `/model` picker (tui/src/chatwidget/model_popups.rs, luna_reserve_model.rs,
  // model_popup_state.rs, bottom_pane/list_selection_view.rs at rust-v0.160.0), drawn as it draws it
  // and driven by the keys it takes. The quick menu of auto presets with `All models`, or the full list
  // when there are none; the chosen model's reasoning picker; Advanced Reasoning for Max and Ultra; and,
  // for a thread on the reserve model, the one-row picker that lends it an ordinary model's efforts.
  // Rows are the catalog's display names, from `models_cache.json` in this engine's CODEX_HOME. A digit
  // selects its row and accepts it, arrows move, Enter accepts, `s` takes the row for this session only,
  // Esc goes back a screen. A choice is applied with Codex's `thread_settings_applied` record.
  //
  // The list is redrawn in place when "the server" answers, as 0.160 refreshes it from the models
  // endpoint once it is open: `fake-models-server.json` beside the cache (`{ delayMs, models }`) is that
  // answer. Its models replace the cache's, are saved to `models_cache.json`, and renumber an open list,
  // its highlight kept on the same model, while a reasoning screen open over it stays as it is.
  const LUNA_RESERVE_MODEL = 'gpt-reserve'
  const LUNA_MODEL = 'gpt-6-luna'
  const ADVANCED = new Set(['max', 'ultra'])
  const EFFORT_LABELS = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra', persistent: 'Persistent' }
  const effortLabel = (effort) => EFFORT_LABELS[effort] ?? effort
  const MAX_POPUP_ROWS = 8
  const modelsCacheFile = join(codexHome, 'models_cache.json')
  const modelsServerFile = join(codexHome, 'fake-models-server.json')
  const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }
  /** The presets the picker lists, as Codex builds them from its catalog (models-manager
   *  `build_available_models`): by priority, the first listed one the default. */
  const presetsOf = (models) => {
    const presets = (Array.isArray(models) ? models : []).filter((model) => model?.slug)
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .map((model) => ({
        model: model.slug, displayName: model.display_name || model.slug, description: model.description ?? '',
        defaultEffort: model.default_reasoning_level ?? 'none', listed: model.visibility === 'list', isDefault: false,
        efforts: (model.supported_reasoning_levels ?? []).map((level) => ({ effort: level.effort, description: level.description ?? '' })),
      }))
    const first = presets.find((preset) => preset.listed) ?? presets[0]
    if (first) first.isDefault = true
    return presets
  }
  const isAuto = (slug) => slug.startsWith('codex-auto-')
  const autoOrder = (slug) => ({ 'codex-auto-fast': 0, 'codex-auto-balanced': 1, 'codex-auto-thorough': 2 })[slug] ?? 3
  const requiresAdvanced = (preset) => ADVANCED.has(preset.defaultEffort) || preset.efforts.some((option) => ADVANCED.has(option.effort))
  /** The effort a full-list row applies at once: its one ordinary effort, or none to choose. */
  const directEffort = (preset) => {
    const choices = preset.efforts.length ? preset.efforts.map((option) => option.effort) : [preset.defaultEffort]
    return choices.length === 1 && !ADVANCED.has(choices[0]) ? choices[0] : null
  }
  /** Words to lines of at most `width`, as ratatui wraps them; a word longer than a line is cut. */
  const wrapWords = (text, width) => {
    const lines = []
    let line = ''
    for (const word of String(text).split(/\s+/).filter(Boolean)) {
      let next = line ? `${line} ${word}` : word
      if (line && next.length > width) { lines.push(line); next = word }
      while (next.length > width) { lines.push(next.slice(0, width)); next = next.slice(width) }
      line = next
    }
    lines.push(line)
    return lines
  }
  /** One screen of the picker, as list_selection_view.rs renders it: header, two blank lines, the rows
   *  (eight at most, scrolled to the highlight), a blank line and the key hints. */
  const renderView = (view) => {
    const cols = Math.max(20, process.stdout.columns || 80)
    const lines = []
    for (const { text, style } of view.header) {
      for (const part of wrapWords(text, cols - 2)) lines.push(`  ${style}${part}${style ? '\x1b[0m' : ''}`)
    }
    lines.push('', '')
    const label = (item) => `${item.name}${item.current ? ' (current)' : item.isDefault ? ' (default)' : ''}`
    const prefixOf = (index) => `${index === view.selected ? '›' : ' '} ${index + 1}. `
    const nameWidth = Math.max(...view.items.map((item, index) => prefixOf(index).length + label(item).length))
    const descriptionColumn = nameWidth + 2
    // The picker's `HideWhenNarrow`: no descriptions when fewer than 24 columns are left for them.
    const descriptions = cols - descriptionColumn >= 24
    if (view.selected < view.top) view.top = view.selected
    if (view.selected >= view.top + MAX_POPUP_ROWS) view.top = view.selected - MAX_POPUP_ROWS + 1
    view.items.slice(view.top, view.top + MAX_POPUP_ROWS).forEach((item, offset) => {
      const index = view.top + offset
      const prefix = prefixOf(index)
      const selected = index === view.selected
      const rows = descriptions && item.description
        ? wrapWords(item.description, cols - descriptionColumn).map((part, line) => line === 0
          ? `${prefix}${label(item).padEnd(descriptionColumn - prefix.length)}${selected ? part : `\x1b[2m${part}\x1b[0m`}`
          : `${' '.repeat(descriptionColumn)}${selected ? part : `\x1b[2m${part}\x1b[0m`}`)
        : wrapWords(label(item), cols - prefix.length).map((part, line) => `${line === 0 ? prefix : ' '.repeat(prefix.length)}${part}`)
      for (const row of rows) lines.push(selected ? `\x1b[36m${row}\x1b[39m` : row)
    })
    lines.push('')
    const highlighted = view.items[view.selected]
    lines.push(highlighted?.secondary
      ? `  enter\x1b[2m ${highlighted.applies ?? 'default'} · \x1b[0ms\x1b[2m session · \x1b[0mesc\x1b[2m back\x1b[0m`
      : '  enter\x1b[2m select · \x1b[0mesc\x1b[2m back\x1b[0m')
    return lines
  }
  const erasePicker = () => {
    if (picker?.drawn) process.stdout.write(`\x1b[${picker.drawn}A\r\x1b[0J`)
    if (picker) picker.drawn = 0
  }
  const drawPicker = () => {
    erasePicker()
    const lines = renderView(picker.stack.at(-1))
    process.stdout.write(`${lines.join('\r\n')}\r\n`)
    picker.drawn = lines.length
  }
  const closePicker = () => { erasePicker(); picker = null; drawComposer() }
  /** Applies a model and effort to the thread, as Codex does once a choice is accepted: the settings
   *  update its app server answers with `thread_settings_applied` (protocol.rs `ThreadSettingsAppliedEvent`). */
  const applyChoice = (model, effort) => {
    current = { model, effort }
    codex('event_msg', {
      type: 'thread_settings_applied',
      thread_id: sessionId,
      thread_settings: {
        model, model_provider_id: 'openai', approval_policy: 'on-request', cwd, runtime_workspace_roots: [cwd],
        reasoning_effort: effort, collaboration_mode: { mode: 'default', settings: { model, reasoning_effort: effort } },
      },
    })
    closePicker()
  }
  const view = (id, header, items, selected = items.findIndex((item) => item.current)) =>
    ({ id, header, items, selected: Math.max(0, selected), top: 0 })
  const title = (text) => ({ text, style: '\x1b[1m' })
  const subtitle = (text) => ({ text, style: '\x1b[2m' })
  /** The reasoning picker for a preset, or the choice applied at once when it has one ordinary effort. */
  const openReasoning = (preset) => {
    const choices = preset.efforts.length ? preset.efforts.map((option) => option.effort) : [preset.defaultEffort]
    const ordinary = choices.filter((effort) => !ADVANCED.has(effort))
    const advanced = choices.filter((effort) => ADVANCED.has(effort))
    if (ordinary.length === 1 && !advanced.length) { applyChoice(preset.model, ordinary[0]); return }
    const defaultChoice = ordinary.includes(preset.defaultEffort) ? preset.defaultEffort : null
    const onModel = current.model === preset.model
    const highlight = onModel ? current.effort : defaultChoice ?? ordinary[0]
    const describe = (effort) => preset.efforts.find((option) => option.effort === effort)?.description ?? ''
    const items = ordinary.map((effort) => ({
      name: `${effortLabel(effort)}${effort === defaultChoice ? ' (default)' : ''}`, description: describe(effort),
      current: onModel && effort === highlight, accept: () => applyChoice(preset.model, effort),
      secondary: preset.model === LUNA_RESERVE_MODEL ? null : () => applyChoice(preset.model, effort),
    }))
    if (advanced.length) {
      items.push({
        name: 'More reasoning…', description: `${advanced.map(effortLabel).join(' and ')} ${advanced.length === 1 ? 'consumes' : 'consume'} usage limits faster`,
        current: onModel && ADVANCED.has(highlight), accept: () => openAdvanced(preset),
      })
    }
    const selected = items.findIndex((item, index) => index < ordinary.length && ordinary[index] === highlight)
    picker.stack.push(view('reasoning', [title(`Select Reasoning Level for ${preset.displayName}`)], items, selected))
    drawPicker()
  }
  const openAdvanced = (preset) => {
    const choices = preset.efforts.map((option) => option.effort).filter((effort) => ADVANCED.has(effort))
      .sort((a, b) => (a === 'ultra') - (b === 'ultra'))
    const items = choices.map((effort) => ({
      name: effortLabel(effort),
      description: effort === 'max' ? 'For difficult problems when quality matters more than speed · higher usage' : 'For demanding work using multiple agents · highest usage',
      current: current.model === preset.model && current.effort === effort, applies: effort === 'ultra' ? 'apply' : 'default',
      accept: () => applyChoice(preset.model, effort), secondary: () => applyChoice(preset.model, effort),
    }))
    picker.stack.push(view('advanced', [title('Advanced Reasoning'), { text: '⚠ Consumes usage limits faster', style: '\x1b[36m' }], items))
    drawPicker()
  }
  /** The full list (`Select Model and Effort`), or null when it would be empty. */
  const allModelsView = (presets, id) => {
    const listed = presets.filter((preset) => preset.listed && !isAuto(preset.model))
    if (!listed.length) return null
    return view(id, [title('Select Model and Effort')], listed.map((preset) => {
      const effort = directEffort(preset)
      return {
        slug: preset.model, name: preset.displayName, description: preset.description, current: preset.model === current.model,
        isDefault: preset.isDefault, accept: () => openReasoning(preset),
        secondary: effort === null ? null : () => applyChoice(preset.model, effort),
      }
    }))
  }
  /** What `/model` opens on: the reserve picker, the quick menu, or the full list when no auto preset is listed. */
  const firstView = (presets) => {
    if (current.model === LUNA_RESERVE_MODEL) {
      const normal = presets.find((preset) => preset.model === LUNA_MODEL)
      if (!normal) return null
      const preset = { ...normal, model: LUNA_RESERVE_MODEL }
      return view('model-selection', [title('Select Model'), subtitle('Other models return when ordinary usage is available again.')],
        [{ slug: LUNA_RESERVE_MODEL, name: normal.displayName, description: normal.description, current: true, accept: () => openReasoning(preset) }])
    }
    const listed = presets.filter((preset) => preset.listed)
    const autos = listed.filter((preset) => isAuto(preset.model)).sort((a, b) => autoOrder(a.model) - autoOrder(b.model))
    if (!autos.length) return allModelsView(presets, 'model-selection')
    const items = autos.map((preset) => ({
      slug: preset.model, name: preset.displayName, description: preset.description, current: preset.model === current.model,
      isDefault: preset.isDefault,
      accept: requiresAdvanced(preset) ? () => openReasoning(preset) : () => applyChoice(preset.model, preset.defaultEffort),
      secondary: requiresAdvanced(preset) ? null : () => applyChoice(preset.model, preset.defaultEffort),
    }))
    if (listed.some((preset) => !isAuto(preset.model))) {
      const currentLabel = listed.find((preset) => preset.model === current.model)?.displayName ?? current.model
      items.push({
        slug: 'All models', name: 'All models', description: `Choose a specific model and reasoning level (current: ${currentLabel})`,
        current: !items.some((item) => item.current), accept: openAllModels,
      })
    }
    return view('model-selection', [title('Select Model'), subtitle('Pick a quick auto mode or browse all models.')], items)
  }
  // `All models` closes the quick menu and opens the full list in its place: Esc from it closes the picker.
  const openAllModels = () => {
    const next = allModelsView(picker.presets, 'all-models-selection')
    if (!next) { closePicker(); say('No additional models are available right now.\r\n'); return }
    picker.stack = [next]
    drawPicker()
  }
  const openModelPicker = () => {
    const presets = presetsOf(readJson(modelsCacheFile)?.models)
    eraseComposer()
    picker = { stack: [], drawn: 0, presets }
    const first = firstView(presets)
    if (!first) {
      picker = null
      say(current.model === LUNA_RESERVE_MODEL
        ? 'Luna model settings are unavailable; please try /model again in a moment.\r\n'
        : 'No additional models are available right now.\r\n')
      return
    }
    picker.stack = [first]
    drawPicker()
    // The server's answer, once it comes, for this opening only (model_popup_state.rs `on_models_loaded`).
    const server = readJson(modelsServerFile)
    if (!server || !Array.isArray(server.models)) return
    const opened = picker
    setTimeout(() => {
      writeFileSync(modelsCacheFile, JSON.stringify({ ...readJson(modelsCacheFile), fetched_at: new Date().toISOString(), models: server.models }, null, 2))
      if (picker !== opened) return
      const presets = presetsOf(server.models)
      if (JSON.stringify(presets) === JSON.stringify(picker.presets)) return
      picker.presets = presets
      const parent = picker.stack[0]
      if (parent.id !== 'model-selection' && parent.id !== 'all-models-selection') return
      const refreshed = parent.id === 'model-selection' ? firstView(presets) : allModelsView(presets, parent.id)
      if (!refreshed) { closePicker(); return }
      // The highlight stays on the same model, by slug, wherever its row moved to.
      const slug = parent.items[parent.selected]?.slug
      const kept = refreshed.items.findIndex((item) => item.slug === slug)
      if (kept >= 0) refreshed.selected = kept
      picker.stack[0] = refreshed
      if (picker.stack.length === 1) drawPicker()
    }, Number(server.delayMs) || 0)
  }
  /** Keys while the picker is up. Returns what is left once it closes, for the composer. */
  const pickerKeys = (chunk) => {
    let rest = ''
    for (const key of chunk.match(/\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)|\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/g) ?? []) {
      if (!picker) { rest += key; continue }
      const top = picker.stack.at(-1)
      if (key === '\x1b' || key === '\x03') {
        picker.stack.pop()
        if (picker.stack.length) drawPicker()
        else closePicker()
      } else if (key === '\x1b[A' || key === '\x1b[B') {
        top.selected = (top.selected + (key === '\x1b[A' ? top.items.length - 1 : 1)) % top.items.length
        drawPicker()
      } else if (key === '\r' || key === '\n') top.items[top.selected]?.accept()
      else if (key === 's' && top.items[top.selected]?.secondary) top.items[top.selected].secondary()
      else if (/^[1-9]$/.test(key) && Number(key) <= top.items.length) {
        top.selected = Number(key) - 1
        top.items[top.selected].accept()
      }
      // Anything else, a paste included, is dropped: the list is not searchable.
    }
    return rest
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
    open = null
    say(`\r\n${text}\r\n\r\n`)
    // Claude Code's Stop hooks run once the answer is in, and the CLI waits for them before it takes the
    // next prompt; an interrupt ends a turn without them.
    await runHooks('Stop', { stop_hook_active: false })
  }

  // A permission asked for in a turn, answered: the command run (and written as the engine writes it)
  // or not, and the turn over. `turnOf` is the turn that asked.
  const permitted = (command, row, turnOf = turn) => {
    const allowed = row === 0 || row === 1
    const id = `call_${turnOf}_p`
    if (allowed) {
      if (engine === 'claude') {
        claude({ type: 'assistant', message: { id: `msg_${turnOf}_p`, role: 'assistant', model: config.claudeModel ?? 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }], stop_reason: 'tool_use' } })
        claude({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `ran ${command}` }] } })
      } else {
        codex('response_item', { type: 'function_call', call_id: id, name: 'exec_command', arguments: JSON.stringify({ cmd: command }) })
        codex('response_item', { type: 'function_call_output', call_id: id, output: `ran ${command}` })
      }
    }
    return finish(allowed ? `ran ${command}` : `did not run ${command}`)
  }
  // `!permitnext`: the request waiting for the next paste.
  let armed = null
  const askOnPaste = () => {
    if (!armed) return
    const { command, turn: turnOf } = armed
    armed = null
    eraseComposer()
    dialog = { kind: 'permit', command, cursor: 0, drawn: 0, resolve: (row) => { void permitted(command, row, turnOf) } }
    drawDialog()
  }

  const handle = async (raw) => {
    const prompt = raw.trim()
    // Enter on an empty composer takes nothing.
    if (!prompt) return
    history.push(prompt)
    // The prompt the CLI took, in the conversation, where both CLIs show what was sent.
    say(`> ${prompt.replace(/\n/g, '\r\n  ')}\r\n`)
    if (prompt === '!exit') {
      // Leaving, the CLI reads no more input, and says so to its hooks first (Claude Code's SessionEnd,
      // reason prompt_input_exit): what is typed meanwhile stays in the terminal, for whatever runs next.
      process.stdin.removeAllListeners('data')
      process.stdin.pause()
      await runHooks('SessionEnd', { reason: 'prompt_input_exit' })
      process.stdout.write('\x1b[?2004l\r\n')
      process.exit(0)
    }
    if (prompt === '!compact') {
      // `/compact` is a command, not a turn: a summary replaces the history, and Claude Code announces
      // the same session again (SessionStart, source compact), which makes the daemon re-read it.
      compact()
      say('(compacted)\r\n')
      if (engine === 'claude') await runHooks('SessionStart', { source: 'compact' })
      return
    }
    if (engine === 'claude' && /^\/compact(\s|$)/.test(prompt)) {
      // Claude Code's own /compact, written as 2.1.290 writes it (recorded by daemon QA): the command as a
      // plain user line, the compaction, a caveat and the command's tags, then its output. There is no
      // answer, no UserPromptSubmit and no turn of its own, and it announces the same session again.
      claude({ type: 'user', message: { role: 'user', content: prompt } })
      compact()
      claude({ type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>' } })
      claude({ type: 'user', message: { role: 'user', content: '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>' } })
      claude({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>' } })
      say('(compacted)\r\n')
      await runHooks('SessionStart', { source: 'compact' })
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
      say('(new conversation)\r\n')
      await runHooks('SessionStart', { source: 'clear' })
      return
    }
    runningTool = null
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
    if (engine === 'claude') {
      claude({ type: 'user', message: { role: 'user', content: prompt } })
      claude({ type: 'assistant', message: { id: `msg_${turn}_t`, role: 'assistant', model: config.claudeModel ?? 'claude-opus-5-5', content: [{ type: 'thinking', thinking: `considering: ${prompt}` }], stop_reason: null } })
    } else {
      codex('event_msg', { type: 'task_started', turn_id: open })
      codex('turn_context', { turn_id: open, model: current.model, reasoning_effort: current.effort, collaboration_mode: { mode: 'default' } })
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
    if (engine === 'claude' && directive?.[1] === 'bgagent') {
      // A background sub-agent that finishes while its parent still works, as Claude Code 2.1.287 records
      // it: the Agent call, its launch ack, the parent's own next tool, then the sub-agent's
      // `<task-notification>` handed back INTO the running turn as a queued_command attachment, not as the
      // user record Claude Code writes when the parent is idle.
      const name = directive[2] || 'scout'
      const id = `toolu_${turn}_bg`
      claude({ type: 'assistant', message: { id: `msg_${turn}_bg`, role: 'assistant', model: config.claudeModel ?? 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Agent', input: { description: `Count for ${name}`, prompt: `Count the files for ${name}.`, run_in_background: true } }], stop_reason: 'tool_use' } })
      claude({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Async agent launched successfully.\nagentId: a0f1e2d3c4b5a6978' }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a0f1e2d3c4b5a6978' } })
      const edit = `toolu_${turn}_ed`
      claude({ type: 'assistant', message: { id: `msg_${turn}_ed`, role: 'assistant', model: config.claudeModel ?? 'claude-opus-5-5', content: [{ type: 'tool_use', id: edit, name: 'Bash', input: { command: 'true' } }], stop_reason: 'tool_use' } })
      claude({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: edit, content: 'ran true' }] } })
      const notification = `<task-notification>\n<task-id>a0f1e2d3c4b5a6978</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>${join(cwd, '.tasks', 'a0f1e2d3c4b5a6978.output')}</output-file>\n<status>completed</status>\n<summary>Agent "Count for ${name}" finished</summary>\n<result>${name} found 3 files</result>\n</task-notification>`
      claude({ type: 'attachment', attachment: { type: 'queued_command', prompt: notification, commandMode: 'task-notification', origin: { kind: 'task-notification', producer: 'session-task' } } })
    }
    if (engine === 'codex' && directive?.[1] === 'spawn') {
      // A sub-agent, recorded as Codex 0.160 records one (multi-agent v2, measured on real rollouts): the
      // spawn call; a SubAgentActivity naming the child's thread, written before the spawn's output; an output
      // that names the child only by its path; the child's report to its parent; and its completion. No
      // `<subagent_notification>`, which is what 0.160's parent never writes. The child keeps a rollout of
      // its own, as Codex does, that the Task card reads its work from.
      const name = directive[2] || 'scout'
      const id = `call_${turn}_spawn`
      const thread = randomUUID()
      const path = `/root/${name}`
      const childFile = join(codexHome, 'sessions', '2026', '10', '03', `rollout-2026-10-03T00-00-01-${thread}.jsonl`)
      const child = (type, payload) => appendFileSync(childFile, JSON.stringify({ timestamp: now(), type, payload }) + '\n')
      codex('response_item', { type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: id, arguments: JSON.stringify({ task_name: name, agent_type: 'explorer', message: `Count the files for ${name}.` }) })
      child('session_meta', { id: thread, cli_version: version, cwd, agent_nickname: 'Goodall', agent_role: 'explorer', agent_path: path, multi_agent_version: 'v2',
        source: { subagent: { thread_spawn: { parent_thread_id: sessionId, depth: 1, agent_path: path, agent_nickname: 'Goodall', agent_role: 'explorer' } } } })
      codex('event_msg', { type: 'item_completed', turn_id: open, item: { type: 'SubAgentActivity', id, kind: 'started', agent_thread_id: thread, agent_path: path } })
      codex('response_item', { type: 'function_call_output', call_id: id, output: JSON.stringify({ task_name: path }) })
      child('event_msg', { type: 'task_started', turn_id: `${thread}-1` })
      child('response_item', { type: 'function_call', call_id: `${thread}-ls`, name: 'exec_command', arguments: JSON.stringify({ cmd: 'ls' }) })
      child('response_item', { type: 'function_call_output', call_id: `${thread}-ls`, output: 'one\ntwo\nthree' })
      child('event_msg', { type: 'task_complete', turn_id: `${thread}-1`, last_agent_message: `${name} found 3 files` })
      codex('inter_agent_communication_metadata', { trigger_turn: false })
      codex('response_item', { type: 'agent_message', author: path, recipient: '/root', content: [
        { type: 'input_text', text: `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${path}\nPayload:\n${name} found 3 files` },
        { type: 'encrypted_content', encrypted_content: 'gAAAA' },
      ] })
      codex('event_msg', { type: 'item_completed', turn_id: open, item: { type: 'SubAgentActivity', id: `subagent-completed-${thread}`, kind: 'completed', agent_thread_id: thread, agent_path: path } })
    }
    if (directive?.[1] === 'flood') {
      // Numbered, so whoever reads the terminal can tell a lost, repeated or reordered line.
      const kib = Number(directive[2]) || 256
      let written = 0
      eraseComposer()
      for (let line = 0; written < kib * 1024; line++) {
        const text = `flood ${String(line).padStart(7, '0')} ${'.'.repeat(80)}\r\n`
        process.stdout.write(text)
        written += text.length
      }
      drawComposer()
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
    if (directive?.[1] === 'holdtool') {
      // A tool still running when the person interrupts. Both CLIs write its output, marked aborted, only
      // AFTER the interrupt and just before the turn's end: what a real Codex 0.160 did in daemon QA.
      const id = `call_${turn}`
      if (engine === 'claude') claude({ type: 'assistant', message: { id: `msg_${turn}_u`, role: 'assistant', model: config.claudeModel ?? 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: directive[2] } }], stop_reason: 'tool_use' } })
      else codex('response_item', { type: 'function_call', call_id: id, name: 'exec_command', arguments: JSON.stringify({ cmd: directive[2] }) })
      runningTool = id
      return
    }
    if (directive?.[1] === 'permitnext') {
      // The turn goes on; its request arrives with the next paste, between it and its Enter.
      armed = { command: directive[2] || 'printf hi', turn }
      return
    }
    if (directive?.[1] === 'permit') {
      const command = directive[2] || 'printf hi'
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      // The dialog takes the composer's place, as the CLIs draw theirs, until it is answered.
      const row = await new Promise((resolve) => { eraseComposer(); dialog = { kind: 'permit', command, cursor: 0, drawn: 0, resolve }; drawDialog() })
      await permitted(command, row)
      return
    }
    if (directive?.[1] === 'ask') {
      // A real engine thinks before it asks; a dialog already on screen when its turn began reads to the
      // daemon as the previous turn's (askQuestion.ts `noteTurnStart`).
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      const choice = await new Promise((resolve) => { eraseComposer(); dialog = { cursor: 0, drawn: 0, resolve }; drawDialog() })
      if (choice === null) {
        say('(question cancelled)\r\n')
        await finish('(question cancelled)')
        return
      }
      // The tool call is written once it is answered, as the real CLIs flush it.
      const questions = [{ question: QUESTION, header: 'Drink', multiSelect: false, options: CHOICES.map(([label, description]) => ({ label, description })) }]
      if (engine === 'claude') {
        const id = `toolu_${turn}`
        claude({ type: 'assistant', message: { id: `msg_${turn}_q`, role: 'assistant', model: config.claudeModel ?? 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }], stop_reason: 'tool_use' } })
        claude({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `User has answered your questions: "${QUESTION}"="${choice}"` }] } })
        say(`⏺ User answered Claude's questions:\r\n  ⎿  · ${QUESTION} → ${choice}\r\n`)
      } else {
        const id = `call_${turn}_q`
        codex('response_item', { type: 'function_call', call_id: id, name: 'request_user_input', arguments: JSON.stringify({ questions }) })
        codex('response_item', { type: 'function_call_output', call_id: id, output: JSON.stringify({ answers: { [QUESTION]: choice } }) })
        say(`• ${QUESTION} → ${choice}\r\n`)
      }
      await finish(`you chose ${choice}${notes ? ` (notes: ${notes})` : ''}`)
      return
    }
    if (engine === 'codex' && directive?.[1] === 'askasync') {
      // Codex 0.160's question that does not stop the turn (shape measured on real rollouts): the call, its
      // `{"accepted":true}` at once, and later the person's answer as a user message wrapped in
      // `<send_user_message_question_reply>`. Only the transcript is faked: the answer is written as if
      // given at once, with no dialog drawn, since 0.160's panel for it was not recorded.
      const id = `call_${turn}_qa`
      const question = 'Which database should the service use?'
      codex('response_item', { type: 'function_call', name: 'request_user_input_async', call_id: id, arguments: JSON.stringify({ questions: [{ title: question, options: ['Postgres', 'SQLite'] }] }) })
      codex('event_msg', { type: 'item_completed', turn_id: open, item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Asked which database to use.' }], phase: 'commentary' } })
      codex('response_item', { type: 'function_call_output', call_id: id, output: JSON.stringify({ accepted: true }) })
      const answer = `<send_user_message_question_reply>\n${JSON.stringify([{ answer: directive[2] || 'Postgres', question, questionItemId: JSON.stringify([id]) }])}\n</send_user_message_question_reply>`
      codex('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: answer }] })
      codex('event_msg', { type: 'item_completed', turn_id: open, item: { type: 'UserMessage', id: `${id}-reply`, content: [{ type: 'text', text: answer, text_elements: [] }] } })
    }
    if (engine === 'claude' && directive?.[1] === 'goalpause') {
      // The same refusal, after which Claude Code pauses the goal instead of working on (real 2.1.283): two
      // notices and its turn_duration, with no output and no further Stop hook.
      const condition = directive[2] || 'the work is done'
      claude({ type: 'assistant', message: { id: `msg_${turn}_p1`, role: 'assistant', model: config.claudeModel ?? 'claude-opus-5-5', content: [{ type: 'text', text: `first pass at: ${condition}` }], stop_reason: 'end_turn' } })
      say(`\r\nfirst pass at: ${condition}\r\n`)
      await runHooks('Stop', { stop_hook_active: false })
      claude({ type: 'user', isMeta: true, promptId: randomUUID(), message: { role: 'user', content: `Stop hook feedback:\n[goal]: not met yet: ${condition}` } })
      claude({ type: 'attachment', attachment: { type: 'goal_status', met: false, condition, reason: 'one check still fails' } })
      claude({ type: 'system', subtype: 'stop_hook_summary', hookCount: 1, hookInfos: [], hookErrors: [], preventedContinuation: false, stopReason: '', hasOutput: false, level: 'suggestion' })
      claude({ type: 'system', subtype: 'informational', content: 'A hook blocked the stop again — pausing the goal.', level: 'notice' })
      claude({ type: 'system', subtype: 'informational', content: 'Goal paused · /goal to resume', level: 'notice' })
      claude({ type: 'system', subtype: 'turn_duration', durationMs: 5_000, messageCount: 6 })
      say('Goal paused\r\n')
      open = null
      return
    }
    if (engine === 'claude' && directive?.[1] === 'goalloop') {
      // Claude Code's /goal, its condition not met at the first stop, as 2.1.283 writes it: the answer and
      // its Stop hooks, then the goal hook's refusal (a hidden feedback line, the goal's status and the
      // hooks' summary) and the next pass in the SAME turn, with no prompt line between; a tool runs in it.
      // The daemon closed the turn at the first stop and read the next pass as no turn at all.
      //
      // The first pass's Stop reaches the daemon only once the next pass is on disk, as a loaded daemon took
      // it in a full end-to-end run (520 ms after that pass started): the CLI waits for its hook commands,
      // but the hook's request can be read after it has gone on. So the hooks run once the pass has begun.
      const condition = directive[2] || 'the work is done'
      const model = config.claudeModel ?? 'claude-opus-5-5'
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      claude({ type: 'assistant', message: { id: `msg_${turn}_g1`, role: 'assistant', model, content: [{ type: 'text', text: `first pass at: ${condition}` }], stop_reason: 'end_turn' } })
      say(`\r\nfirst pass at: ${condition}\r\n`)
      claude({ type: 'user', isMeta: true, promptId: randomUUID(), message: { role: 'user', content: `Stop hook feedback:\n[goal]: not met yet: ${condition}` } })
      claude({ type: 'attachment', attachment: { type: 'goal_status', met: false, condition, reason: 'one check still fails' } })
      claude({ type: 'system', subtype: 'stop_hook_summary', hookCount: 1, hookInfos: [], hookErrors: [], preventedContinuation: false, stopReason: '', hasOutput: false, level: 'suggestion' })
      const id = `call_${turn}_g`
      claude({ type: 'assistant', message: { id: `msg_${turn}_g2`, role: 'assistant', model, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'make check' } }], stop_reason: 'tool_use' } })
      await pause(600)
      const lateStop = runHooks('Stop', { stop_hook_active: false })
      await pause(Number(config.goalPassMs) || 4_000)
      await lateStop
      claude({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'all checks pass' }] } })
      await finish(`goal met: ${condition}`)
      claude({ type: 'attachment', attachment: { type: 'goal_status', met: true, condition, reason: 'all checks pass' } })
      claude({ type: 'system', subtype: 'turn_duration', durationMs: 6_000, messageCount: 8 })
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
    if (engine === 'claude' && directive?.[1] === 'config') {
      bottom = configScreen()
      await finish(`answer ${turn}: ${prompt}`)
      return
    }
    if (engine === 'codex' && directive?.[1] === 'center') {
      bottom = centerScreen()
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

  // Raw input: bracketed paste brackets the text, Enter (\r) submits, Ctrl-C interrupts, Ctrl+Z suspends.
  process.stdin.setEncoding('utf8')
  let queue = Promise.resolve()
  // Inside a bracketed paste a carriage return or newline is a newline in the prompt, as Ink and
  // ratatui read it; only one typed outside a paste submits. The paste's markers say which.
  let pasting = false
  // A large paste is shown in the draft as a placeholder and sent whole: Claude Code's
  // `[Pasted text #1 +4 lines]` past 800 characters or two lines (2.1.289), Codex's
  // `[Pasted Content 1200 chars]` past 1000 characters (chat_composer.rs LARGE_PASTE_CHAR_THRESHOLD).
  let pasted = ''
  const pastes = new Map()
  const placeholder = (text) => {
    const lines = (text.match(/\n/g) ?? []).length
    if (engine === 'claude' ? text.length <= 800 && lines <= 2 : text.length <= 1000) return text
    const label = engine === 'claude' ? `[Pasted text #${pastes.size + 1}${lines ? ` +${lines} lines` : ''}]` : `[Pasted Content ${text.length} chars]`
    pastes.set(label, text)
    return label
  }
  const expand = (draft) => {
    let text = draft
    for (const [label, content] of pastes) text = text.replace(label, content)
    pastes.clear()
    return text
  }
  // Ctrl+Z, as the real CLIs do it: give the terminal back, and stop the whole process group (the
  // npm Codex's wrapper with it) once the terminal is restored; in raw mode the terminal sends no
  // SIGTSTP of its own. Raw mode comes back only from this stop: Claude Code arms a one-time SIGCONT
  // handler here, Codex takes the terminal again when its stop returns.
  const suspend = () => {
    process.stdout.write('\x1b[?2004l')
    if (engine === 'claude') process.stdout.write('\r\nClaude Code has been suspended. Run `fg` to bring Claude Code back.\r\n')
    process.stdin.setRawMode?.(false)
    process.once('SIGCONT', () => {
      process.stdin.setRawMode?.(true)
      process.stdout.write('\x1b[?2004h')
    })
    process.kill(0, 'SIGTSTP')
  }
  // Continued, whoever stopped it, the renderer repaints, and that is all: after a stop from outside
  // the terminal is in whatever modes the shell that resumed it left (an interactive bash puts back its
  // own, line mode), as it is for the real CLIs.
  process.on('SIGCONT', () => draw())
  process.stdin.on('data', (input) => {
    // The key, not the byte: a Ctrl+Z inside a paste is pasted text.
    if (input.includes('\x1a') && !pasting && !input.includes('\x1b[200~')) { suspend(); return }
    if (dialog) { dialogKeys(input); return }
    let chunk = input
    if (picker) {
      chunk = pickerKeys(chunk)
      if (!chunk) return
    }
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
    if (bottom?.screen) {
      // Claude Code's settings take a paste as what to search for, and Enter or Space change the highlighted
      // setting; Codex's command center opens the highlighted task on Enter. Esc closes either.
      let rest = ''
      for (const token of chunk.match(/\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)|\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/g) ?? []) {
        if (!bottom?.screen) { rest += token; continue }
        if (token === '\x1b') { eraseComposer(); bottom = null; drawComposer() }
        else if (bottom.config && token.startsWith('\x1b[200~')) { bottom.query += token.slice(6).replace(/\x1b\[201~$/, ''); draw() }
        else if (bottom.config && (token === '\r' || token === ' ')) {
          const [name] = SETTINGS.find(([setting]) => setting.toLowerCase().includes(bottom.query.toLowerCase())) ?? []
          if (name) say(`(${name} changed)\r\n`)
        } else if (bottom.center && token === '\r') { eraseComposer(); bottom = null; say('(opened Task 2)\r\n') }
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
        eraseComposer()
        bottom = null
        buffer = draft
        drawComposer()
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
    const parts = chunk.split(/(\x1b\[20[01]~|\x1b\[[0-9;]*[A-Za-z~]|\x1b|\x7f|\r|\n|\x03)/)
    for (const [index, part] of parts.entries()) {
      if (part === '\x1b[200~') { pasting = true; pasted = ''; continue }
      if (part === '\x1b[201~') {
        pasting = false
        buffer += placeholder(pasted)
        draw()
        askOnPaste()
        // What follows the paste goes to the request, once it is up.
        if (dialog) { dialogKeys(parts.slice(index + 1).join('')); return }
        continue
      }
      if (pasting) { pasted += part === '\r' ? '\n' : part; continue }
      if (part.startsWith('\x1b')) {
        // Esc puts the suggestions away, the draft kept; other keys move nothing here.
        const popup = suggestions(buffer)
        if (part === '\x1b' && popup) { dismissed = popup.token; draw() }
        continue
      }
      if (part === '\x7f') { buffer = buffer.slice(0, -1); draw(); continue }
      if ((part === '\r' || part === '\n') && suggestions(buffer)) {
        const popup = suggestions(buffer)
        // Codex runs the highlighted command on Enter (chat_composer/slash_input.rs), the draft cleared; of
        // its commands the fake carries out `/model`, whose picker takes the composer's place. The keys
        // after it in this read are the picker's.
        if (engine === 'codex' && popup.found[0][0] === '/model' && popup.token.startsWith('/')) {
          buffer = ''
          pastes.clear()
          openModelPicker()
          const rest = parts.slice(index + 1).join('')
          if (rest && picker) { const left = pickerKeys(rest); if (left) process.stdin.emit('data', left) }
          return
        }
        // Otherwise Enter with suggestions open takes the highlighted one into the draft, and sends nothing.
        buffer = `${buffer.slice(0, buffer.length - popup.token.length)}${popup.token.startsWith('@') ? '@' : ''}${popup.found[0][0]} `
        draw()
        continue
      }
      if (part === '\x03') {
        // Ctrl-C ends a running turn, and empties the composer either way.
        buffer = ''
        if (open) {
          if (runningTool) {
            if (engine === 'claude') claude({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: runningTool, content: '[Request interrupted by user for tool use]', is_error: true }] } })
            else codex('response_item', { type: 'function_call_output', call_id: runningTool, output: 'aborted by user' })
            runningTool = null
          }
          if (engine === 'claude') claude({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })
          else codex('event_msg', { type: 'turn_aborted', turn_id: open })
          open = null
          say('(interrupted)\r\n')
        } else draw()
      } else if (part === '\r' || part === '\n') {
        const line = expand(buffer)
        buffer = ''
        // Taken off the composer at once, whatever the engine is doing: a prompt sent while a turn runs
        // waits its turn out of the composer, as both CLIs queue one.
        draw()
        // Codex's `/model` is a command, not a prompt: its picker takes the composer's place at once and
        // nothing is sent. The keys after it in this read are the picker's.
        if (engine === 'codex' && line.trim() === '/model') {
          openModelPicker()
          const rest = parts.slice(index + 1).join('')
          if (rest && picker) { const left = pickerKeys(rest); if (left) process.stdin.emit('data', left) }
          return
        }
        queue = queue.then(() => handle(line))
      } else if (part) {
        buffer += part
        draw()
      }
    }
  })
  process.on('SIGTERM', () => process.exit(0))
  setInterval(() => {}, 60_000)
}

// The native Codex: this module run as a script by `codexWrapper`. Last, so everything `run` reads at
// the top level of the module is there when it starts.
if (process.env[CODEX_NATIVE] && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(process.env[CODEX_NATIVE])
  delete process.env[CODEX_NATIVE]
  void run('codex', config, { native: true })
}
