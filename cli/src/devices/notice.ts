/**
 * `harness device notify "<question>"`: an agent's one line for the person, posted to the devices' own listener, which
 * rings the dial with it (docs/plans/2026-11-16-dial-agent-notify-design.md). An agent runs it, often with a command's
 * output pasted in: any text is one line and exit 0, never an error, so the agent's turn goes on. The question, its
 * `--suggest` and `--waiting|--proceeding` make that one line, `Waiting · <q> · Suggest: <s>`,
 * `Proceeding · <q> · Doing: <s>` or `<q> · Suggest: <s>` (docs/plans/2026-11-22-needs-you-notify-design.md).
 * A card stays until its agent closes it: `--list` shows the caller's open cards and `--done <id>|all` closes them
 * (docs/plans/2026-11-27-dial-notice-cards-agent-closes-design.md).
 */
import { basename } from 'node:path'
import {
  composeNotice, isNoticeCard, isNoticeResult, NOTICE_CARD_ID, NOTICE_LIST_ANSWER_MAX, NOTICE_SESSION, noticeFolder,
  parseNotice, type NoticeAsk,
} from '../lib/dialNotice.js'
import { askDevices } from './listenerClient.js'

export const NOTICE_USAGE = 'harness device notify "<question>" [--suggest "<recommendation>"] [--waiting|--proceeding] [--json]  for an agent: ring the dial when it needs the person to decide or act; --list [--json] shows your open cards, --done <id>|all closes them'

export interface NoticeDeps {
  dataDir: string
  env: NodeJS.ProcessEnv
  cwd: string
  out(line: string): void
  err(line: string): void
  /** `askDevices` by default; [options.why] hears the reason for a null. */
  ask?: (message: { type: string } & Record<string, unknown>, options?: { maxBytes?: number; why?: (reason: string) => void }) =>
    Promise<Record<string, unknown> | number | null>
}

/** A card's age as `--list` prints it: seconds under a minute, minutes under an hour, else hours. */
export function formatAge(ageS: number): string {
  if (ageS < 60) return `${ageS}s`
  return ageS < 3600 ? `${Math.floor(ageS / 60)}m` : `${Math.floor(ageS / 3600)}h`
}

const session = (id: string | undefined): id is string => id !== undefined && NOTICE_SESSION.test(id)

/** Who calls, from this process's own environment and folder: nothing else of either leaves it. */
export function noticeCaller(env: NodeJS.ProcessEnv, cwd: string): Pick<NoticeAsk, 'engine' | 'sessionId' | 'folder'> {
  const caller: Pick<NoticeAsk, 'engine' | 'sessionId' | 'folder'> = {}
  // CLAUDECODE says Claude Code itself runs this command: without it, the session id was handed down from elsewhere.
  if (env.CLAUDECODE === '1' && session(env.CLAUDE_CODE_SESSION_ID)) {
    caller.engine = 'claude'
    caller.sessionId = env.CLAUDE_CODE_SESSION_ID
  } else if (session(env.CODEX_THREAD_ID)) {
    caller.engine = 'codex'
    caller.sessionId = env.CODEX_THREAD_ID
  }
  const folder = noticeFolder(basename(cwd))
  if (folder) caller.folder = folder
  return caller
}

/** [words]: what follows `notify`. `--done` first, then `--list`, then the question, so closing or listing never rings.
 *  0 with `shown <id>`, `shown`, `no dial` or `limited` on stdout; 1 with the usage when there is no question: none,
 *  flags alone, or only `--help` or `-h`. */
export async function runNotice(words: string[], deps: NoticeDeps): Promise<number> {
  const { question, suggest, state, json, list, done } = parseNotice(words)
  const ask = deps.ask ?? ((message, options) => askDevices(deps.dataDir, message, options))
  const caller = noticeCaller(deps.env, deps.cwd)
  if (done !== undefined || list) {
    // Typed outside an agent's session, the caller names no cards: nothing is asked.
    if (!caller.sessionId) return 0
    // Every outcome exits 0 and prints nothing, a malformed id too: an agent that lost track of its cards after a
    // compaction can run it safely.
    if (done !== undefined) {
      if (done === 'all' || NOTICE_CARD_ID.test(done)) await ask({ type: 'noticeDone', ...caller, id: done })
      return 0
    }
    const answer = await ask({ type: 'noticeList', ...caller }, { maxBytes: NOTICE_LIST_ANSWER_MAX })
    const listed = typeof answer === 'object' ? answer?.cards : undefined
    // Another process's answer: only what is a card is printed, and only a card's own fields.
    const cards = (Array.isArray(listed) ? listed : []).filter(isNoticeCard)
      .map(({ id, ageS, kind, line }) => ({ id, ageS, kind, line }))
    if (cards.length === 0) return 0
    if (json) deps.out(JSON.stringify(cards))
    else for (const card of cards) deps.out(`${card.id} ${formatAge(card.ageS)} ${card.kind} ${card.line}`)
    return 0
  }
  const text = composeNotice(question, suggest, state)
  if (!text) {
    deps.err(NOTICE_USAGE)
    return 1
  }
  let reason: string | undefined
  const answer = await ask({ type: 'notice', text, ...caller }, { why: (said) => { reason = said } })
  const said = typeof answer === 'object' ? answer?.result : undefined
  // The listener's own rate (429) refuses a loop of notices before the devices hear them: over a limit all the same.
  const result = answer === 429 ? 'limited' : isNoticeResult(said) ? said : 'no dial'
  // A card shown has its id, so its agent can close it without a list. A caller with no session gets none: `--done`
  // sends nothing without one.
  const given = typeof answer === 'object' ? answer?.id : undefined
  const id = result === 'shown' && caller.sessionId && typeof given === 'string' && NOTICE_CARD_ID.test(given)
    ? given
    : undefined
  if (json) deps.out(JSON.stringify(id ? { result, id } : { result }))
  else deps.out(id ? `${result} ${id}` : result)
  if (typeof answer === 'number' && answer !== 429) reason = `status ${answer}`
  else if (answer !== null && typeof answer === 'object' && !isNoticeResult(said)) reason = 'unknown result'
  // A no dial says why, so a failed run shows which one it was. Not for `no listener`: an agent's shell would see it
  // each time no devices run. Only `notify` writes it: dial-watch's stderr is the Device app's log, attach promises none.
  if (reason && reason !== 'no listener') deps.err(`harness device notify: ${reason}`)
  return 0
}
