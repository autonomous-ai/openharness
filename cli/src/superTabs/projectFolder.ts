import { join, resolve } from 'node:path'
import type { CoreApi } from '../core/api.js'
import { parseProjectFolder, prepareProjectFolder } from '../lib/projectFolder.js'
import { identifier, object } from './wire.js'

type Json = Record<string, unknown>

/** The owner granted a swarm workspace, not caller-selected filesystem paths.
 * Prepare the queued project's repository there before reserving or launching. */
export async function prepareSwarmProject(core: CoreApi, row: Json, start: Json, prepare = prepareProjectFolder): Promise<void> {
  const pool = object(row.machine)
  if (pool.scope !== 'swarm' || start.dispatched) return
  const request = object(start.request)
  const project = (Array.isArray(row.projects) ? row.projects.map(object) : [])
    .find(p => Array.isArray(p.conversationIds) && p.conversationIds.includes(request.conversationId))
  if (!project || !identifier(project.id) || !identifier(row.tabId)) throw new Error('This start has no authorized project.')
  const repository = object(project.repository)
  const expectedRoot = join(core.dataDir, 'swarm-projects', row.tabId)
  if (typeof pool.cwd !== 'string' || resolve(pool.cwd) !== resolve(expectedRoot)) throw new Error('Add this machine again to authorize its swarm workspace.')
  if (repository.machineId === core.daemon.machineId() && typeof repository.cwd === 'string' && request.cwd === repository.cwd) return
  const expected = join(expectedRoot, project.id)
  if (request.cwd !== expected) throw new Error('The requested folder is outside this project.')
  if (typeof repository.repositoryUrl !== 'string') throw new Error('Share a GitHub repository for this project before starting agents on another machine.')
  const source = parseProjectFolder({ projectSource: 'remote', repositoryUrl: repository.repositoryUrl })
  if (source?.source !== 'remote') throw new Error('This project repository is unavailable.')
  const cwd = await prepare({ ...source, name: project.id }, { root: expectedRoot })
  if (cwd !== expected) throw new Error('The prepared checkout does not match the authorized project.')
}
