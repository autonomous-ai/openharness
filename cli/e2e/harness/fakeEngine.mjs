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
// open until the next prompt, `!exit` ends the process. Everything else is echoed as the answer.
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export async function run(engine, config) {
  const args = process.argv.slice(2)
  if (args.includes('--version') || args.includes('-V')) {
    process.stdout.write(engine === 'claude' ? '2.1.270 (Claude Code)\n' : 'codex-cli 0.159.0\n')
    return
  }
  if (args.includes('--help') || args.includes('-h')) {
    // The flags the daemon looks for in the real CLIs' help before it launches them.
    process.stdout.write(engine === 'codex'
      ? [
          'Usage: codex [OPTIONS] [PROMPT]', '',
          '  -c, --config <key=value>', '  -m, --model <MODEL>', '  -s, --sandbox <SANDBOX_MODE>',
          '  -a, --ask-for-approval <APPROVAL_POLICY>', '      --approve-for-me',
          '      --dangerously-bypass-approvals-and-sandbox', '      --no-daemon',
          'Commands:', '  resume  Resume a previous interactive session', '',
        ].join('\n')
      : [
          'Usage: claude [options] [command] [prompt]', '', 'Arguments:', '  prompt  Your prompt', '',
          '  --model <model>', '  --permission-mode <mode>  (choices: "acceptEdits", "auto", "bypassPermissions", "default", "plan")',
          '  --dangerously-skip-permissions', '  -r, --resume [value]', '  --fork-session', '  --session-id <uuid>', '',
        ].join('\n'))
    return
  }
  process.title = engine

  const resumeAt = engine === 'claude' ? args.indexOf('--resume') : args.indexOf('resume')
  const resumed = resumeAt >= 0 && args[resumeAt + 1] && !args[resumeAt + 1].startsWith('-') ? args[resumeAt + 1] : null
  const fork = args.includes('--fork-session')
  const sessionId = resumed && !fork ? resumed : randomUUID()
  const cwd = process.cwd()
  const transcript = engine === 'claude'
    ? join(config.claudeProjectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
    : resumed && !fork && config.rolloutFor?.[resumed]
      ? config.rolloutFor[resumed]
      : join(config.codexHome, 'sessions', '2026', '10', '03', `rollout-2026-10-03T00-00-00-${sessionId}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  if (!existsSync(transcript)) writeFileSync(transcript, '')

  const now = () => new Date().toISOString()
  const write = (record) => appendFileSync(transcript, JSON.stringify(record) + '\n')
  let parent = null
  const claude = (record) => {
    const uuid = randomUUID()
    write({ parentUuid: parent, isSidechain: false, userType: 'external', cwd, sessionId, version: '2.1.270', timestamp: now(), uuid, ...record })
    parent = uuid
  }
  const codex = (type, payload) => write({ timestamp: now(), type, payload })
  if (engine === 'codex' && readFileSync(transcript, 'utf8') === '') {
    codex('session_meta', { id: sessionId, cli_version: '0.159.0', cwd, source: 'cli' })
  }

  const hook = async (path, body) => {
    const token = readFileSync(join(config.dataDir, 'hook-credential'), 'utf8').trim()
    const pane = process.env.TMUX_PANE
    const response = await fetch(`http://127.0.0.1:${config.port}/api/hook/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-harness-hook-token': token },
      body: JSON.stringify({
        engine, sessionId, transcriptPath: transcript, cwd,
        tmuxPane: pane, runtimeHints: pane ? [{ backend: 'tmux', paneId: pane }] : [], callerPid: process.pid,
        ...body,
      }),
    }).catch((error) => ({ ok: false, status: 0, text: async () => String(error) }))
    if (!response.ok) process.stdout.write(`\r\n[fake ${engine}] hook ${path} failed: ${response.status}\r\n`)
  }

  const draw = (line = '') => process.stdout.write(`\r\x1b[2K› ${line}`)
  process.stdout.write(`\x1b[?2004h${engine === 'claude' ? '✻ Welcome to Claude Code (fake)' : '>_ OpenAI Codex (fake)'}\r\n`)
  process.stdout.write(`  session ${sessionId}${resumed ? ' (resumed)' : ''}\r\n\r\n`)
  draw()
  await hook('session-start', { hookEvent: resumed ? 'SessionStart' : 'SessionStart', source: resumed ? 'resume' : 'startup' })

  let turn = 0
  let open = null
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
    if (open) finish('(interrupted by a new prompt)')
    turn++
    open = `turn-${turn}`
    process.stdout.write(`\r\n`)
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
    if (directive?.[1] === 'hold') return
    if (directive?.[1] === 'slow') await new Promise((resolve) => setTimeout(resolve, Number(directive[2]) || 1000))
    finish(`answer ${turn}: ${prompt}`)
  }

  // Raw input: bracketed paste brackets the text, Enter (\r) submits, Ctrl-C interrupts.
  process.stdin.setRawMode?.(true)
  process.stdin.setEncoding('utf8')
  let buffer = ''
  let queue = Promise.resolve()
  process.stdin.on('data', (chunk) => {
    for (const part of chunk.replace(/\x1b\[20[01]~/g, '').split(/(\r|\n|\x03)/)) {
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
