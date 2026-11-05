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
import { TRAIN_BRANCH_PREFIX, TRAIN_CI_TIMEOUT_MS, TRAIN_MAX_BATCH } from './config.js'
import { eligible, headReads, laneOf, requiredReads, splitRed, type Ineligible, type ReviewTable, type TrainTask } from './plan.js'

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

/** What a worker remembers between passes, per project: its open batches, the heads that failed alone, and the parts of red
 *  batches still to run. Lost on a restart, which only closes and rebuilds what was open. */
export interface TrainMemory { batches: Map<number, Batch>; failed: Set<string>; splits: string[][] }
export const newTrainMemory = (): TrainMemory => ({ batches: new Map(), failed: new Set(), splits: [] })

export interface TrainRules { enabled: boolean; reviews?: ReviewTable }
export type TrainPassLine = { off: true } | { candidates: number; unreadable: number; built: number; merged: number; split: number; closed: number }

const short = (sha: string) => sha.slice(0, 12)
/** A batch's label: the day and time it was built, in UTC ("11-05 train-1510"). */
const batchLabel = (at: number) => { const d = new Date(at), two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} train-${two(d.getUTCHours())}${two(d.getUTCMinutes())}` }
const PULL = /\/pull\/([1-9][0-9]*)$/

interface Read { member: Member; verdict: { ok: true } | { ok: false; why: Ineligible }; reads: number | null; required: number; lane: 'fast' | 'code' }

export async function trainPass(input: { projectId: string; github: TrainGitHub; swarm: TrainSwarm; memory: TrainMemory; now: number; rules: TrainRules }): Promise<TrainPassLine> {
  const { projectId, github, swarm, memory, now, rules } = input
  if (!rules.enabled) return { off: true }
  const line = { candidates: 0, unreadable: 0, built: 0, merged: 0, split: 0, closed: 0 }
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

  /** [url] as it is now: GitHub's answer and the Swarm's verdicts. Null when it is not an open pull request of this repository. */
  const read = async (linked: TrainTaskPull): Promise<Read | null> => {
    const number = Number(PULL.exec(linked.url)?.[1])
    if (!number) return null
    const pull = await github.pull(number)
    if (pull.state !== 'open' || pull.url.toLowerCase() !== linked.url.toLowerCase() || pull.headRef.startsWith(TRAIN_BRANCH_PREFIX)) return null
    const files = await github.files(number), ciRequired = await github.ciRequired(pull.head)
    const reads = headReads(linked.task, linked.url, pull.head), required = requiredReads(files, rules.reviews)
    const verdict = eligible({ url: linked.url, number, head: pull.head, state: pull.state, draft: pull.draft, base: pull.base, mergeable: pull.mergeable,
      labels: pull.labels, files, ciRequired }, reads, required)
    return { member: { number, url: linked.url, head: pull.head, title: pull.title, files, taskId: linked.taskId }, verdict, reads, required, lane: laneOf(files) }
  }

  const closeBatch = async (number: number, branch: string, why: string) => {
    memory.batches.delete(number)
    await github.comment(number, `The merge train closed this batch: ${why}. Its pull requests go into the next batch.`)
    await github.close(number)
    await github.deleteBranch(branch)
    line.closed++
  }
  const tellRed = (member: Member) => swarm.tell(member.taskId, member.url, `train-red:${member.head}`,
    `CI failed for your pull request #${member.number} in the merge train, on its own with main (head ${member.head.slice(0, 7)}): fix it and push. The train takes it again at its new head. ${member.url}`)

  // Finish the open batches.
  for (const pull of open.filter(p => p.headRef.startsWith(prefix))) {
    const batch = memory.batches.get(pull.number)
    try {
      if (!batch || batch.tip !== pull.head) {
        await closeBatch(pull.number, pull.headRef, batch ? 'its branch changed after the train built it' : 'the train did not build it on this server')
        continue
      }
      if (batch.base !== main) { await closeBatch(batch.number, batch.branch, 'main moved'); continue }
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
      if (await github.mainHead() !== batch.base) { await closeBatch(batch.number, batch.branch, 'main moved'); continue }
      let still = true
      for (const member of batch.members) {
        const linked = taskOf.get(member.url), current = linked ? await read(linked) : null
        if (!current || !current.verdict.ok || current.member.head !== member.head) { still = false; break }
      }
      if (!still) { await closeBatch(batch.number, batch.branch, 'a pull request in it changed or is no longer approved at its head'); continue }
      // The form main's batches use, which the release watch reads (task #3405): the originals before the batch's own number.
      const title = `Merge batch ${batchLabel(batch.startedAt)}: ${batch.members.map(m => `#${m.number}`).join(' ')} (#${batch.number})`
      const { sha } = await github.squash(batch.number, batch.tip, title, batch.members.map(m => `* ${m.title} (#${m.number})`).join('\n'))
      memory.batches.delete(batch.number)
      main = sha
      // Merged now, whatever GitHub answers next: every member's merge is recorded first, then each original is closed.
      for (const member of batch.members) {
        await swarm.merged(member.taskId, member.url, now)
        line.merged++
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
  const reads: Read[] = []
  for (const linked of taskOf.values()) {
    try {
      const found = await read(linked)
      if (!found || memory.failed.has(`${found.member.url}@${found.member.head}`)) continue
      line.candidates++
      const { member, verdict } = found
      if (!verdict.ok && verdict.why === 'conflict') await tellConflict(swarm, member)
      else if (!verdict.ok && verdict.why === 'reads') {
        await swarm.tell(member.taskId, member.url, `train-reads:${member.head}`,
          `Your pull request #${member.number} needs ${found.required} passed reviews at its head (${member.head.slice(0, 7)}) before the merge train takes it; it has ${found.reads}. ${member.url}`)
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
      line.merged++
    }
    if (reads.some(r => r.lane === 'fast')) main = await github.mainHead()
  } catch (error) {
    if (!(error instanceof TrainReadError)) throw error
    line.unreadable++
    return line
  }
  const code = reads.filter(r => r.lane === 'code').map(r => r.member)
  const groups = (memory.splits.length ? memory.splits.map(urls => code.filter(m => urls.includes(m.url))) : [code])
    .map(disjoint).filter(group => group.length)
  memory.splits = []
  for (const [index, group] of groups.entries()) {
    const branch = `${prefix}${now}-${index}`
    try {
      await github.createBranch(branch, main)
      let tip = main
      const members: Member[] = []
      for (const member of group) {
        const merged = await github.mergeInto(branch, member.head, `Merge #${member.number} into the merge train's batch`)
        if (merged === 'conflict') { await tellConflict(swarm, member); continue }
        tip = merged.sha
        members.push(member)
      }
      if (!members.length) { await github.deleteBranch(branch); continue }
      const body = [`The merge train's batch of ${members.length} pull request${members.length === 1 ? '' : 's'}, built from main at ${short(main)}.`, '',
        ...members.map(m => `- #${m.number} at ${short(m.head)}: ${m.title}`), '',
        'It merges when ci/required is green here and every pull request is still at the head listed. Do not push to this branch.'].join('\n')
      const opened = await github.openPull(branch, `Merge train: ${members.map(m => `#${m.number}`).join(' ')}`, body)
      memory.batches.set(opened.number, { number: opened.number, url: opened.url, branch, tip, base: main, startedAt: now, members })
      line.built++
    } catch (error) {
      if (!(error instanceof TrainReadError)) throw error
      line.unreadable++
    }
  }
  return line
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
