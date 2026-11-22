/**
 * `harness device notify "<question>"`: an agent's one line for the person, posted to the devices' own listener, which
 * rings the dial with it (docs/plans/2026-11-16-dial-agent-notify-design.md). An agent runs it, often with a command's
 * output pasted in: any text is one line and exit 0, never an error, so the agent's turn goes on. The question, its
 * `--suggest` and `--waiting|--proceeding` make that one line, `Waiting · <q> · Suggest: <s>`,
 * `Proceeding · <q> · Doing: <s>` or `<q> · Suggest: <s>` (docs/plans/2026-11-22-needs-you-notify-design.md).
 */
import { basename } from 'node:path'
import { composeNotice, isNoticeResult, NOTICE_SESSION, noticeFolder, type NoticeAsk, type NoticeState } from '../lib/dialNotice.js'
import { askDevices } from './listenerClient.js'

export const NOTICE_USAGE = 'harness device notify "<question>" [--suggest "<recommendation>"] [--waiting|--proceeding] [--json]  for an agent: ring the dial when it needs the person to decide or act'

export interface NoticeDeps {
  dataDir: string
  env: NodeJS.ProcessEnv
  cwd: string
  out(line: string): void
  err(line: string): void
  /** `askDevices` by default. */
  ask?: (message: { type: 'notice' } & NoticeAsk) => Promise<Record<string, unknown> | number | null>
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

export interface NoticeWords { question: string; suggest?: string; state?: NoticeState; json: boolean }

/** [words]: what follows `notify`. `--suggest` takes the next word whatever it is, so an agent's slip
 *  (`--suggest --proceeding`) is still a ring; the last one decides. `--waiting` wins over `--proceeding`, the safer
 *  word. Every other word, `-x` and `--suggest=x` too, is the question, joined by one space and not yet cleaned. */
export function parseNotice(words: readonly string[]): NoticeWords {
  const question: string[] = []
  let suggest: string | undefined
  let state: NoticeState | undefined
  let json = false
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word === '--suggest') suggest = words[++i]
    else if (word === '--waiting') state = 'waiting'
    else if (word === '--proceeding') state ??= 'proceeding'
    else if (word === '--json') json = true
    else question.push(word)
  }
  return { question: question.join(' '), suggest, state, json }
}

/** [words]: what follows `notify`. 0 with `shown`, `no dial` or `limited` on stdout; 1 with the usage when there is no text. */
export async function runNotice(words: string[], deps: NoticeDeps): Promise<number> {
  const { question, suggest, state, json } = parseNotice(words)
  const text = composeNotice(question, suggest, state)
  if (!text) {
    deps.err(NOTICE_USAGE)
    return 1
  }
  const ask = deps.ask ?? ((message) => askDevices(deps.dataDir, { ...message }))
  const answer = await ask({ type: 'notice', text, ...noticeCaller(deps.env, deps.cwd) })
  const said = typeof answer === 'object' ? answer?.result : undefined
  // The listener's own rate (429) refuses a loop of notices before the devices hear them: over a limit all the same.
  const result = answer === 429 ? 'limited' : isNoticeResult(said) ? said : 'no dial'
  deps.out(json ? JSON.stringify({ result }) : result)
  return 0
}
