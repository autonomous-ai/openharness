import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from './config.js'
import { createAgent, deleteAgent, readAgentsFile, renameAgent } from './workspace.js'

let root: string
let config: Config
let originalId: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'provider-workspace-'))
  config = {
    agents: [], workspaceRoot: root, agentsFile: join(root, 'agents.json'),
    claudeBin: 'unused-test-binary', model: 'test', port: 0,
    stateFile: join(root, 'sessions.json'), claudeProjectsDir: join(root, 'projects'),
    recapModel: 'test', recapDisabled: true,
  }
  originalId = createAgent(config, 'Original').id
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const mutations: Array<[string, (config: Config, id: string) => unknown]> = [
  ['create', (config) => createAgent(config, 'Second')],
  ['rename', (config, id) => renameAgent(config, id, 'Changed')],
  ['delete', (config, id) => deleteAgent(config, id)],
]

describe.each(['write', 'rename'])('when the agents-file %s fails', (stage) => {
  it.each(mutations)('keeps %s unpublished until it can be saved', (_name, mutate) => {
    const before = config.agents.map((agent) => ({ ...agent }))
    const backup = join(root, 'saved-agents.json')
    const obstruction = stage === 'write' ? `${config.agentsFile}.tmp` : config.agentsFile
    if (stage === 'rename') renameSync(config.agentsFile, backup)
    mkdirSync(obstruction)

    expect(() => mutate(config, originalId)).toThrow()
    expect(config.agents).toEqual(before)
    const saved = stage === 'rename' ? backup : config.agentsFile
    expect(JSON.parse(readFileSync(saved, 'utf8'))).toEqual(before)

    // Once persistence works again, the same request must be retryable.
    rmSync(obstruction, { recursive: true })
    if (stage === 'rename') renameSync(backup, config.agentsFile)
    mutate(config, originalId)
    expect(readAgentsFile(config)).toEqual(config.agents)
  })
})
