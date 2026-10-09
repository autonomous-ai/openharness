/** Composition kept at the boundary while assignment classification moves to models. */
import type { AgentEngine } from '../engines/types.js'
import { ApiConnectionMetadata } from '../lib/apiConnectionMetadata.js'
import { gridAssignmentProcess, gridAssignmentProcessesIn } from '../lib/gridAssignmentWire.js'
import { createModelsLink } from '../core/modelsLink.js'
import { rememberSavedApis } from '../lib/gridAssignment.js'
import { ApiConnections } from '../lib/apiConnections.js'
import { modelsAssignments } from '../services/modelsAssignments.js'
import { prepareApiInstructions } from '../lib/apiInstructions.js'

export function gridAssignmentShapes(dataDir: string) {
  const store = new ApiConnectionMetadata(dataDir)
  const classify = modelsAssignments(new ApiConnections(dataDir))
  const port = createModelsLink({} as never, async (_type, payload) => {
    const processes = gridAssignmentProcessesIn(JSON.parse(JSON.stringify(payload.processes)))
    if (!processes) throw new Error('invalid assignment request')
    return JSON.parse(JSON.stringify({ assignments: await classify(processes) }))
  }, () => false).port
  return {
    remember: () => rememberSavedApis(store),
    assignment: async (engine: AgentEngine, env: Record<string, string>, args = '') => {
      const process = gridAssignmentProcess('golden', engine, env, args)
      return process ? (await port.gridAssignments([process]))[0].assignment : null
    },
    list: () => store.list(),
    instructions: (workspace: string, engine: string) => prepareApiInstructions(store, workspace, engine),
  }
}
