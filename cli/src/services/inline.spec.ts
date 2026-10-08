import { questionControlFor } from '../engines/questionControls.js'
import { modelControlFor } from '../engines/modelControls.js'
import { screenFor } from '../engines/screens.js'
import { describe, expect, it } from 'vitest'
import { engineTranscriptFor } from '../engines/transcripts.js'
import { liveFor } from '../engines/live.js'
import { runtimeFor } from '../engines/runtime.js'
import { startGateway } from '../gateway/start.js'
import { startCommandBar } from './commandBar.js'
import { startDevices } from './devices.js'
import { startHandoff } from './handoff.js'
import * as inline from './inline.js'
import { startModels } from './models.js'
import { startTeamsInCore } from './collaboration.js'
import { startMonitor } from './monitor.js'
import { startOrchestrator } from './orchestrator.js'
import { startProjects } from './projects.js'
import { startRecaps } from './recaps.js'
import { startSearch } from './search.js'
import { startShell } from './shell.js'
import { startSharing } from './sharing.js'
import { startStore } from './store.js'
import { startUsage } from './usage.js'
import { startViewers } from './viewers.js'
import { startWifi } from './wifi.js'
import { startWindowNames } from './windowNames.js'
import { startWorkspaces } from './workspaces.js'

describe('the services the core runs in its own process only when they do not run in theirs', () => {
  it('are their own starts, unchanged: the same services either way', () => {
    expect({ ...inline }).toEqual({ engineTranscriptFor, liveFor, runtimeFor, screenFor, modelControlFor, questionControlFor, startCommandBar, startDevices, startHandoff, startGateway, startModels, startMonitor, startOrchestrator, startProjects, startRecaps, startSearch, startSharing, startShell, startStore, startTeamsInCore, startUsage, startViewers, startWifi, startWindowNames, startWorkspaces })
  })
})
