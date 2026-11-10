import type { SwarmProject } from './projects.js'

export type ProjectProcess = 'simple' | 'full'
export interface BoardColumn { id: string; title: string }

/** One column vocabulary, the Board's (Desktop task_groups.dart SuperTabTaskColumn, #3381); Simple shows three of its columns
 *  under its own titles. To do also holds what Full shows in Proposal, Done what Full shows in Merged and Shipped. No status
 *  is added: personal Tasks' proposal and rejected (Swarm v3) are approval states on the card, not columns. */
const COLUMNS: Record<ProjectProcess, readonly BoardColumn[]> = {
  simple: [{ id: 'nextUp', title: 'To do' }, { id: 'working', title: 'Doing' }, { id: 'done', title: 'Done' }],
  full: [{ id: 'proposals', title: 'Proposal' }, { id: 'nextUp', title: 'Next up' }, { id: 'working', title: 'Working' },
    { id: 'done', title: 'Done' }, { id: 'merged', title: 'Merged' }, { id: 'shipped', title: 'Shipped' }],
}

/** Projects from before presets keep the Full process until their owner chooses. */
export const processOf = (project: SwarmProject): ProjectProcess => project.process ?? 'full'
export const projectColumns = (project: SwarmProject): readonly BoardColumn[] => COLUMNS[processOf(project)]

