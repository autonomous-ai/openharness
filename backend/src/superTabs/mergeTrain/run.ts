/**
 * Runs the merge train (train.ts) in the singleton worker: every minute it looks at the projects with tasks that link pull
 * requests, and runs a pass for each whose train is switched on and whose interval has passed. The switch and the interval
 * are the project's rules (task #3393); until that record lands they are [TRAIN_DEFAULTS], off.
 *
 * A project runs only where its repository may get the app's tokens at all: the app installed there, and approved for the
 * project wherever approval is asked (github/approvals.ts), as an agent's token would be.
 */
import type { GitHubApp } from '../../github/app.js'
import { githubRepository } from '../../github/repository.js'
import { repositoryTrain } from '../../github/train.js'
import { logger } from '../../utils/logger.js'
import type { SuperTabStore, TrainProject } from '../store.js'
import { TRAIN_DEFAULTS } from './config.js'
import type { ReviewTable } from './plan.js'
import { newTrainMemory, trainPass, type TrainMemory } from './train.js'

export interface ProjectTrainRules { enabled: boolean; everyMinutes: number; reviews?: ReviewTable }
export type TrainRulesReader = (tabId: string, projectId: string) => Promise<ProjectTrainRules>
/** Until the project rules record lands (task #3393): the defaults, off for every project. */
export const defaultTrainRules: TrainRulesReader = async () => ({ ...TRAIN_DEFAULTS })

export interface MergeTrainDeps {
  store: Pick<SuperTabStore, 'trainProjects' | 'trainMerged' | 'trainTell'>
  app: Pick<GitHubApp, 'installation' | 'createToken' | 'installationCall' | 'revoke'>
  /** Whether [repository] may get the app's tokens for this project. */
  approved: (project: TrainProject, repository: string) => Promise<boolean>
  rules?: TrainRulesReader
}

/** What a worker keeps per project between runs: its train's memory and when it last ran. */
export type TrainMemories = Map<string, { memory: TrainMemory; ranAt: number }>

/** One run over every project. The passes that ran. */
export async function runMergeTrain(deps: MergeTrainDeps, memories: TrainMemories, now: number): Promise<number> {
  const rules = deps.rules ?? defaultTrainRules
  let ran = 0
  for (const project of await deps.store.trainProjects(now)) {
    const key = `${project.tabId}:${project.projectId}`
    try {
      const set = await rules(project.tabId, project.projectId)
      // The kill switch: off reads nothing from GitHub and writes nothing.
      if (!set.enabled) continue
      const kept = memories.get(key) ?? { memory: newTrainMemory(), ranAt: 0 }
      memories.set(key, kept)
      if (now - kept.ranAt < set.everyMinutes * 60_000) continue
      const repository = githubRepository(project.repositoryUrl)
      if (!repository || !await deps.approved(project, repository.fullName.toLowerCase())) continue
      const github = await repositoryTrain(deps.app, repository)
      if (!github) continue
      kept.ranAt = now
      try {
        const line = await trainPass({ projectId: project.projectId, github, memory: kept.memory, now, rules: set, swarm: {
          pulls: async () => project.pulls,
          merged: (taskId, url, mergedAt) => deps.store.trainMerged(project, taskId, url, mergedAt),
          tell: async (taskId, _url, tellKey, text) => { await deps.store.trainTell(project.tabId, taskId, tellKey, text) },
        } })
        ran++
        // One line a pass that did something or could not read (ENGINEERING.md 6): counts only, never a link or a title.
        if ('off' in line) continue
        if (line.unreadable) logger.warn('[merge-train] pass', { tabId: project.tabId, projectId: project.projectId, ...line })
        else if (line.built || line.merged || line.closed) logger.info('[merge-train] pass', { tabId: project.tabId, projectId: project.projectId, ...line })
      } finally { await github.done() }
    } catch (error) {
      logger.warn('[merge-train] project skipped', { tabId: project.tabId, projectId: project.projectId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return ran
}

/** Runs [runMergeTrain] every minute in the singleton worker, one run at a time. */
export function startMergeTrain(deps: MergeTrainDeps, everyMs = 60_000): () => void {
  const memories: TrainMemories = new Map()
  let running = false
  const run = () => {
    if (running) return
    running = true
    void runMergeTrain(deps, memories, Date.now())
      .catch(error => logger.warn('[merge-train] failed', { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { running = false })
  }
  const timer = setInterval(run, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
