/**
 * Tests only: one repository in memory, as the merge train's calls see it (github/train.ts TrainGitHub). Nothing here reaches
 * github.com. Commits are made-up SHAs; a squash moves main.
 */
import { createHash } from 'node:crypto'
import { TrainReadError, type TrainGitHub, type TrainPull } from '../../github/train.js'

export const sha = (seed: string): string => createHash('sha1').update(seed).digest('hex')

export interface FakePull extends TrainPull { files: string[] }

export function fakeTrainGitHub() {
  const state = {
    main: sha('main-0'),
    pulls: new Map<number, FakePull>(),
    /** ci/required by SHA; a SHA not listed reads as pending once it is a batch's tip, else null. */
    ci: new Map<string, 'success' | 'failure' | 'pending'>(),
    branches: new Map<string, string>(),
    /** Heads that conflict when merged into any batch. */
    conflicts: new Set<string>(),
    /** What each merge commit holds: the member heads merged into it. */
    contents: new Map<string, string[]>(),
    comments: [] as Array<{ number: number; text: string }>,
    squashes: [] as Array<{ number: number; sha: string; title: string; message: string }>,
    writes: [] as string[],
    reads: [] as string[],
    /** Calls (by name) that answer as GitHub failing. */
    failing: new Set<string>(),
    nextNumber: 900,
  }
  const read = (name: string) => {
    state.reads.push(name)
    if (state.failing.has(name)) throw new TrainReadError(name, 500)
  }
  const write = (name: string) => {
    state.writes.push(name)
    if (state.failing.has(name)) throw new TrainReadError(name, 500)
  }
  const copy = (pull: FakePull): TrainPull => {
    const { files: _files, ...rest } = pull
    return { ...rest, labels: [...pull.labels] }
  }
  const github: TrainGitHub = {
    async mainHead() { read('mainHead'); return state.main },
    async openPulls() { read('openPulls'); return [...state.pulls.values()].filter(p => p.state === 'open').map(copy) },
    async pull(number) {
      read('pull')
      const found = state.pulls.get(number)
      if (!found) throw new TrainReadError('pull', 404)
      return copy(found)
    },
    async files(number) { read('files'); return [...state.pulls.get(number)?.files ?? []] },
    async ciRequired(head) { read('ciRequired'); return state.ci.get(head) ?? (state.contents.has(head) ? 'pending' : null) },
    async createBranch(name, from) { write('createBranch'); state.branches.set(name, from); state.contents.set(from, state.contents.get(from) ?? []) },
    async mergeInto(branch, head, message) {
      write('mergeInto')
      if (state.conflicts.has(head)) return 'conflict'
      const tip = state.branches.get(branch)!
      const merged = sha(`${tip}+${head}+${message}`)
      state.contents.set(merged, [...state.contents.get(tip) ?? [], head])
      state.branches.set(branch, merged)
      return { sha: merged }
    },
    async openPull(branch, title, body) {
      write('openPull')
      const number = state.nextNumber++
      const pull: FakePull = { number, url: `https://github.com/acme/app/pull/${number}`, state: 'open', merged: false, draft: false, title, body,
        mergeable: true, head: state.branches.get(branch)!, headRef: branch, base: 'main', labels: [], files: [] }
      state.pulls.set(number, pull)
      return copy(pull)
    },
    async squash(number, head, title, message) {
      write('squash')
      const pull = state.pulls.get(number)!
      if (pull.head !== head || pull.state !== 'open') throw new TrainReadError('squash', 409)
      state.main = sha(`${state.main}#${number}`)
      Object.assign(pull, { state: 'closed', merged: true })
      state.squashes.push({ number, sha: state.main, title, message })
      return { sha: state.main }
    },
    async comment(number, text) { write('comment'); state.comments.push({ number, text }) },
    async close(number) { write('close'); state.pulls.get(number)!.state = 'closed' },
    async deleteBranch(name) { write('deleteBranch'); state.branches.delete(name) },
  }
  /** A pull request into main with [files], ready, mergeable and green at its head. */
  const addPull = (number: number, files: string[], over: Partial<FakePull> = {}): FakePull => {
    const pull: FakePull = { number, url: `https://github.com/acme/app/pull/${number}`, state: 'open', merged: false, draft: false, title: `Change ${number}`,
      body: '', mergeable: true, head: sha(`head-${number}`), headRef: `feature-${number}`, base: 'main', labels: [], files, ...over }
    state.pulls.set(number, pull)
    state.ci.set(pull.head, 'success')
    return pull
  }
  /** A new commit pushed to pull request [number]. */
  const push = (number: number) => {
    const pull = state.pulls.get(number)!
    pull.head = sha(`${pull.head}-pushed`)
    state.ci.set(pull.head, 'success')
    return pull.head
  }
  const batches = () => [...state.pulls.values()].filter(p => p.headRef.startsWith('harness-train/') && p.state === 'open')
  return { github, state, addPull, push, batches }
}
