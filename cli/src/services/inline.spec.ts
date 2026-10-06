import { describe, expect, it } from 'vitest'
import { startGateway } from '../gateway/start.js'
import { startDevices } from './devices.js'
import * as inline from './inline.js'
import { startModels } from './models.js'
import { startTeamsInCore } from './collaboration.js'
import { startMonitor } from './monitor.js'
import { startOrchestrator } from './orchestrator.js'
import { startProjects } from './projects.js'
import { startSearch } from './search.js'
import { startSharing } from './sharing.js'
import { startStore } from './store.js'
import { startUsage } from './usage.js'
import { startViewers } from './viewers.js'
import { startWifi } from './wifi.js'
import { startWorkspaces } from './workspaces.js'

describe('the services the core runs in its own process only when they do not run in theirs', () => {
  it('are their own starts, unchanged: the same services either way', () => {
    expect({ ...inline }).toEqual({ startDevices, startGateway, startModels, startMonitor, startOrchestrator, startProjects, startSearch, startSharing, startStore, startTeamsInCore, startUsage, startViewers, startWifi, startWorkspaces })
  })
})
