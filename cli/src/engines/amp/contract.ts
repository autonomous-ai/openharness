import { join as hookPath } from 'node:path'
import { env as hookEnvironment } from '../../config/env.js'
/**
 * What the core knows of Amp without loading its code: declared data, read by the kit
 * (docs/design/2026-10-08-other-engines-out-of-core.md). It imports no Amp interpreter.
 */
export const contract = {
  /** Its approval rows are stacked and numbered by nothing: a row is reached by walking Down from the first
   *  (askQuestion.ts), and `kit/questionPane.ts` `walkKeys` turns that into keys. */
  questionWalk: 'down',
} as const

/** Native source runs in the engine process; the daemon only renders and installs these bytes. */
export const AMP_PLUGIN = {
  file: hookPath(hookEnvironment.AMP_PLUGIN_DIR, 'launcher-register.ts'),
  template: [
`// session-register — auto-installed by the machine adapter. Binds this Amp thread to the local
// machine daemon (127.0.0.1:`,
{ argument: 'port' },
`) and writes the transcript the daemon tails, because Amp keeps none
// on disk. No-op outside tmux.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const description = 'Mirrors this Amp thread to the machine adapter (web + device)'

const SESSIONS_DIR = `,
JSON.stringify(hookEnvironment.AMP_SESSIONS_DIR),
`

export default function (amp: any) {
  const pane = process.env.TMUX_PANE
  if (!pane) return

  // NOT \`process.cwd()\`: Bun runs a plugin with the PLUGIN's directory as its cwd, so that reports
  // \`<project>/.amp/plugins\` (measured). \`PWD\` is inherited from the shell that launched plain Amp.
  const workdir = process.env.PWD || process.cwd()

  const emitted = new Set()
  // Turn ids already opened/closed. Amp re-dispatches a message it could not deliver, firing agent.start
  // a SECOND time for the same message id (measured: two identical turn_start records 61s apart, then a
  // turn_end 'done' and a turn_end 'error' for the one turn). Written straight through, that is two turns
  // on web and device and two user bubbles in history.
  const turnsStarted = new Set()
  const turnsEnded = new Set()
  // Tool ids already written, so a tool seen BOTH as an event and as a message block is written once.
  const toolCalls = new Set()
  const toolResults = new Set()
  let registered = false
  let file = ''
  let seeded = false

  const line = (record: any) => {
    try {
      mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 })
      appendFileSync(file, JSON.stringify(record) + '\\n')
    } catch {}
  }

  const open = (threadId: string) => {
    if (file) return
    file = join(SESSIONS_DIR, threadId + '.jsonl')
    // \`cwd\` on the first line is what lets the daemon re-find this session by directory after a restart,
    // the same way it reads claude's and pi's transcripts. It must be a top-level string field.
    line({ t: 'session', threadId, cwd: workdir, at: Date.now() })
  }

  const register = async (threadId: string) => {
    open(threadId)
    if (registered || !existsSync(file)) return
    try {
      const token = readFileSync(`,
{ argument: 'credential' },
`, 'utf8').trim()
      if (!token) return
      const res = await fetch('http://127.0.0.1:`,
{ argument: 'port' },
`/api/hook/session-start', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-harness-hook-token': token },
        body: JSON.stringify({
          engine: 'amp',
          pluginVersion: `,
{ argument: 'version' },
`,
          sessionId: threadId,
          transcriptPath: file,
          cwd: workdir,
          tmuxPane: pane,
          callerPid: process.pid,
          runtimeHints: [
            ...(pane ? [{ backend: 'tmux', paneId: pane }] : []),
          ],
        }),
      })
      if (res.ok) registered = true
    } catch {}
  }

  const resultId = (block: any) => String(block.toolUseID || block.tool_use_id || '')

  /**
   * Write everything in the thread that has not been written yet.
   *
   * This reads message BLOCKS rather than events, because the events do not cover the thread:
   *
   *   - no event carries assistant text at all, and
   *   - \`tool.call\`/\`tool.result\` only fire for tools the CLIENT executes. MEASURED: a \`web_search\`
   *     turn produced no tool event and no tool lease in Amp's own log, yet the message plainly held a
   *     \`tool_use\` block — Amp runs that tool on its server. Skipping blocks meant a search rendered as
   *     nothing at all on web and device while the pane showed "Explored 1 search".
   *
   * \`seed\` marks what already exists WITHOUT writing it, for a thread that is being resumed: those
   * messages belong to earlier turns, and replaying them made a fresh turn open with an old answer in it.
   */
  const drain = async (ctx: any) => {
    let messages: any[] = []
    try { messages = await ctx.thread.messages({ from: 'end', limit: 20 }) } catch { return }
    // The FIRST drain of this plugin instance only claims what it finds; it writes nothing. That covers
    // both ways a plugin meets a thread that already has messages: a resumed thread, and a plugin reload
    // (Amp loads a plugin ONCE per process, so reload is how a running pane picks up a new build). Without
    // it, the next prompt replayed the whole recent history as if it had just happened.
    const seed = !seeded
    seeded = true
    // The seed pass would swallow the very prompt the turn needs to open on. Measured: \`session.start\`
    // does NOT fire when Amp launches — it fires on the first submit, and by then the thread already
    // holds one \`user\` message. So the seed has to tell history from the live prompt, and the test is
    // whether anything answered it: the LAST user text block with no assistant message after it is
    // waiting, not past. On a resumed thread the last message is an assistant one, so nothing opens.
    let liveUserId = ''
    for (const message of messages) {
      if (message.role === 'assistant') { liveUserId = ''; continue }
      const parts = Array.isArray(message.content) ? message.content : []
      const hasText = parts.some((b: any) => b && b.type === 'text' && typeof b.text === 'string' && b.text)
      if (hasText) liveUserId = String(message.id)
    }
    for (const message of messages) {
      const blocks = Array.isArray(message.content) ? message.content : []
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i]
        if (!block) continue
        if (block.type === 'text' || block.type === 'thinking') {
          const key = String(message.id) + '#' + i
          if (emitted.has(key)) continue
          const text = typeof block.text === 'string' ? block.text : block.thinking
          if (typeof text !== 'string' || !text) continue
          emitted.add(key)
          // A user TEXT block opens the turn.
          //
          // Amp used to announce that with an \`agent.start\` event, and the handler below wrote
          // \`turn_start\` from it. That event no longer fires — probed with a plugin that registered for
          // sixteen candidate names on amp 0.0.1786681855 and saw only \`session.start\`, \`tool.call\`,
          // \`tool.result\` and \`agent.end\`. The prompt now reaches a plugin no earlier than
          // \`agent.end\`, which is the END of the turn, far too late to open one.
          //
          // So it is taken from the thread instead, where drain was already reading it and dropping it:
          // measured at the first \`tool.call\` of a turn, \`messages()\` already returns the prompt, oldest
          // first. Without this the turn opens with an empty question on web and device, and the recap
          // loses what was asked.
          //
          // Only a TEXT block qualifies: a tool_result is also carried on a \`user\` message, so matching
          // the role alone would open a turn on every tool that returned.
          if (message.role !== 'assistant') {
            const turnId = String(message.id)
            if (turnsStarted.has(turnId)) continue
            turnsStarted.add(turnId)
            if (!seed || turnId === liveUserId) line({ t: 'turn_start', id: turnId, message: text, at: Date.now() })
            continue
          }
          if (!seed) line({ t: block.type, id: message.id, i, text })
        } else if (block.type === 'tool_use') {
          const id = String(block.id || '')
          if (!id || toolCalls.has(id)) continue
          toolCalls.add(id)
          if (!seed) line({ t: 'tool_call', id, tool: block.name, input: block.input })
        } else if (block.type === 'tool_result') {
          const id = resultId(block)
          if (!id || toolResults.has(id)) continue
          toolResults.add(id)
          // A server-run tool puts its payload under \`run\`; a client-run one under \`content\`/\`output\`.
          if (!seed) line({ t: 'tool_result', id, status: 'done', output: block.run ?? block.content ?? block.output })
        }
      }
    }
  }

  amp.on('session.start', async (event: any, ctx: any) => {
    await register(event.thread.id)
    await drain(ctx)
  })

  amp.on('agent.start', async (event: any, ctx: any) => {
    await register(event.thread.id)
    const id = String(event.id)
    if (!turnsStarted.has(id)) {
      turnsStarted.add(id)
      line({ t: 'turn_start', id: event.id, message: event.message, at: Date.now() })
    }
    await drain(ctx)
  })

  amp.on('tool.call', async (event: any, ctx: any) => {
    await register(event.thread.id)
    // CLAIM THE ID FIRST. \`drain\` runs before this card so a message's prose lands ahead of the tool it
    // called — but by then the tool_use block for THIS tool is already in the thread, so draining without
    // claiming wrote the card twice (measured: one Task turn produced two identical \`skill\` cards).
    toolCalls.add(String(event.toolUseID))
    await drain(ctx)
    line({ t: 'tool_call', id: event.toolUseID, tool: event.tool, input: event.input })
  })

  amp.on('tool.result', async (event: any, ctx: any) => {
    // Same rule as tool.call: claim before draining.
    toolResults.add(String(event.toolUseID))
    line({
      t: 'tool_result',
      id: event.toolUseID,
      tool: event.tool,
      status: event.status,
      output: event.output,
    })
    await drain(ctx)
  })

  amp.on('agent.end', async (event: any, ctx: any) => {
    await drain(ctx)
    // \`message\` is the prompt that STARTED this turn, and agent.end carries it even when
    // agent.start never fired (a prompt queued while Amp was connecting). Recording it here is what
    // lets history still show what was asked — see the replay branch in the normalizer.
    const id = String(event.id)
    if (turnsEnded.has(id)) return
    turnsEnded.add(id)
    line({ t: 'turn_end', id: event.id, status: event.status, message: event.message, at: Date.now() })
  })
}
`
],
  directories: [{ path: hookEnvironment.AMP_SESSIONS_DIR, mode: 0o700 }],
  messages: {
  "current": "[hooks] Amp plugin already installed",
  "installed": "[hooks] installed Amp plugin → {file}",
  "after": [
    "[hooks] a NEW amp session picks this up automatically; for one already open, run",
    "[hooks]   ctrl+o → 'plugins: reload'   (or restart that pane)"
  ],
  "failed": "[hooks] failed to write Amp plugin:"
},
} as const satisfies import('../kit/nativePlugin.js').NativePlugin
