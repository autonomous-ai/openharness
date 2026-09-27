#!/usr/bin/env node
/**
 * A scripted stand-in for Claude Code, for the daemons sandbox (daemons/e2e/sandbox.mjs). It is launched by
 * harnessd as `claude` in a harness pane of the sandbox's private tmux server and behaves like Claude Code as
 * far as harnessd can tell:
 *
 *   transcript  <CLAUDE_PROJECTS_DIR or ~/.claude/projects>/<cwd mangled>/<session>.jsonl, in Claude's own
 *               record shapes: a typed prompt, assistant text with `stop_reason: end_turn`, a Bash
 *               `tool_use` before its permission dialog and its `tool_result` after.
 *   hooks       the SessionStart / UserPromptSubmit / Stop commands harnessd installed in ~/.claude/settings.json,
 *               run with the JSON Claude would pipe to them, from inside the pane (TMUX_PANE is set).
 *   pane        an inline UI like Claude's: finished output scrolls, and a live region at the bottom (the input
 *               line, or a permission dialog) is redrawn in place, so an answered dialog leaves nothing behind
 *               in the scrollback. The dialog is the one in cli/src/lib/__fixtures__/permission-claude.txt.
 *
 * What a turn does is decided by the prompt:
 *
 *   e2e:bash <command>         a Bash permission dialog for <command>; `1`/Enter runs it, `3`/Esc declines.
 *   e2e:bash-timer <command>   the same dialog with Muse's status line inside the frame, ticking every second
 *                              (`◇ Calling tools (21s · esc to interrupt)`): the question id must not follow it.
 *   e2e:steps <a> ;; <b> ;; …  runs each command as an auto-approved Bash step (for the repeat-steps signal).
 *   e2e:slow <seconds>         a turn that works that long before it answers.
 *   anything else              one line of text, then the turn ends.
 *
 * And by a control file, so the test never has to type into the pane (typing is keys, and keys are what it
 * measures): <cwd>/.fake-claude/ctl.jsonl, one JSON op per line, appended by the test.
 *
 *   {"op":"prompt","text":"…"}          as if the person typed it and pressed Enter
 *   {"op":"change","command":"…"}       the open dialog now asks about another command (a new tool call)
 *   {"op":"cursor","dir":"down"|"up"}   move the dialog's highlight, as a person's arrow key would
 *   {"op":"key","key":"3"}              a key the person pressed in the pane (logged like any other)
 *   {"op":"exit"}
 *
 * Every key that reaches the pane is logged to <cwd>/.fake-claude/keys.jsonl with what was on screen, and every
 * turn's outcome to <cwd>/.fake-claude/events.jsonl: the test's proof that an answer was TYPED, and when.
 *
 * `--print` (harnessd's one-shot worker for triage and distilling) answers over stream-json: a lesson for a
 * distill prompt that saw a correction, nothing for anything else.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)

// ── one-shot worker mode ─────────────────────────────────────────────────────────────────────────────
if (argv.includes('--print') || argv.includes('-p')) {
  const sessionId = randomUUID()
  let buffer = ''
  const answer = (prompt) => {
    // A distill prompt ends with the answers it accepts; this one saw a correction about migrations.
    if (/The expected answer is \{"lesson": null\}/.test(prompt) && /dry-run/i.test(prompt)) {
      return JSON.stringify({
        lesson: {
          kind: 'skill',
          name: 'run-migrations-safely',
          description: 'Run database migrations with a dry run first. Use before any migrate command.',
          body: 'Run `npm run migrate -- --dry-run` first and show the plan.\nRun the real migration only after the user says yes.',
        },
      })
    }
    if (/The expected answer is \{"lesson": null\}/.test(prompt)) return '{"lesson": null}'
    return ''
  }
  const reply = (text) => {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n')
    process.stdout.write(JSON.stringify({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n')
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: text, session_id: sessionId }) + '\n')
  }
  const promptArg = argv[argv.indexOf(argv.includes('-p') ? '-p' : '--print') + 1]
  if (promptArg && !promptArg.startsWith('-') && !argv.includes('--input-format')) {
    reply(answer(promptArg))
    process.exit(0)
  }
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      const content = msg?.message?.content
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c?.text ?? '').join('') : ''
      reply(answer(text))
    }
  })
  process.stdin.on('end', () => process.exit(0))
} else {
  interactive()
}

// ── the interactive session ──────────────────────────────────────────────────────────────────────────
function interactive() {
  const cwd = process.cwd()
  const home = homedir()
  const projects = process.env.CLAUDE_PROJECTS_DIR || join(home, '.claude', 'projects')
  const sessionId = randomUUID()
  const dir = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const transcript = join(dir, `${sessionId}.jsonl`)
  writeFileSync(transcript, '')
  const own = join(cwd, '.fake-claude')
  mkdirSync(own, { recursive: true })
  const keysLog = join(own, 'keys.jsonl')
  const eventsLog = join(own, 'events.jsonl')
  const ctlFile = join(own, 'ctl.jsonl')
  if (!existsSync(ctlFile)) writeFileSync(ctlFile, '')
  const event = (entry) => appendFileSync(eventsLog, JSON.stringify({ at: Date.now(), sessionId, ...entry }) + '\n')

  // Claude's record fields, as its own transcripts carry them.
  let parent = null
  const base = () => ({ parentUuid: parent, isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId, version: '2.1.232', gitBranch: 'main' })
  const record = (fields) => {
    const uuid = randomUUID()
    appendFileSync(transcript, JSON.stringify({ ...base(), ...fields, uuid, timestamp: new Date().toISOString() }) + '\n')
    parent = uuid
  }
  const userPrompt = (text) => record({ type: 'user', promptId: randomUUID(), message: { role: 'user', content: text }, permissionMode: 'default', promptSource: 'typed', origin: { kind: 'human' } })
  const assistant = (content, stop) => record({
    type: 'assistant', requestId: `req_${randomUUID().replace(/-/g, '')}`,
    message: { model: 'claude-e2e-fake', id: `msg_${randomUUID().replace(/-/g, '')}`, type: 'message', role: 'assistant', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
  })
  const toolResult = (id, text, isError) => record({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: text, is_error: isError }] }, toolUseResult: { stdout: isError ? '' : text, stderr: '', interrupted: false } })

  // ── hooks, as Claude runs them ─────────────────────────────────────────────────────────────────────
  let settings = {}
  try { settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) } catch { /* none installed */ }
  const hook = (event, extra = {}) => new Promise((resolve) => {
    const blocks = Array.isArray(settings?.hooks?.[event]) ? settings.hooks[event] : []
    const commands = blocks
      .filter((b) => !b?.matcher || event !== 'SessionStart' || new RegExp(`^(${b.matcher})$`).test('startup'))
      .flatMap((b) => (Array.isArray(b?.hooks) ? b.hooks : []))
      .map((h) => h?.command)
      .filter((c) => typeof c === 'string')
    if (!commands.length) { resolve(); return }
    let left = commands.length
    for (const command of commands) {
      const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'ignore', 'ignore'], env: process.env })
      child.stdin.end(JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd, hook_event_name: event, ...extra }))
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
      child.on('close', () => { clearTimeout(timer); if (--left === 0) resolve() })
      child.on('error', () => { clearTimeout(timer); if (--left === 0) resolve() })
    }
  })

  // ── the screen ─────────────────────────────────────────────────────────────────────────────────────
  const out = (s) => process.stdout.write(s)
  const cols = () => Math.max(40, Math.min(process.stdout.columns || 80, 200))
  const rule = () => '─'.repeat(Math.min(cols() - 1, 100))
  let liveLines = 0
  let input = ''
  let dialog = null   // { toolId, command, description, highlight, timer: { started } | null, resolve }
  let working = false

  function liveRegion() {
    if (dialog) {
      const rows = ['Yes', `Yes, and don’t ask again for: ${dialog.command.split(' ')[0]} *`, 'No']
      const lines = [
        rule(),
        ' Bash command',
        '',
        `   ${dialog.command}`,
        `   ${dialog.description}`,
        '',
        ' This command requires approval',
      ]
      // Muse's status line, as it paints it: `◇ Calling tools (21s · esc to interrupt)`, then `(01m30s · …)`.
      if (dialog.timer) {
        const s = Math.floor((Date.now() - dialog.timer.started) / 1000)
        const elapsed = s < 60 ? `${s}s` : `${String(Math.floor(s / 60)).padStart(2, '0')}m${String(s % 60).padStart(2, '0')}s`
        lines.push(`   \u25c7 Calling tools (${elapsed} \u00b7 esc to interrupt)`)
      }
      lines.push('', ' Do you want to proceed?')
      rows.forEach((label, i) => lines.push(`${i === dialog.highlight ? ' ❯' : '  '} ${i + 1}. ${label}`))
      lines.push('', ' Esc to cancel · Tab to amend · ctrl+e to explain')
      return lines
    }
    if (working) return ['✻ Working… (esc to interrupt)']
    return [rule(), `> ${input}`, rule()]
  }
  // Back to the top of the live region, and clear from there down. (`ESC[0A` would still move a line.)
  function up() {
    if (liveLines <= 0) return ''
    return `\r${liveLines > 1 ? `\u001b[${liveLines - 1}A` : ''}\u001b[J`
  }
  function redraw() {
    let s = ''
    s += up()
    const lines = liveRegion().map((l) => l.slice(0, cols() - 1))
    s += lines.join('\r\n')
    liveLines = lines.length
    out(s)
  }
  // Finished output goes above the live region and scrolls like any terminal output.
  function print(...lines) {
    let s = ''
    s += up()
    s += lines.map((l) => l.slice(0, cols() - 1)).join('\r\n') + '\r\n'
    liveLines = 0
    out(s)
    redraw()
  }

  // ── turns ──────────────────────────────────────────────────────────────────────────────────────────
  const queue = []
  let busy = false
  function submit(text) {
    queue.push(text)
    if (!busy) void drain()
  }
  async function drain() {
    busy = true
    while (queue.length) await turn(queue.shift())
    busy = false
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function turn(text) {
    print(`❯ ${text}`)
    userPrompt(text)
    await hook('UserPromptSubmit', { prompt: text })
    working = true
    redraw()
    event({ kind: 'turn-start', text })
    const m = /^e2e:(bash|bash-timer|steps|slow)\s+(.+)$/s.exec(text.trim())
    let outcome = 'answered'
    if (m && (m[1] === 'bash' || m[1] === 'bash-timer')) {
      outcome = await bash(m[2].trim(), m[1] === 'bash-timer')
    } else if (m && m[1] === 'steps') {
      for (const command of m[2].split(';;').map((c) => c.trim()).filter(Boolean)) {
        const id = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        assistant([{ type: 'tool_use', id, name: 'Bash', input: { command, description: `Run ${command}` } }], 'tool_use')
        await sleep(50)
        toolResult(id, `ran ${command}`, false)
        print(`⏺ Bash(${command})`, '  ⎿  ok')
      }
      assistant([{ type: 'text', text: 'Done.' }], 'end_turn')
      print('⏺ Done.')
    } else if (m && m[1] === 'slow') {
      await sleep(Math.min(600, Number(m[2]) || 1) * 1000)
      assistant([{ type: 'text', text: 'Finished the slow work.' }], 'end_turn')
      print('⏺ Finished the slow work.')
    } else {
      const reply = `Done: ${text.slice(0, 60)}`
      assistant([{ type: 'text', text: reply }], 'end_turn')
      print(`⏺ ${reply}`)
    }
    working = false
    redraw()
    if (outcome !== 'interrupted') await hook('Stop', { stop_hook_active: false })
    event({ kind: 'turn-end', text, outcome })
  }

  /** One Bash tool call that waits for the person's permission. */
  async function bash(command, timer) {
    const id = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`
    const description = `Run ${command}`
    // The tool call is in the transcript before the dialog is on screen: the pair reads the exact command there.
    assistant([{ type: 'tool_use', id, name: 'Bash', input: { command, description } }], 'tool_use')
    print(`⏺ Bash(${command})`)
    const choice = await new Promise((resolve) => {
      dialog = { toolId: id, command, description, highlight: 0, timer: timer ? { started: Date.now() } : null, resolve }
      working = false
      redraw()
      event({ kind: 'dialog', command, timer })
    })
    const asked = dialog
    dialog = null
    working = true
    redraw()
    if (choice === 'yes') {
      toolResult(asked.toolId, `ran ${asked.command}`, false)
      print(`  ⎿  approved: ${asked.command}`, `  ⎿  ran ${asked.command}`)
      assistant([{ type: 'text', text: `Ran ${asked.command}.` }], 'end_turn')
      print(`⏺ Ran ${asked.command}.`)
      event({ kind: 'approved', command: asked.command })
      return 'approved'
    }
    toolResult(asked.toolId, 'The user doesn’t want to proceed with this tool use.', true)
    record({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } })
    print(`  ⎿  declined: ${asked.command}`)
    event({ kind: 'declined', command: asked.command })
    return 'interrupted'
  }

  // ── keys ───────────────────────────────────────────────────────────────────────────────────────────
  function logKey(key) {
    appendFileSync(keysLog, JSON.stringify({ at: Date.now(), key, dialog: dialog ? dialog.command : null, highlight: dialog?.highlight ?? null }) + '\n')
  }
  function onKey(key) {
    logKey(key)
    if (dialog) {
      if (key === '1') return dialog.resolve('yes')
      if (key === '2') return dialog.resolve('yes')   // "don't ask again": the pair must never press it
      if (key === '3' || key === '\u001b') return dialog.resolve('no')
      if (key === '\r') return dialog.resolve(dialog.highlight === 2 ? 'no' : 'yes')
      if (key === '\u001b[A') { dialog.highlight = Math.max(0, dialog.highlight - 1); redraw(); return }
      if (key === '\u001b[B') { dialog.highlight = Math.min(2, dialog.highlight + 1); redraw(); return }
      return
    }
    if (key === '\r') { const text = input.trim(); input = ''; redraw(); if (text) submit(text); return }
    if (key === '\u007f') { input = input.slice(0, -1); redraw(); return }
    if (key === '\u0003') { cleanup(); return }
    if (key.startsWith('\u001b')) return
    input += key
    redraw()
  }
  function splitKeys(chunk) {
    const keys = []
    for (let i = 0; i < chunk.length;) {
      if (chunk[i] === '\u001b' && chunk[i + 1] === '[' && i + 2 < chunk.length) { keys.push(chunk.slice(i, i + 3)); i += 3; continue }
      keys.push(chunk[i]); i++
    }
    return keys
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { for (const key of splitKeys(chunk)) onKey(key) })

  // ── the control file ───────────────────────────────────────────────────────────────────────────────
  // Only what is appended from now on: another session in the same folder may have left ops behind.
  let ctlRead = (() => { try { return statSync(ctlFile).size } catch { return 0 } })()
  const ctlTimer = setInterval(() => {
    let size = 0
    try { size = statSync(ctlFile).size } catch { return }
    if (size <= ctlRead) return
    const text = readFileSync(ctlFile, 'utf8').slice(ctlRead)
    const complete = text.lastIndexOf('\n') + 1
    ctlRead += Buffer.byteLength(text.slice(0, complete))
    for (const line of text.slice(0, complete).split('\n').filter(Boolean)) {
      let op
      try { op = JSON.parse(line) } catch { continue }
      if (op.op === 'prompt' && typeof op.text === 'string') submit(op.text)
      else if (op.op === 'change' && dialog && typeof op.command === 'string') {
        // Claude asks about the next tool call: a new tool_use, a new dialog in the same place.
        const id = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        toolResult(dialog.toolId, 'superseded', true)
        assistant([{ type: 'tool_use', id, name: 'Bash', input: { command: op.command, description: `Run ${op.command}` } }], 'tool_use')
        dialog.toolId = id
        dialog.command = op.command
        dialog.description = `Run ${op.command}`
        redraw()
        event({ kind: 'dialog-changed', command: op.command })
      } else if (op.op === 'cursor' && dialog) {
        dialog.highlight = op.dir === 'up' ? Math.max(0, dialog.highlight - 1) : Math.min(2, dialog.highlight + 1)
        redraw()
        event({ kind: 'cursor', highlight: dialog.highlight })
      } else if (op.op === 'key' && typeof op.key === 'string') onKey(op.key)   // the person, at the pane
      else if (op.op === 'exit') cleanup()
    }
  }, 100)
  // The ticking timer: only the timer line changes, as it does on Hermes and Muse.
  const tick = setInterval(() => { if (dialog?.timer) redraw() }, 1000)

  function cleanup() {
    clearInterval(ctlTimer)
    clearInterval(tick)
    void hook('SessionEnd', { reason: 'exit' }).finally(() => { out('\r\n'); process.exit(0) })
  }
  process.on('SIGTERM', cleanup)
  process.on('SIGHUP', () => process.exit(0))

  out('\u001b[2J\u001b[H')
  print(' ✳ Claude Code (daemons e2e fake) v2.1.232', `   ${cwd.split('/').slice(-2).join('/')}`, '')
  event({ kind: 'start', transcript })
  // The positional prompt, past every flag and flag value harnessd may pass.
  const VALUED = new Set(['--permission-mode', '--resume', '--model', '--settings', '--mcp-config', '--allowedTools', '--allowed-tools',
    '--append-system-prompt', '--session-id', '--add-dir', '--agent', '--effort', '--disallowedTools'])
  let firstPrompt = null
  for (let i = 0; i < argv.length; i++) {
    if (VALUED.has(argv[i])) { i++; continue }
    if (argv[i].startsWith('-')) continue
    firstPrompt = argv[i]
  }
  void hook('SessionStart', { source: 'startup', model: { id: 'claude-e2e-fake', display_name: 'Fake' } }).then(() => {
    event({ kind: 'session-start-hook' })
    if (firstPrompt && !argv.includes('--resume')) submit(firstPrompt)
  })
}
