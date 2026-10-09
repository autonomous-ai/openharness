/** Endpoint vocabulary is models' state; each process/config classification is always fresh. */
import type { ApiConnections } from '../lib/apiConnections.js'
import { gridAssignments, rememberApiBase } from '../lib/gridAssignment.js'
import type { ModelsPort } from '../core/api.js'

export function modelsAssignments(store: Pick<ApiConnections, 'recognizedBases'>): ModelsPort['gridAssignments'] {
  let vocabularyLoaded = false
  return async processes => {
    try {
      for (const base of store.recognizedBases()) rememberApiBase(base)
      vocabularyLoaded = true
    } catch (error) {
      // A restarted service with no validated vocabulary cannot claim a known API agent left it.
      // Once read, retain that vocabulary through a transient file error, just as the former core did.
      if (!vocabularyLoaded) throw error
    }
    return gridAssignments(processes)
  }
}
