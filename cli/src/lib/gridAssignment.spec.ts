import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyGridAssignment, gridAssignments, readPiGridAssignment } from './gridAssignment.js'
import { gridAssignmentEvidence, gridAssignmentProcess } from './gridAssignmentWire.js'
import { buildGridEngineLaunch, gridCapableEngines, gridConfigHandOff, type GridLaunchOverride } from './gridLaunch.js'
import type { AgentEngine } from '../engines/types.js'

const NETWORK_ID = 'grid-3378218621364f16'
const RELAY = `https://grid.autonomous.ai/${NETWORK_ID}/relay`
const RELAY_V1 = `${RELAY}/v1`

const OVERRIDE: GridLaunchOverride = {
  networkId: NETWORK_ID,
  networkName: 'autonomous.ai',
  baseUrl: RELAY_V1,
  apiKey: 'gridkey-secret',
  model: 'GLM-4.7-Flash',
}

/** The same launch with the grid's web tools wired in — see `gridLaunch`'s MCP section. */
const WITH_MCP: GridLaunchOverride = {
  ...OVERRIDE,
  mcpUrl: 'https://api-grid.autonomous.ai/v1/grid/web-mcp/',
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The command line a launch on [override] hands [engine], with the files it names written where it names them. */
function launched(engine: AgentEngine, override: GridLaunchOverride): { dir: string | null; args: string } {
  const built = buildGridEngineLaunch(engine, override, { hermesSystemManaged: false })
  if (!built.ok) throw new Error(`${engine}: ${built.detail}`)
  const args = [...built.launch.args]
  let dir: string | null = null
  if (built.launch.configDir) {
    dir = mkdtempSync(join(tmpdir(), `${engine}-grid-`))
    dirs.push(dir)
    for (const file of built.launch.configDir.files) writeFileSync(join(dir, file.name), file.content)
    args.push(...gridConfigHandOff(built.launch.configDir, dir).args)
  }
  return { dir, args: `${engine} ${args.join(' ')}` }
}

describe('classifyGridAssignment', () => {
  it('reads back what Codex and Pi were launched with, and no other engine, whose grid is the launch record', async () => {
    // The point of the round trip: the read and the launcher must use the SAME knob, or an agent that IS on a grid
    // reports as being on none and gets pointlessly restarted.
    for (const engine of gridCapableEngines()) {
      const { args } = launched(engine, OVERRIDE)
      const process = gridAssignmentProcess('k', engine, args)
      if (engine !== 'codex' && engine !== 'pi') {
        expect(process, engine).toBeNull()
        // No finding, so the row keeps the grid its launch recorded: every other engine a grid can launch is one
        // whose grid is in no command line.
        expect(gridAssignmentEvidence('k', engine, args), engine).toBeUndefined()
        continue
      }
      const [answer] = await gridAssignments([process!])
      expect(answer.assignment, engine).toEqual({ baseUrl: RELAY_V1, model: 'GLM-4.7-Flash' })
      expect(JSON.stringify(process), engine).not.toContain('gridkey-secret')
    }
  })

  it('reads no grid from an engine whose grid is in no command line, nor from a Pi given no extension', async () => {
    expect(classifyGridAssignment('claude', '')).toBeNull()
    await expect(gridAssignments([{ key: 'k', engine: 'pi', args: '--model grid/GLM-4.7-Flash' }]))
      .resolves.toEqual([{ key: 'k', assignment: null }])
  })

  it('leaves an agent the user pointed somewhere else alone', () => {
    // Offering to "move" these away from where they were deliberately sent would be the app
    // overruling a choice it did not make.
    const pointed = (url: string) => classifyGridAssignment('codex', `codex -c model_providers.x.base_url="${url}" -m m`)
    expect(pointed('https://openrouter.ai/api/v1')).toBeNull()
    expect(pointed('http://localhost:8080/v1')).toBeNull()
    expect(pointed('   ')).toBeNull()
    expect(pointed('not a url')).toBeNull()
  })

  it('reads Codex off its argv, where its endpoint actually lives', () => {
    const args = `codex -c model_provider="grid" -c model_providers.grid.base_url="${RELAY_V1}" -m GLM-4.7-Flash`
    expect(classifyGridAssignment('codex', args)).toEqual({ baseUrl: RELAY_V1, model: 'GLM-4.7-Flash' })
    expect(classifyGridAssignment('codex', 'codex -m GLM-4.7-Flash')).toBeNull()
  })
})

describe('Pi, whose endpoint lives in a file', () => {
  /** Writes the launch's own files where Pi's argv points, and the argv the pane runs. */
  function materialize(): { dir: string; args: string } {
    const { dir, args } = launched('pi', OVERRIDE)
    return { dir: dir!, args: args.replace(/^pi /, 'pi --session 01a1387c-b029-75b7-b0f0-925d65eb8121 ') }
  }

  it('round-trips: what the launcher wrote is what is read back', async () => {
    const { args } = materialize()
    await expect(readPiGridAssignment(args)).resolves.toEqual({
      baseUrl: RELAY_V1,
      model: 'GLM-4.7-Flash',
    })
    // And the process the core hands the models service carries the extension and model, nothing else of argv.
    expect(gridAssignmentProcess('k', 'pi', args)?.args).toBe(`-e ${args.split(' -e ')[1]} --model grid/GLM-4.7-Flash`)
  })

  it('an extension that is gone reads as unknown, not as fine', async () => {
    const { dir, args } = materialize()
    rmSync(dir, { recursive: true, force: true })
    // Nothing to read → null → the app offers a move rather than claiming the agent is in place.
    await expect(readPiGridAssignment(args)).resolves.toBeNull()
  })

  it('reads nothing when the pane was never given the extension', async () => {
    expect(gridAssignmentProcess('k', 'pi', 'pi --model grid/GLM-4.7-Flash')).toBeNull()
    await expect(readPiGridAssignment('pi --model grid/GLM-4.7-Flash')).resolves.toBeNull()
  })

  it('will not call a provider pointed somewhere else a grid', async () => {
    const { dir, args } = materialize()
    const file = join(dir, 'grid-provider.ts')
    writeFileSync(file, readFileSync(file, 'utf8').replace(RELAY_V1, 'https://api.openai.com/v1'))
    await expect(readPiGridAssignment(args)).resolves.toBeNull()
  })
})

describe('web tools do not disturb what argv says', () => {
  // Wiring MCP adds argv to Codex, which is what is parsed. An agent that IS on a grid reporting as being on none
  // gets pointlessly restarted, so the round trip above is repeated against the shape a launch with web tools produces.
  const classify = (override: GridLaunchOverride) => classifyGridAssignment('codex', launched('codex', override).args)

  it('reads a process back identically with the MCP argv in the way', () => {
    // Compared against the same launch WITHOUT web tools rather than a literal, so this states the invariant —
    // wiring MCP changes nothing that is read — in a form that survives Codex changing which URL shape it wants.
    expect(classify(WITH_MCP)).toEqual(classify(OVERRIDE))
    expect(classify(WITH_MCP)?.model).toBe('GLM-4.7-Flash')
  })

  it('never reads the control plane as the place an agent is running', () => {
    // Codex's argv now also carries `mcp_servers.harness.url=…`. Reading that as the endpoint would report an agent
    // as running on the control plane, and the app would offer to move it off a grid it is already on.
    expect(classify(WITH_MCP)?.baseUrl).toBe(RELAY_V1)
  })
})
