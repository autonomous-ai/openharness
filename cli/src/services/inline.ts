/**
 * The services that run in a process of their own by default (harnessd/services.ts `SERVICE_HOSTS`), for
 * when they run in the core's instead: with `HARNESSD_SERVICES=none` (debugging, or a quick way back), a
 * subset named, a master too old to run them, or no master at all (`harness start -f`).
 *
 * The gateway (gateway/start.ts) is here too: the relay and its keys, run in the core's process the same way.
 *
 * The core imports this module only then, and only dynamically (core/main.ts): what it reaches is the
 * services' own code, which the core's process then never loads by default. That is how a service in its
 * own process leaves the core's import closure, which src/architecture.spec.ts checks for forbidden
 * dependencies without following this one import (docs/design/2026-10-06-core-boundary-next.md, "The
 * target, and its test"). The core still routes these services' requests and holds their fallbacks: both are
 * declared in core/api.ts, which it loads either way.
 */
export { engineTranscriptFor } from '../engines/transcripts.js'
export { liveFor } from '../engines/live.js'
export { screenFor } from '../engines/screens.js'
export { modelControlFor } from '../engines/modelControls.js'
export { runtimeFor } from '../engines/runtime.js'
export { startGateway } from '../gateway/start.js'
export { startCommandBar } from './commandBar.js'
export { startDevices } from './devices.js'
export { startHandoff } from './handoff.js'
export { startModels } from './models.js'
export { startTeamsInCore } from './collaboration.js'
export { startMonitor } from './monitor.js'
export { startOrchestrator } from './orchestrator.js'
export { startProjects } from './projects.js'
export { startRecaps } from './recaps.js'
export { startSearch } from './search.js'
export { startShell } from './shell.js'
export { startSharing } from './sharing.js'
export { startStore } from './store.js'
export { startUsage } from './usage.js'
export { startViewers } from './viewers.js'
export { startWifi } from './wifi.js'
export { startWindowNames } from './windowNames.js'
export { startWorkspaces } from './workspaces.js'
