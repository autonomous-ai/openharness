/**
 * `harness device codex asked`: the client Codex's PermissionRequest and PreToolUse (request_user_input) hooks run
 * (plugins/harness-device, hooks/codex.json). It tells the daemon that a turn waits on the person, as
 * `harness device claude asked` does, and decides nothing.
 *
 * No field of Codex's hook input says whether a dialog follows, and Codex runs the hook before its automatic review, so
 * the turn's own setting is read from the session's rollout (codexTurn.ts): a permission ask posts only when the person
 * reviews it, a question only in Plan mode. Anything else posts nothing.
 *
 * What leaves this process is six typed fields: the engine, the session, the event, the tool's name, a one-line summary
 * and the cwd. Of the tool's input only the summary's line leaves (a command's first line, a patch's first file, a
 * question's text); the rest of it and of the rollout never reaches the daemon.
 */
import { MAX_TOOL_CHARS, askedLine, askedSummary, cwdField, tellAsked, type AskedBody } from './asked.js'
import { readTurnSetting } from './codexTurn.js'

/** The first file a patch adds, updates or deletes. */
const PATCH_FILE = /^[ \t]*\*\*\* (?:Add|Update|Delete) File: (.*)$/m

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== ''

/** The ask's one line: what the tool acts on, or its name when its input does not say. */
export function codexAskedSummary(tool: string, input: unknown): string {
  // Codex's Bash takes Claude Code's input shape, so its line is Claude Code's.
  if (tool === 'Bash') return askedSummary(tool, input)
  const fields = isRecord(input) ? input : {}
  let shown = ''
  if (tool === 'apply_patch' && typeof fields.command === 'string') shown = PATCH_FILE.exec(fields.command)?.[1] ?? ''
  else if (tool === 'request_user_input' && Array.isArray(fields.questions)) {
    const first: unknown = fields.questions[0]
    if (isRecord(first) && typeof first.question === 'string') shown = first.question
  }
  return askedLine(shown, tool)
}

/** Codex's hook input as the body to post, or null when no dialog follows or the input cannot say. */
export function codexAskedBody(input: Record<string, unknown>, codexHome: string): AskedBody | null {
  const { session_id: sessionId, turn_id: turnId, transcript_path: transcript, hook_event_name: event, tool_name: tool } = input
  if (!nonEmpty(sessionId) || !nonEmpty(turnId) || !nonEmpty(transcript) || !nonEmpty(tool)) return null
  if (event === 'PermissionRequest') {
    if (readTurnSetting(transcript, turnId, codexHome)?.reviewer !== 'user') return null
  } else if (event === 'PreToolUse' && tool === 'request_user_input') {
    if (readTurnSetting(transcript, turnId, codexHome)?.mode !== 'plan') return null
  } else return null
  return {
    engine: 'codex', sessionId, event: 'asked', tool: tool.slice(0, MAX_TOOL_CHARS),
    summary: codexAskedSummary(tool, input.tool_input), ...cwdField(input.cwd),
  }
}

/** Tells the daemon once and exits 0 whatever happens, with [codexHome] the session's Codex home. */
export function runCodexAsked(deps: {
  stdin: AsyncIterable<Buffer | string>
  post(body: AskedBody): Promise<void>
  codexHome: string
}): Promise<0> {
  return tellAsked(deps.stdin, deps.post, (input) => codexAskedBody(input, deps.codexHome))
}
