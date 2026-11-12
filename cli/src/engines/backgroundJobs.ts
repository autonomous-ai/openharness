/** Explicit inline composition; supervised core does not import Claude Code's background-job stop. */
import type { StopBackgroundJob } from './facets/backgroundJob.js'
import { stopConflictingBackgroundJob } from './claude/backgroundJob.js'

const claude: StopBackgroundJob = request => stopConflictingBackgroundJob(request)
export const backgroundJobFor = (engine: string): StopBackgroundJob | undefined => engine === 'claude' ? claude : undefined
