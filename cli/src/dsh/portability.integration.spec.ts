/** Real filesystem and subprocess lifecycle, without provider credentials or model calls. The
 * fixture engine reads the same bootstrap/context/env supplied to vendor engines, runs the package
 * tool, and produces a verdict. The manifest matrix uses every real store manifest; external
 * setup assets are represented by tiny skills so it is deterministic and offline.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROCESS_ENGINES } from '../engines/types.js'
import { buildLaunchOverrides } from '../lib/launchOverrides.js'
import { createAndRegisterPane } from '../lib/createAgentPane.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { InstalledDsh } from './installed.js'
import { readDshManifest, dshSupportedEngines } from './manifest.js'
import { materializeWorkspace, skillDirsIn } from './materialize.js'
import { prepareHarnessLaunch } from './runtime.js'
import { dshListRows } from './wire.js'

const store = fileURLToPath(new URL('../../../store/agents', import.meta.url))
let root: string
const write = (path: string, body: string, executable = false) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body, { mode: executable ? 0o755 : 0o644 })
}
const installed = (dir: string): InstalledDsh => {
  const parsed = readDshManifest(dir)
  if (!parsed.ok) throw new Error(parsed.error)
  return { id: parsed.manifest.id, dir, realDir: dir, manifest: parsed.manifest, source: dir,
    ref: null, commit: null, linked: true, installedAt: 1 }
}
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-portability-e2e-'))) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('the whole store × engine matrix', () => {
  for (const name of readdirSync(store).sort().filter(name => existsSync(join(store, name, 'harness.json')))) {
    it(`${name} exposes its content on every integrated engine without an opt-in`, () => {
      const original = installed(join(store, name))
      expect(original.manifest.agent?.args ?? []).toEqual([])
      const dir = join(root, name)
      write(join(dir, 'harness.json'), JSON.stringify(original.manifest))
      if (original.manifest.agent?.instructions) {
        const file = original.manifest.agent.instructions
        write(join(dir, file), existsSync(join(original.realDir, file)) ? readFileSync(join(original.realDir, file), 'utf8') : '# Upstream fixture instructions\n')
      }
      for (const [index, skillRoot] of (original.manifest.agent?.skills ?? []).entries()) {
        const source = join(original.realDir, skillRoot)
        const skills = skillDirsIn(source)
        if (skills.length) {
          for (const skill of skills) {
            const relative = skill.slice(original.realDir.length + 1)
            write(join(dir, relative, 'SKILL.md'), readFileSync(join(skill, 'SKILL.md'), 'utf8'))
          }
        } else write(join(dir, skillRoot, `fixture-${index}/SKILL.md`), `# External setup asset ${index}\n`)
      }
      const pkg = installed(dir)
      const row = dshListRows([pkg], [])[0]!
      expect(new Set(row.engines as string[])).toEqual(new Set(PROCESS_ENGINES))
      expect(new Set(dshSupportedEngines(pkg.manifest))).toEqual(new Set(PROCESS_ENGINES))
      const workspace = join(root, 'workspace')
      mkdirSync(workspace)
      const launches = new Map()
      for (const engine of PROCESS_ENGINES) {
        const launch = prepareHarnessLaunch(pkg, workspace, engine, engine)
        launches.set(engine, launch)
        expect(launch.env.HARNESS_DSH).toBe(pkg.id)
        const context = readFileSync(launch.env.HARNESS_CONTEXT_FILE!, 'utf8')
        expect(context).toContain(pkg.id)
        expect(context).toContain(`Engine: ${engine}.`)
        for (const skillRoot of pkg.manifest.agent?.skills ?? []) {
          for (const skill of skillDirsIn(join(dir, skillRoot))) {
            const skillName = skill.split('/').at(-1)!
            expect(context).toContain(`${skillName}/SKILL.md`)
            expect(readFileSync(join(launch.env.HARNESS_SKILLS_DIR!, skillName, 'SKILL.md'), 'utf8')).toBe(readFileSync(join(skill, 'SKILL.md'), 'utf8'))
          }
        }
      }
      // Every built-in package keeps the selected engine and content on restart and fork,
      // including after its default and instructions change. Another session cannot retarget it.
      if (pkg.manifest.agent?.instructions) write(join(dir, pkg.manifest.agent.instructions), '# Updated package instructions\n')
      pkg.manifest.engine = 'pi'
      for (const engine of PROCESS_ENGINES) {
        const originalLaunch = launches.get(engine)!
        const context = readFileSync(originalLaunch.env.HARNESS_CONTEXT_FILE, 'utf8')
        const restored = prepareHarnessLaunch(pkg, workspace, engine, engine)
        expect(restored).toEqual(originalLaunch)
        expect(readFileSync(restored.env.HARNESS_CONTEXT_FILE!, 'utf8')).toBe(context)
        const fork = prepareHarnessLaunch(pkg, workspace, engine, `${engine}-fork`, {}, engine)
        expect(fork.env.HARNESS_CONTEXT_FILE).not.toBe(originalLaunch.env.HARNESS_CONTEXT_FILE)
        expect(readFileSync(fork.env.HARNESS_CONTEXT_FILE!, 'utf8').replaceAll(fork.env.HARNESS_SKILLS_DIR!, originalLaunch.env.HARNESS_SKILLS_DIR)).toBe(context)
      }
    })
  }
})

for (const engine of PROCESS_ENGINES) it(`${engine}: prepare → spawn → tool → verdict → restart → fork`, async () => {
  const dir = join(root, 'package')
  write(join(dir, 'harness.json'), JSON.stringify({ spec: 1, id: 'test/portable', name: 'Portable', engine: 'claude',
    workspace: { template: 'template', marker: 'scene.txt', init: 'init.sh' },
    agent: { instructions: 'AGENTS.md', skills: ['skills'], env: { DRAW: '${dsh}/draw.sh' } },
    verdict: '.harness/verdict.json' }))
  write(join(dir, 'template/scene.txt'), 'blank scene\n')
  write(join(dir, 'AGENTS.md'), '# Portable\nRead the draw skill; run "$DRAW" to produce scene.txt and the verdict.\n')
  write(join(dir, 'skills/draw/SKILL.md'), '# Draw\nThe command "$DRAW" writes the artifact and verdict.\n')
  write(join(dir, 'init.sh'), '#!/bin/sh\nprintf "%s" "$HARNESS_DSH" > initialized\n', true)
  write(join(dir, 'draw.sh'), '#!/bin/sh\nprintf "drawn by %s\\n" "$HARNESS_DSH" > scene.txt\nprintf \'{"ready":true,"artifact":"scene.txt"}\\n\' > .harness/verdict.json\n', true)
  const pkg = installed(dir)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  await materializeWorkspace(pkg, workspace, {}, engine)
  expect(readFileSync(join(workspace, 'initialized'), 'utf8')).toBe(pkg.id)
  const launch = prepareHarnessLaunch(pkg, workspace, engine, 'created')
  const fixture = join(root, 'fixture-engine.cjs')
  write(fixture, `const fs = require('node:fs'), cp = require('node:child_process');
    const ctx = fs.readFileSync(process.env.HARNESS_CONTEXT_FILE, 'utf8');
    if (!ctx.includes('# Portable') || !ctx.includes('draw/SKILL.md')) throw Error('missing context');
    const skill = fs.readFileSync(process.env.HARNESS_SKILLS_DIR + '/draw/SKILL.md', 'utf8');
    if (!skill.includes('$DRAW')) throw Error('missing tool contract');
    cp.execFileSync(process.env.DRAW, [], { cwd: process.env.HARNESS_WORKSPACE, env: process.env });
  `)
  const run = (launchEnv: Record<string, string>) => execFileSync(process.execPath, [fixture], { cwd: workspace, env: { PATH: process.env.PATH, ...launchEnv } })
  let recorded: Record<string, unknown> | undefined
  const created = await createAndRegisterPane({ engine, cwd: workspace, sessionLabel: 'created',
    argv: [process.execPath, fixture], env: launch.env, dsh: pkg.id, dshRuntime: 'created',
    tmuxBackend: { create: async input => { run(input.env!); return { state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId: '%1' } } }, kill: async () => ({ state: 'succeeded', dispatch: 'executed' }) },
    registry: { openPendingAgent: input => { recorded = input; return { ...input, agentId: 'registered' } as RegisteredSession } } })
  expect(created.ok).toBe(true)
  expect(recorded).toMatchObject({ engine, dsh: pkg.id, dshRuntime: 'created', cwd: workspace })
  expect(JSON.parse(readFileSync(join(workspace, '.harness/verdict.json'), 'utf8'))).toEqual({ ready: true, artifact: 'scene.txt' })
  expect(readFileSync(join(workspace, 'scene.txt'), 'utf8')).toBe('drawn by test/portable\n')
  const restored = await buildLaunchOverrides({ machine: () => ({ hermesSystemManaged: false }), writeGridConfigDir: async () => '/unused',
    tmuxSupportsSessionEnv: async () => true, installCodexHooks: () => {},
    dshLaunch: (_id, ws, selected, key) => prepareHarnessLaunch(pkg, ws, selected, key) }, engine,
  { dsh: pkg.id, cwd: workspace, dshRuntime: 'created' }, 'registered')
  expect(restored.ok).toBe(true)
  if (!restored.ok) throw new Error(restored.detail)
  run(restored.overrides.env)
  const fork = prepareHarnessLaunch(pkg, workspace, engine, 'fork', {}, 'created')
  run(fork.env)
  expect(fork.env.HARNESS_CONTEXT_FILE).not.toBe(launch.env.HARNESS_CONTEXT_FILE)
  expect(readFileSync(join(workspace, 'scene.txt'), 'utf8')).toBe('drawn by test/portable\n')
  expect((await materializeWorkspace(pkg, workspace, {}, engine)).initLines).toEqual([])
})
