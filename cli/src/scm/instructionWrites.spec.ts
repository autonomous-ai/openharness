import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROCESS_ENGINES } from '../engines/types.js'
import { PROJECT_INSTRUCTION_FILES } from '../dsh/adapters.js'
import type { InstalledDsh } from '../dsh/installed.js'
import { prepareHarnessLaunch } from '../dsh/runtime.js'
import type { ApiConnections } from '../lib/apiConnections.js'
import { prepareApiInstructions } from '../lib/apiInstructions.js'

// `prepareScmWrite` is handed PROJECT_INSTRUCTION_FILES before Harness writes into a project's
// instruction files (`prepareInstructionWrites`: create, fork, every relaunch in core/agents/). The
// list is only useful if it names every file those writers actually touch, so this runs the writers
// and compares.
describe('the files an SCM is asked to prepare before Harness writes instructions', () => {
  let root: string, ws: string, pkg: InstalledDsh
  const write = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  /** The workspace's top-level files and their contents, `.harness/` (Harness's own folder) aside. */
  const snapshot = () => new Map(readdirSync(ws).filter(name => name !== '.harness' && statSync(join(ws, name)).isFile())
    .map(name => [name, readFileSync(join(ws, name), 'utf8')]))
  const touched = (before: Map<string, string>) => [...snapshot()].filter(([name, text]) => before.get(name) !== text).map(([name]) => name)

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'scm-instruction-writes-')))
    ws = join(root, 'workspace')
    mkdirSync(ws)
    const dir = join(root, 'package')
    write(join(dir, 'AGENTS.md'), '# Make a drawing\n')
    write(join(dir, 'skills/draw/SKILL.md'), '# Draw\n')
    pkg = { id: 'acme/draw', dir, realDir: dir, source: dir, ref: null, commit: null, linked: true, installedAt: 1,
      manifest: { spec: 1, id: 'acme/draw', name: 'Drawing', engine: 'claude', agent: { instructions: 'AGENTS.md', skills: ['skills'] } } }
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  for (const engine of PROCESS_ENGINES) {
    it(`${engine}: names every file the session bootstrap writes, in a fresh workspace and one with instructions of its own`, () => {
      let before = snapshot()
      prepareHarnessLaunch(pkg, ws, engine, `${engine}-fresh`)
      const fresh = touched(before)
      expect(fresh.length).toBeGreaterThan(0)
      for (const name of fresh) expect(PROJECT_INSTRUCTION_FILES).toContain(name)

      rmSync(ws, { recursive: true, force: true })
      mkdirSync(ws)
      write(join(ws, 'AGENTS.md'), '# Project rules\n')
      write(join(ws, 'CLAUDE.md'), '# Project rules\n')
      before = snapshot()
      prepareHarnessLaunch(pkg, ws, engine, `${engine}-existing`)
      for (const name of touched(before)) expect(PROJECT_INSTRUCTION_FILES).toContain(name)
    })
  }

  it('names every file the saved-API notes go in', () => {
    const store = { list: () => [{ id: 'api' }] } as unknown as ApiConnections
    for (const engine of [...PROCESS_ENGINES, 'gemini']) {
      rmSync(ws, { recursive: true, force: true })
      mkdirSync(ws)
      const before = snapshot()
      prepareApiInstructions(store, ws, engine)
      const written = touched(before)
      expect(written).toHaveLength(1)
      expect(PROJECT_INSTRUCTION_FILES).toContain(written[0])
    }
  })
})
