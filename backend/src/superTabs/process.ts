import type { SwarmProject } from './projects.js'

export type ProjectProcess = 'simple' | 'full'
export interface BoardColumn { id: string; title: string }

const COLUMNS: Record<ProjectProcess, readonly BoardColumn[]> = {
  simple: [{ id: 'todo', title: 'To do' }, { id: 'doing', title: 'Doing' }, { id: 'done', title: 'Done' }],
  full: [{ id: 'proposals', title: 'Proposal' }, { id: 'nextUp', title: 'Next up' }, { id: 'working', title: 'Working' },
    { id: 'done', title: 'Done' }, { id: 'merged', title: 'Merged' }, { id: 'shipped', title: 'Shipped' }],
}

/** Projects from before presets keep the Full process until their owner chooses. */
export const processOf = (project: SwarmProject): ProjectProcess => project.process ?? 'full'
export const projectColumns = (project: SwarmProject): readonly BoardColumn[] => COLUMNS[processOf(project)]
