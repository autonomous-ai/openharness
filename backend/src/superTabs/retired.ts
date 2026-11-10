import { z } from 'zod'

/**
 * Commands of Swarm v1-v3 that v4 no longer has (anh Dee, 2026-11-09). An app, a host or an agent from before v4 may still send
 * one, so each is accepted and answered as ignored instead of refused as unknown. Like `updateRequired` in routes/superTabs.ts,
 * the answer is one constant for everyone and names no Swarm, agent or machine: nothing is read, written or checked, so there is
 * nothing to protect. (A command whose schema and checks stay and which only keeps nothing answers through `ignored()` in
 * commands.ts; it moves here once its payload code goes.)
 *
 * A pull request that removes a command's code adds its type here, with an old payload in retired.test.ts. Delete this file, its
 * schemas in commands.ts, its answer in store.ts and its counter in lib/metrics.ts 30 days after the backend release that carries
 * it, and not before 2026-12-09: `swarm_retired_commands_total` says whether an older client still sends one.
 */
export const RETIRED_COMMANDS = [
  'process.confirm', 'project.digest', 'machine.projects', 'machine.ownAccountWork', 'machine.access',
  'member.status', 'member.timeZone', 'member.username', 'member.name',
  // Decisions (2026-11-10): an agent reaches its person in their 1:1 chat.
  'decision.ask', 'decision.answer',
  // Tags (2026-11-10): an older app's Done on a tag.
  'mention.done',
  // Review steps, check verdicts and merge records (2026-11-10): a task is the project's GitHub issue, and its pull request is GitHub's.
  'work.check', 'conversation.merged',
  // Task records and the crew dispatch (2026-11-10): a task is the project's GitHub issue, and an agent works on what its person asks.
  'work.assign', 'work.status', 'work.cancel', 'work.define', 'work.queue', 'work.priority', 'work.pause', 'work.resume', 'work.lane',
  'member.start', 'member.helper',
  // A task's pull request taken off it (2026-11-10): a task is the project's GitHub issue, which links its own.
  'conversation.unlink',
  // The Board way of working and task approval (2026-11-10): an older Desktop's Board settings, Accept and Decline, and its PM's
  // suggestion. A project switched before keeps its stored settings, read where they apply (boardRights.ts).
  'project.process', 'project.boardMode', 'project.canChat', 'project.decider', 'member.approvalMode', 'task.suggest', 'task.approve', 'task.reject',
] as const
export type RetiredCommand = (typeof RETIRED_COMMANDS)[number]

const retired: ReadonlySet<unknown> = new Set(RETIRED_COMMANDS)
export const isRetiredCommand = (type: unknown): type is RetiredCommand => retired.has(type)

/** A step or a linked task an older CLI's agent opens: conversation.create naming `reviewOf` or `step` (2026-11-10). It is answered
 *  and counted as a retired command, under this type; the fields go from conversation.create's schema with this file. */
export const RETIRED_STEP = 'conversation.create.step'
export const opensRetiredStep = (command: { type?: unknown; reviewOf?: unknown; step?: unknown } | undefined): boolean =>
  command?.type === 'conversation.create' && (command.reviewOf !== undefined || command.step !== undefined)

const TASKS_RETIRED = { code: 'TASKS_RETIRED', status: 410, message: 'Tasks are GitHub issues now.' }
const BOARD_RETIRED = { code: 'BOARD_RETIRED', status: 410, message: 'Board settings can’t be changed any more.' }
/** A check verdict a person records in an older Desktop's work details (work.check) is refused in these words, which it shows
 *  where the verdict was typed, rather than answered as ignored: the app takes an ok answer for a saved verdict and closes the
 *  form. An agent's is ignored, as any retired command's. Goes with this file's commands, not before 2026-12-09. */
export const REFUSED_TO_PEOPLE: Partial<Record<RetiredCommand, { code: string; status: number; message: string }>> = {
  'work.check': { code: 'CHECKS_RETIRED', status: 410, message: 'Checks can’t be recorded any more.' },
  // An older Desktop's Next up, priority and pause on a task, its Accept and Decline and its approval mode: its tasks are the
  // project's GitHub issues now.
  'work.queue': TASKS_RETIRED, 'work.priority': TASKS_RETIRED, 'work.pause': TASKS_RETIRED,
  'task.approve': TASKS_RETIRED, 'task.reject': TASKS_RETIRED, 'member.approvalMode': TASKS_RETIRED,
  // An older Desktop's Board settings: it takes an ok answer for a setting saved.
  'project.process': BOARD_RETIRED, 'project.boardMode': BOARD_RETIRED, 'project.canChat': BOARD_RETIRED, 'project.decider': BOARD_RETIRED,
}

/** One schema per type, as every command has. The parse drops whatever else the old client sent: nothing of it is kept or
 *  logged, and the route's body limit bounds it as it does every command. */
export const retiredCommandSchemas = RETIRED_COMMANDS.map(type => z.object({ type: z.literal(type) }))

/** A person's Tasks feed as it reads empty: reset, so a Desktop that restored the rows it saved drops them. Sent in place of the
 *  feed on a person's first load and change polls, and as the feed's own read; goes with the reads below, not before 2026-12-10. */
export const NO_PERSONAL_TASKS = { approvalMode: 'autoApprove', reset: true, upserts: [], removed: [], olderCursor: null } as const

/** Reads of Swarm v1-v3 that an older Desktop, phone or host still makes, each with the empty answer it takes as "nothing here".
 *  As a retired command's, one constant answer for everyone, whatever Swarm and query it names: nothing is read, so nothing is
 *  shown that the caller may not see. Each goes with this file's commands, not before 2026-12-09. */
export const RETIRED_READS: Readonly<Record<string, object>> = {
  // The daily scorecard (2026-11-09): an older Desktop's Scorecard tab.
  '/api/super-tabs/:tabId/scorecard': { days: [] },
  // Decisions (2026-11-10): an older Desktop's and phone's Decisions, and an older host's or Buddy's own asks.
  '/api/super-tabs/:tabId/decisions': { more: false, decisions: [] },
  // Tags, Activity, reminders, followed threads, the inbox and catch-up (2026-11-10): an older Desktop's and phone's.
  '/api/super-tabs/:tabId/mentions': { mentions: [] },
  '/api/super-tabs/:tabId/activity': { items: [], more: false },
  '/api/super-tabs/:tabId/reminders': { due: [], next: null },
  '/api/super-tabs/:tabId/threads': { unread: [], read: [], more: false },
  '/api/super-tabs/:tabId/inbox': { threads: [], latest: [], more: false },
  // Personal tasks (2026-11-10): an older Desktop's and phone's own tasks, now the project's GitHub issues.
  '/api/super-tabs/:tabId/personal-tasks': NO_PERSONAL_TASKS,
}

/** An older Desktop's catch-up of a chat since its mark (GET .../conversations/:conversationId/catch-up?after=N): nothing missed,
 *  its span ending where it started, so it never reads back past the mark it sent. Goes with the reads above. */
export const retiredCatchUp = (after: unknown): object => {
  const at = Number.isSafeInteger(Number(after)) && Number(after) >= 0 ? Number(after) : 0
  const none = { total: 0, items: [] }
  return { after: at, through: at, unread: 0, more: false, decisions: 0, landed: none, blocked: none, needsYou: none }
}

/** Writes of the same reads an older app still sends, each answered as done and changing nothing: Activity read up to a time, and a
 *  thread followed or unfollowed. As the reads, one constant answer for everyone; they go with them, not before 2026-12-09. */
export const RETIRED_WRITES: Readonly<Record<string, object>> = {
  '/api/super-tabs/:tabId/activity/read': { marked: 0 },
  '/api/super-tabs/:tabId/conversations/:conversationId/threads/:threadId/follow': { follow: null },
}

/** An older Desktop's Remind me sets a reminder (POST .../messages/:messageId/reminder): refused in these words rather than answered
 *  as kept, since the app would show one that never comes. Clearing one answers that none was cleared. Goes with the reads above. */
export const REMINDERS_RETIRED = { code: 'REMINDERS_RETIRED', status: 410, message: 'Reminders are gone. Nothing was set.' } as const

/** What a retired command's result says, where an agent or an older app prints a command's answer. */
export const RETIRED_NOTE = 'Swarm no longer has this. Nothing was done.'

/** A retired command's whole answer: it says it was ignored and changed no part. */
export const retiredAnswer = (): { result: Record<string, unknown>; parts: never[] } => ({ result: { ignored: true, note: RETIRED_NOTE }, parts: [] })

/** No picture is set any more (2026-11-09), but an older Desktop or phone still picks one: `member.avatar` or `agent.avatar` with a
 *  picture, and the upload before it (`POST /api/super-tabs/:tabId/avatars`). Each is refused in these words, which both apps
 *  show where the picture was picked, rather than answered as ignored: an app takes an ok answer for a picture set, and reads
 *  the upload's id out of one. Clearing a picture still clears it (profile.ts), so nobody keeps a photo of themselves they want
 *  gone. The refusals go with the two commands' picture shapes, not before 2026-12-09. */
export const PICTURES_RETIRED = { code: 'AVATARS_RETIRED', status: 410, message: 'Pictures can’t be changed any more.' } as const
