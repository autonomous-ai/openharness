/** Composition kept at the boundary while assignment classification moves to models. */
import type { AgentEngine } from '../engines/types.js'
import { ApiConnections } from '../lib/apiConnections.js'
import { gridAssignmentFromEnv, rememberSavedApis } from '../lib/gridAssignment.js'
import { prepareApiInstructions } from '../lib/apiInstructions.js'

export function gridAssignmentShapes(dataDir: string) {
  const store = new ApiConnections(dataDir)
  return {
    remember: () => rememberSavedApis(store),
    assignment: (engine: AgentEngine, env: Record<string, string>, args = '') => gridAssignmentFromEnv(engine, env, args),
    list: () => store.list(),
    instructions: (workspace: string, engine: string) => prepareApiInstructions(store, workspace, engine),
  }
}
