/** Composition kept at the boundary while assignment classification moves to models. */
import type { AgentEngine } from '../engines/types.js'
import { ApiConnectionMetadata } from '../lib/apiConnectionMetadata.js'
import { gridAssignmentEvidence, gridAssignmentProcessesIn } from '../lib/gridAssignmentWire.js'
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
    /** Models' answer for a command line's markers, null for one that names none, and 'no evidence' where that is no
     *  finding: the row keeps the grid its launch recorded (`gridAssignmentEvidence`). */
    assignment: async (engine: AgentEngine, args = '') => {
      const process = gridAssignmentEvidence('golden', engine, args)
      if (process === undefined) return 'no evidence'
      return process ? (await port.gridAssignments([process]))[0].assignment : null
    },
    list: () => store.list(),
    // The spec's workspaces are made in its data folder, which stands for where Harness makes them.
    instructions: (workspace: string, engine: string) => prepareApiInstructions(store, workspace, engine, dataDir),
  }
}
