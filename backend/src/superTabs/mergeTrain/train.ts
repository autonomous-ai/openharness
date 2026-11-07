/**
 * The merge train (task #3402, anh Dee's Swarm redesign, 2026-11-05): one pass per project merges what passed, in batches,
 * through the Harness GitHub App. docs/plans/2026-11-05-merge-train-plan.md.
 *
 * A pass first finishes the batches it has open: one green at its tip, with main and every member's head read again and still
 * eligible, is squash-merged at that tip; its originals are closed with a link and their merges recorded on their tasks. A red
 * one splits by component (a member red on its own goes back to its owner); one built on an older main, changed by anyone
 * else, not built by this worker (a restart) or stuck in CI is closed and built again. Then, with no batch open, docs and
 * scripts merge on their own green CI and the rest go into a new batch.
 *
 * The batch pull request is never handed to the Swarm: no task links it, so no push-origin read of a task ever sees the
 * bot's branch (pushOrigin.ts). Its tip is the one this worker made, held in memory: a branch someone else pushed to is never
 * merged, as its tip no longer matches.
 */
import { TrainReadError, type TrainGitHub, type TrainPull } from '../../github/train.js'
import { NOT_MERGEABLE_BY_TOKEN, TRAIN_BRANCH_PREFIX, TRAIN_CI_TIMEOUT_MS, TRAIN_MAX_BATCH } from './config.js'
import { eligible, headReads, laneOf, skipReason, splitRed, type Ineligible, type TrainTask } from './plan.js'
import { requiredReads, type ProjectRules } from '../policy.js'

/** A task's linked pull request, as the Swarm holds it: what headReads reads. */
export interface TrainTaskPull { taskId: string; url: string; task: TrainTask }

/** What the train asks of the Swarm. */
export interface TrainSwarm {
  /** The project's open tasks and the pull requests each links. */
  pulls(): Promise<TrainTaskPull[]>
  /** Records [url]'s merge on task [taskId], as conversation.merged does. */
  merged(taskId: string, url: string, mergedAt: number): Promise<void>
  /** Tells task [taskId]'s Engineer [text], once per [key]. */
  tell(taskId: string, url: string, key: string, text: string): Promise<void>
}

interface Member { number: number; url: string; head: string; title: string; files: string[]; taskId: string }
interface Batch { number: number; url: string; branch: string; tip: string; base: string; startedAt: number; members: Member[] }

/** What a worker remembers between passes, per project: its open batches, the heads that failed alone, the parts of red
 *  batches still to run, and for each done task's pull request the reason it was passed over, how many passes in a row, and
 *  whether its Engineer heard it. Lost on a restart, which only closes and rebuilds what was open (and counts the passes again;
 *  a line already written is not written twice, whatever the memory). */
export interface TrainMemory { batches: Map<number, Batch>; failed: Set<string>; splits: string[][]; skips: Map<string, Skip> }
interface Skip { key: string; passes: number; told: boolean }
export const newTrainMemory = (): TrainMemory => ({ batches: new Map(), failed: new Set(), splits: [], skips: new Map() })
/** A done task's pull request is told why it is passed over after this many passes in a row. */
const SKIPS_BEFORE_TELLING = 2

/** The project's rules record as this pass read it: its switch, the review table its reads come from (policy.ts), and the
 *  minutes between passes, which the line to a waiting pull request names. */
export interface TrainRules { enabled: boolean; rules: ProjectRules; everyMinutes?: number }
export type TrainPassLine = { off: true } | { candidates: number; unreadable: number; built: number; merged: number; split: number; closed: number; refused: number; unrecorded: number }

const short = (sha: string) => sha.slice(0, 12)
/** A batch's label: the day and time it was built, in UTC ("11-05 train-1510"). */
const batchLabel = (at: number) => { const d = new Date(at), two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} train-${two(d.getUTCHours())}${two(d.getUTCMinutes())}` }
const PULL = /\/pull\/([1-9][0-9]*)$/

interface Reason { key: string; text: string }
interface Read { member: Member; verdict: { ok: true } | { ok: false; why: Ineligible }; reads: number | string; required: number; lane: 'fast' | 'code'; skip: Reason | null }

export async function trainPass(input: { projectId: string; github: TrainGitHub; swarm: TrainSwarm; memory: TrainMemory; now: number; rules: TrainRules }): Promise<TrainPassLine> {
  const { projectId, github, swarm, memory, now, rules } = input
  if (!rules.enabled) return { off: true }
  const line = { candidates: 0, unreadable: 0, built: 0, merged: 0, split: 0, closed: 0, refused: 0, unrecorded: 0 }
  const prefix = `${TRAIN_BRANCH_PREFIX}${projectId}/`
  let main: string, open: TrainPull[]
  try {
    main = await github.mainHead()
    open = await github.openPulls()
  } catch (error) {
    if (!(error instanceof TrainReadError)) throw error
    line.unreadable++
    return line
  }
  const tasks = await swarm.pulls()
  const taskOf = new Map<string, TrainTaskPull>()
  for (const linked of tasks) if (!taskOf.has(linked.url)) taskOf.set(linked.url, linked)

  /** [url] as it is now: GitHub's answer and the Swarm's verdicts. Null when it is not an open pull request of this repository.
   *  [building]: for a new batch, where the train's own merge into the batch branch tests for a conflict, a code pull request
   *  GitHub has not worked out yet (mergeable null, as it answers for every open one just after main moves) is read as
   *  mergeable; a conflict there leaves it out and tells its Engineer. The fast lane merges on GitHub alone and still waits. */
  const read = async (linked: TrainTaskPull, building = false): Promise<Read | null> => {
    const number = Number(PULL.exec(linked.url)?.[1])
    if (!number) return null
    const pull = await github.pull(number)
    if (pull.state !== 'open' || pull.url.toLowerCase() !== linked.url.toLowerCase() || pull.headRef.startsWith(TRAIN_BRANCH_PREFIX)) return null
    const files = await github.files(number), ciRequired = await github.ciRequired(pull.head)
    const reads = headReads(linked.task, linked.url, pull.head, pull.base), required = requiredReads(rules.rules, files)
    const lane = laneOf(files), mergeable = building && lane === 'code' && pull.mergeable === null ? true : pull.mergeable
    const candidate = { url: linked.url, number, head: pull.head, state: pull.state, draft: pull.draft, base: pull.base, mergeable,
      labels: pull.labels, files, ciRequired }
    const verdict = eligible(candidate, reads, required)
    return { member: { number, url: linked.url, head: pull.head, title: pull.title, files, taskId: linked.taskId }, verdict, reads, required, lane,
      skip: verdict.ok ? null : skipReason(verdict.why, candidate, typeof reads === 'string' ? reads : '') }
  }

  const closeBatch = async (number: number, branch: string, why: string) => {
    memory.batches.delete(number)
    await github.comment(number, `The merge train closed this batch: ${why}. Its pull requests go into the next batch.`)
    await github.close(number)
    await github.deleteBranch(branch)
    line.closed++
  }
  /** The batches this pass closed because main moved under them: their members left waiting hear why, after the build. */
  const moved: Batch[] = []
  const closeMoved = async (batch: Batch) => { await closeBatch(batch.number, batch.branch, 'main moved'); moved.push(batch) }
  const tellRed = (member: Member) => swarm.tell(member.taskId, member.url, `train-red:${member.head}`,
    `CI failed for your pull request #${member.number} in the merge train, on its own with main (head ${member.head.slice(0, 7)}): fix it and push. The train takes it again at its new head. ${member.url}`)

  // Batches are pull requests from this repository's own train branches: a fork's pull request may take any branch name, and
  // closing it would delete the live batch's branch here (review 2 of #3226). A fork's is never touched.
  const ours = open.filter(p => p.headRef.startsWith(prefix) && p.headRepository === github.repository)
  // A batch no longer open (closed by a person, or its branch deleted) is forgotten, or the train would wait on it for good.
  for (const [number, batch] of memory.batches) {
    if (ours.some(p => p.number === number)) continue
    memory.batches.delete(number)
    line.closed++
    await github.deleteBranch(batch.branch).catch(error => { if (!(error instanceof TrainReadError)) throw error; line.unreadable++ })
  }

  // Finish the open batches.
  for (const pull of ours) {
    const batch = memory.batches.get(pull.number)
    try {
      if (!batch || batch.tip !== pull.head) {
        await closeBatch(pull.number, pull.headRef, batch ? 'its branch changed after the train built it' : 'the train did not build it on this server')
        continue
      }
      if (batch.base !== main) { await closeMoved(batch); continue }
      const ci = await github.ciRequired(batch.tip)
      if (ci === 'pending' || ci === null) {
        if (now - batch.startedAt > TRAIN_CI_TIMEOUT_MS) await closeBatch(batch.number, batch.branch, 'its CI did not finish in time')
        continue
      }
      if (ci === 'failure') {
        await closeBatch(batch.number, batch.branch, 'ci/required failed')
        if (batch.members.length === 1) {
          memory.failed.add(`${batch.members[0]!.url}@${batch.members[0]!.head}`)
          await tellRed(batch.members[0]!)
        } else {
          memory.splits.push(...splitRed(batch.members).map(group => group.map(m => m.url)))
          line.split++
        }
        continue
      }
      // Green: read main and every member again, right before merging.
      if (await github.mainHead() !== batch.base) { await closeMoved(batch); continue }
      let still = true
      for (const member of batch.members) {
        const linked = taskOf.get(member.url), current = linked ? await read(linked) : null
        if (!current || !current.verdict.ok || current.member.head !== member.head) { still = false; break }
      }
      if (!still) { await closeBatch(batch.number, batch.branch, 'a pull request in it changed or is no longer approved at its head'); continue }
      // The form main's batches use, which the release watch reads (task #3405): the originals before the batch's own number.
      const title = `Merge batch ${batchLabel(batch.startedAt)}: ${batch.members.map(m => `#${m.number}`).join(' ')} (#${batch.number})`
      let sha: string
      try {
        ({ sha } = await github.squash(batch.number, batch.tip, title, batch.members.map(m => `* ${m.title} (#${m.number})`).join('\n')))
      } catch (error) {
        // GitHub refused the merge itself (branch protection, a permission): trying again refuses again, so the batch closes and
        // its pull requests wait for a new head; each Engineer hears GitHub's reason (review 2 of #3226). No answer is retried.
        if (!(error instanceof TrainReadError) || ![403, 405, 409, 422].includes(error.status)) throw error
        await closeBatch(batch.number, batch.branch, 'GitHub refused to merge it')
        line.refused++
        for (const member of batch.members) {
          memory.failed.add(`${member.url}@${member.head}`)
          await swarm.tell(member.taskId, member.url, `train-refused:${member.head}`,
            `GitHub refused to merge your pull request #${member.number} in the merge train (head ${member.head.slice(0, 7)}): ${error.reason ?? `HTTP ${error.status}`}. Merge it by hand, or push a change that fixes this. ${member.url}`)
        }
        continue
      }
      memory.batches.delete(batch.number)
      main = sha
      // Merged now, whatever happens next: each member's merge is recorded on its own, then each original is closed.
      for (const member of batch.members) {
        try {
          await swarm.merged(member.taskId, member.url, now)
          line.merged++
        } catch { line.unrecorded++ }
      }
      for (const member of batch.members) {
        await github.comment(member.number, `Merged into main in ${sha} by the merge train, in batch ${batch.url}.`)
          .then(() => github.close(member.number))
          .catch(error => { if (!(error instanceof TrainReadError)) throw error; line.unreadable++ })
      }
      await github.deleteBranch(batch.branch).catch(error => { if (!(error instanceof TrainReadError)) throw error; line.unreadable++ })
    } catch (error) {
      if (!(error instanceof TrainReadError)) throw error
      line.unreadable++
    }
  }
  if (memory.batches.size) return line

  // Nothing open: read every candidate, merge the fast lane, and build the next batches.
  // Why each pull request read waits, for the line to a member of a batch main moved under (#4379): null where it had its own
  // line this pass (a conflict, its reads, a workflow change), or where it went into a batch or main.
  const reads: Read[] = [], skipped: Array<{ member: Member; skip: Reason }> = [], waits = new Map<string, string | null>()
  for (const linked of taskOf.values()) {
    try {
      const found = await read(linked, true)
      if (!found || memory.failed.has(`${found.member.url}@${found.member.head}`)) continue
      line.candidates++
      const { member, verdict } = found
      if (found.skip) skipped.push({ member, skip: found.skip })
      waits.set(member.url, verdict.ok ? 'it did not fit the new batch (another pull request in it changes the same files, or it was full)'
        : found.skip?.text ?? null)
      if (!verdict.ok && verdict.why === 'conflict') await tellConflict(swarm, member)
      else if (!verdict.ok && verdict.why === 'reads') {
        await swarm.tell(member.taskId, member.url, `train-reads:${member.head}`,
          `Your pull request #${member.number} needs ${found.required} passed reviews at its head (${member.head.slice(0, 7)}) before the merge train takes it; it has ${found.reads as number}. ${member.url}`)
      } else if (verdict.ok && member.files.some(file => NOT_MERGEABLE_BY_TOKEN.test(file))) {
        await swarm.tell(member.taskId, member.url, `train-workflows:${member.head}`,
          `Your pull request #${member.number} changes CI workflows, which the merge train cannot merge: merge it by hand. ${member.url}`)
        waits.set(member.url, null)
      } else if (verdict.ok) reads.push(found)
    } catch (error) {
      if (!(error instanceof TrainReadError)) throw error
      line.unreadable++
    }
  }
  reads.sort((a, b) => a.member.number - b.member.number)
  try {
    for (const fast of reads.filter(r => r.lane === 'fast')) {
      const { member } = fast
      await github.squash(member.number, member.head, `${member.title} (#${member.number})`, `Merged by the merge train (fast lane).`)
      await swarm.merged(member.taskId, member.url, now)
      waits.set(member.url, null)
      line.merged++
    }
    // Main again, right before building: reading the candidates takes minutes, and a hand merge meanwhile would leave the batch
    // on an older main, closed again at the next pass (#3496 on 11-07, built 46 s after main moved).
    main = await github.mainHead()
  } catch (error) {
    if (!(error instanceof TrainReadError)) throw error
    line.unreadable++
    return line
  }
  const code = reads.filter(r => r.lane === 'code').map(r => r.member)
  const groups = (memory.splits.length ? memory.splits.map(urls => code.filter(m => urls.includes(m.url))) : [code])
    .map(group => {
      const kept = disjoint(group)
      for (const member of group) if (!kept.includes(member)) skipped.push({ member, skip: leftOut(member, kept) })
      return kept
    }).filter(group => group.length)
  memory.splits = []
  for (const [index, group] of groups.entries()) {
    const branch = `${prefix}${now}-${index}`
    try {
      await github.createBranch(branch, main)
      let tip = main
      const members: Member[] = []
      for (const member of group) {
        const merged = await github.mergeInto(branch, member.head, `Merge #${member.number} into the merge train's batch`, tip)
        if (merged === 'conflict') { await tellConflict(swarm, member); waits.set(member.url, null); continue }
        // In main already (merged by hand meanwhile): nothing of it to batch.
        if (merged === 'already') { waits.set(member.url, null); continue }
        tip = merged.sha
        members.push(member)
      }
      if (!members.length) { await github.deleteBranch(branch); continue }
      const body = [`The merge train's batch of ${members.length} pull request${members.length === 1 ? '' : 's'}, built from main at ${short(main)}.`, '',
        ...members.map(m => `- #${m.number} at ${short(m.head)}: ${m.title}`), '',
        'It merges when ci/required is green here and every pull request is still at the head listed. Do not push to this branch.'].join('\n')
      const opened = await github.openPull(branch, `Merge train: ${members.map(m => `#${m.number}`).join(' ')}`, body)
      // Opened at another head than the tip built: someone pushed onto the branch. Never a batch (review 1 of #3226).
      if (opened.head !== tip) { await closeBatch(opened.number, branch, 'its branch changed while the train built it'); continue }
      memory.batches.set(opened.number, { number: opened.number, url: opened.url, branch, tip, base: main, startedAt: now, members })
      for (const member of members) waits.set(member.url, null)
      line.built++
    } catch (error) {
      if (!(error instanceof TrainReadError)) throw error
      line.unreadable++
      for (const member of group) if (waits.get(member.url)) waits.set(member.url, 'GitHub failed while the train built the new batch')
      // Whatever it holds, a branch the train could not finish building is never left behind to be opened later.
      await github.deleteBranch(branch).catch(() => {})
    }
  }
  await tellSkips(swarm, memory, skipped, taskOf)
  await tellMoved(swarm, moved, waits, rules.everyMinutes)
  return line
}

/** Why [member], ready, is not in the batch of [kept]: it shares a file with one that is, or the batch is full. */
function leftOut(member: Member, kept: readonly Member[]): Reason {
  const sharing = kept.find(other => other.files.some(file => member.files.includes(file)))
  return sharing ? { key: `files:${sharing.number}`, text: `it is ready, but changes a file that #${sharing.number} also changes, so it waits for the next batch` }
    : { key: 'full', text: `it is ready, but the batch is full (${TRAIN_MAX_BATCH} pull requests), so it waits for the next batch` }
}

/**
 * Tells the Engineer of a done task why its pull request was passed over (task #3902): once the same reason held for
 * [SKIPS_BEFORE_TELLING] passes in a row, and again only when the reason changes. A pass that did not read a pull request, or
 * found it eligible and batched, ends its count. The line is written once per reason and head whatever the memory (trainTell).
 */
async function tellSkips(swarm: TrainSwarm, memory: TrainMemory, skipped: ReadonlyArray<{ member: Member; skip: Reason }>, taskOf: ReadonlyMap<string, TrainTaskPull>) {
  const next = new Map<string, Skip>()
  for (const { member, skip } of skipped) {
    if (!taskOf.get(member.url)?.task.done) continue
    const before = memory.skips.get(member.url), same = before?.key === skip.key
    const entry: Skip = { key: skip.key, passes: same ? before.passes + 1 : 1, told: same && before.told }
    next.set(member.url, entry)
    if (entry.passes < SKIPS_BEFORE_TELLING || entry.told) continue
    await swarm.tell(member.taskId, member.url, `train-skip:${skip.key}:${member.head}`,
      `The merge train has passed over your pull request #${member.number} for ${entry.passes} passes in a row: ${skip.text}. ${member.url}`)
    entry.told = true
  }
  memory.skips = next
}

/** Tells each member of a batch closed because main moved (task #4379) that the train read again and that went into no new
 *  batch why it waits and when the next batch starts: once per closed batch and head. One merged by hand meanwhile, or one
 *  told by its own line this pass, hears nothing more. */
async function tellMoved(swarm: TrainSwarm, moved: readonly Batch[], waits: ReadonlyMap<string, string | null>, everyMinutes?: number) {
  const when = everyMinutes ? `, in about ${everyMinutes} minutes` : ''
  for (const batch of moved) for (const member of batch.members) {
    const why = waits.get(member.url)
    if (!why) continue
    await swarm.tell(member.taskId, member.url, `train-moved:${batch.number}:${member.head}`,
      `Main moved under the merge train's batch #${batch.number}, so the train closed it to build again from the new main. Your pull request #${member.number} waits: ${why}. The train builds its next batch at its next pass${when}. ${member.url}`)
  }
}

/** The first members of [group], up to [TRAIN_MAX_BATCH], that share no file with an earlier one: two pull requests changing
 *  one file would need a read of their combination, so the later one waits for the next batch and is tested on top of the
 *  first once it merged (task #3401: a combination read only where files are shared). */
function disjoint(group: Member[]): Member[] {
  const taken = new Set<string>(), kept: Member[] = []
  for (const member of group) {
    if (kept.length === TRAIN_MAX_BATCH) break
    if (member.files.some(file => taken.has(file))) continue
    for (const file of member.files) taken.add(file)
    kept.push(member)
  }
  return kept
}

const tellConflict = (swarm: TrainSwarm, member: Member) => swarm.tell(member.taskId, member.url, `train-conflict:${member.head}`,
  `Your pull request #${member.number} conflicts with main or with another pull request in the merge train (head ${member.head.slice(0, 7)}): merge main into its branch once and push. The train takes it again at its new head. ${member.url}`)
