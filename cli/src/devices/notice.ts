/**
 * `harness device notify "<one line>"`: an agent's one line for the person, posted to the devices' own listener, which
 * rings the dial with it (docs/plans/2026-11-16-dial-agent-notify-design.md). An agent runs it, often with a command's
 * output pasted in: any text is one line and exit 0, never an error, so the agent's turn goes on.
 */
import { basename } from 'node:path'
import { isNoticeResult, NOTICE_SESSION, noticeFolder, noticeLine, type NoticeAsk } from '../lib/dialNotice.js'
import { askDevices } from './listenerClient.js'

export const NOTICE_USAGE = 'harness device notify "<one line>" [--json]  for an agent: ring the dial when it needs the person to act'

export interface NoticeDeps {
  dataDir: string
  env: NodeJS.ProcessEnv
  cwd: string
  out(line: string): void
  err(line: string): void
  /** `askDevices` by default. */
  ask?: (message: { type: 'notice' } & NoticeAsk) => Promise<Record<string, unknown> | null>
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

/** [words]: what follows `notify`. 0 with `shown`, `no dial` or `limited` on stdout; 1 with the usage when there is no text. */
export async function runNotice(words: string[], deps: NoticeDeps): Promise<number> {
  const text = noticeLine(words.filter((word) => word !== '--json').join(' '))
  if (!text) {
    deps.err(NOTICE_USAGE)
    return 1
  }
  const ask = deps.ask ?? ((message) => askDevices(deps.dataDir, { ...message }))
  const answer = await ask({ type: 'notice', text, ...noticeCaller(deps.env, deps.cwd) })
  const said = answer?.result
  const result = isNoticeResult(said) ? said : 'no dial'
  deps.out(words.includes('--json') ? JSON.stringify({ result }) : result)
  return 0
}
