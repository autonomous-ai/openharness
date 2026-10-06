import { describe, expect, it } from 'vitest'
import { startGateway } from '../gateway/start.js'
import * as inline from './inline.js'
import { startModels } from './models.js'
import { startMonitor } from './monitor.js'
import { startOrchestrator } from './orchestrator.js'
import { startProjects } from './projects.js'
import { startSearch } from './search.js'
import { startStore } from './store.js'
import { startUsage } from './usage.js'
import { startViewers } from './viewers.js'
import { startWorkspaces } from './workspaces.js'

describe('the services the core runs in its own process only when they do not run in theirs', () => {
  it('are their own starts, unchanged: the same services either way', () => {
    expect({ ...inline }).toEqual({ startGateway, startModels, startMonitor, startOrchestrator, startProjects, startSearch, startStore, startUsage, startViewers, startWorkspaces })
  })
})
