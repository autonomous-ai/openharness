import { inspectRuntimePane } from '../engines/codex/screen.js'
import { stoppedGoal } from '../engines/codex/stoppedGoal.js'
export function codexStoppedGoal(screen: string | null): boolean { return !!screen && stoppedGoal(screen, inspectRuntimePane(screen)) }
