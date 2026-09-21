import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDsh, formatCheck } from './check.js'

const STARTER = realpathSync(fileURLToPath(new URL('../../../store/starter', import.meta.url)))

describe('checkDsh', () => {
  let copy: string
  beforeEach(() => { copy = mkdtempSync(join(tmpdir(), 'dsh-check-')); cpSync(STARTER, copy, { recursive: true }) })
  afterEach(() => rmSync(copy, { recursive: true, force: true }))

  it('passes the starter fixture with no failures', () => {
    const result = checkDsh(STARTER)
    expect(result.ok).toBe(true)
    expect(result.lines.filter((l) => l.level === 'fail')).toEqual([])
    expect(result.lines.some((l) => l.what.includes('skills/ · hello'))).toBe(true)
  })

  it('fails on a missing path, a reserved env key, and a viewer url without a port', () => {
    writeFileSync(join(copy, 'harness.json'), JSON.stringify({
      spec: 1, id: 'acme/broken', name: 'Broken', engine: 'claude',
      workspace: { template: 'nope', marker: 'x' },
      agent: { instructions: 'AGENTS.md', skills: ['skills'], env: { HARNESS_DSH: 'x', OK: '${dsh}/bin' } },
      toolchain: { doctor: 'toolchain/missing.sh' },
      viewer: { command: 'echo hi', url: 'http://127.0.0.1:4000/' },
    }))
    const result = checkDsh(copy)
    expect(result.ok).toBe(false)
    const fails = result.lines.filter((l) => l.level === 'fail').map((l) => l.what)
    expect(fails.some((w) => w.includes('workspace.template nope'))).toBe(true)
    expect(fails.some((w) => w.includes('agent.env.HARNESS_DSH is reserved'))).toBe(true)
    expect(fails.some((w) => w.includes('toolchain.doctor toolchain/missing.sh'))).toBe(true)
    expect(fails.some((w) => w.includes('viewer.url has no ${port}'))).toBe(true)
  })

  it('a wrapper whose setup fetches the upstream has its instructions, template and skills only after setup: warned, not failed', () => {
    writeFileSync(join(copy, 'harness.json'), JSON.stringify({
      spec: 1, id: 'acme/wrapper', name: 'Wrapper', engine: 'codex', author: 'Acme', description: 'wraps a project',
      workspace: { template: 'upstream/harness/template', marker: 'model.py' },
      agent: { instructions: 'upstream/harness/AGENTS.md', skills: ['upstream/skills'] },
      toolchain: { setup: 'toolchain/setup.sh' },
    }))
    mkdirSync(join(copy, 'toolchain'), { recursive: true })
    writeFileSync(join(copy, 'toolchain', 'setup.sh'), '#!/bin/sh\n', { mode: 0o755 })
    const result = checkDsh(copy)
    const warns = result.lines.filter((l) => l.level === 'warn').map((l) => l.what)
    expect(result.lines.filter((l) => l.level === 'fail')).toEqual([])
    expect(result.ok).toBe(true)
    for (const path of ['workspace.template upstream/harness/template', 'agent.instructions upstream/harness/AGENTS.md', 'agent.skills upstream/skills']) {
      expect(warns.some((w) => w.startsWith(path) && w.includes('toolchain.setup must create it')), path).toBe(true)
    }
  })

  it('reports an unparseable manifest as the one failure', () => {
    writeFileSync(join(copy, 'harness.json'), '{"spec": 3}')
    const result = checkDsh(copy)
    expect(result.ok).toBe(false)
    expect(result.manifest).toBeNull()
    expect(result.lines).toHaveLength(1)
  })
})

describe('checkDsh, every answer it gives', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-check-each-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** Lay out a checkout and check it; the lines as the terminal prints them. A name ending in / is a folder. */
  const check = (manifest: Record<string, unknown>, files: Record<string, string> = {}): { ok: boolean; out: string[] } => {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir)
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true })
      if (name.endsWith('/')) mkdirSync(join(dir, name), { recursive: true })
      else writeFileSync(join(dir, name), body)
    }
    writeFileSync(join(dir, 'harness.json'), JSON.stringify({ spec: 1, id: 'acme/thing', name: 'Thing', ...manifest }))
    const result = checkDsh(dir)
    return { ok: result.ok, out: formatCheck(result).split('\n') }
  }
  const complete = { engine: 'claude', author: 'Acme', description: 'A thing', agent: { instructions: 'AGENTS.md', skills: ['skills'] }, toolchain: { doctor: 'doctor.sh' } }
  const completeFiles = { 'AGENTS.md': '# Thing\n', 'skills/draw/SKILL.md': '---\nname: draw\n---\n', 'doctor.sh': '#!/bin/sh\n' }

  it('a complete tier-0 agent: every line ok, printed with its level in a column', () => {
    const { ok, out } = check(complete, completeFiles)
    expect(ok).toBe(true)
    expect(out).toEqual([
      'ok   harness.json parses · acme/thing "Thing" runs on claude',
      'ok   agent.instructions AGENTS.md',
      'ok   agent.skills skills/ · draw',
      'ok   toolchain.doctor doctor.sh',
    ])
  })

  it('warns about what a tile will lack: a description, an author, instructions, skills, a doctor', () => {
    const { ok, out } = check({ engine: 'codex' })
    expect(ok).toBe(true)
    expect(out).toEqual([
      'ok   harness.json parses · acme/thing "Thing" runs on codex',
      'warn no description — the picker tile will have none',
      'warn no author — the tile will not say who made it',
      'warn no agent.instructions — the agent gets no AGENTS.md from this harness',
      'warn no agent.skills — a tier-0 harness usually ships at least one',
      'warn no toolchain.doctor — Harness cannot tell the user what is missing before a create',
    ])
  })

  it('a viewer package: named as one, no author or skills expected, a workspace or verdict warned', () => {
    const { ok, out } = check({
      kind: 'viewer', workspace: { marker: 'x' }, verdict: '.harness/verdict.json',
      toolchain: { setup: 'npm ci --silent', doctor: 'doctor.sh' },
      viewer: { command: 'viewer.sh', url: 'http://localhost:${port}/?file=${artifact}', artifactExtensions: ['.step'] },
    }, { 'doctor.sh': '', 'viewer.sh': '' })
    expect(ok).toBe(true)
    expect(out).toEqual([
      'ok   harness.json parses · acme/thing "Thing" is a viewer package',
      'warn no description',
      'warn a viewer package has no workspace of its own; workspace.* is ignored',
      'warn a viewer package writes no verdict; the harness that uses it does',
      'ok   toolchain.setup is a shell line',
      'ok   toolchain.doctor doctor.sh',
      'ok   viewer.command viewer.sh',
    ])
    const lean = check({ kind: 'viewer', description: 'A pane', toolchain: { doctor: 'doctor.sh' }, viewer: { command: 'viewer.sh', url: 'http://127.0.0.1:${port}/' } }, { 'doctor.sh': '', 'viewer.sh': '' })
    // nothing about instructions or skills: a viewer package may not have an agent section at all
    expect(lean.out).toEqual(['ok   harness.json parses · acme/thing "Thing" is a viewer package', 'ok   toolchain.doctor doctor.sh', 'ok   viewer.command viewer.sh'])
  })

  it('the workspace: a template with and without its marker, and an init as a script or a shell line', () => {
    const markerMissing = check({ ...complete, workspace: { template: 'template', marker: 'deck.md', init: 'init.sh' } }, { ...completeFiles, 'template/other.md': '', 'init.sh': '' })
    expect(markerMissing.out).toEqual(expect.arrayContaining([
      'ok   workspace.template template/',
      'warn workspace.marker deck.md is not in the template, so a fresh workspace stays "fresh" until something else writes it',
      'ok   workspace.init init.sh',
    ]))
    const noMarker = check({ ...complete, workspace: { template: 'template', init: 'npm run init' } }, { ...completeFiles, 'template/deck.md': '' })
    expect(noMarker.out).toEqual(expect.arrayContaining([
      'warn workspace.template without workspace.marker: the template is copied on EVERY create',
      'ok   workspace.init is a shell line',
    ]))
    const inTemplate = check({ ...complete, workspace: { template: 'template', marker: 'deck.md', init: 'missing-init.sh' } }, { ...completeFiles, 'template/deck.md': '' })
    expect(inTemplate.ok).toBe(false)
    expect(inTemplate.out.filter((line) => line.includes('workspace.'))).toEqual([
      'ok   workspace.template template/',
      'fail workspace.init missing-init.sh does not exist',
    ])
  })

  it('what a setup fetches is warned about; with no setup to fetch it, the same absence fails', () => {
    const agent = { instructions: 'upstream/AGENTS.md', skills: ['upstream/skills'] }
    const withoutSetup = check({ ...complete, agent }, { 'doctor.sh': '' })
    expect(withoutSetup.ok).toBe(false)
    expect(withoutSetup.out).toEqual(expect.arrayContaining([
      'fail agent.instructions upstream/AGENTS.md does not exist',
      'fail agent.skills upstream/skills is not a directory',
    ]))
    const withSetup = check({ ...complete, agent, toolchain: { setup: 'setup.sh', doctor: 'doctor.sh' } }, { 'doctor.sh': '', 'setup.sh': '' })
    expect(withSetup.ok).toBe(true)
    expect(withSetup.out).toEqual(expect.arrayContaining([
      'warn agent.instructions upstream/AGENTS.md is not in the checkout; toolchain.setup must create it',
      'warn agent.skills upstream/skills is not in the checkout; toolchain.setup must create it, or the agent gets no skills',
      'ok   toolchain.setup setup.sh',
    ]))
  })

  it('skills: a root that is itself one skill, and a root with none in it', () => {
    const { ok, out } = check({ ...complete, agent: { instructions: 'AGENTS.md', skills: ['skills/draw', 'empty'] } }, { ...completeFiles, 'empty/': '' })
    expect(ok).toBe(false)
    expect(out).toEqual(expect.arrayContaining([
      'ok   agent.skills skills/draw/ · .',
      'fail agent.skills empty has no SKILL.md-bearing directory',
    ]))
  })

  it('env: HARNESS_* is reserved, an unknown ${var} is warned, the three Harness expands pass', () => {
    const env = { HARNESS_WORKSPACE: '/x', TOOLS: '${dsh}/bin:${workspace}:${home}', ODD: '${user}/bin' }
    const { ok, out } = check({ ...complete, agent: { ...complete.agent, env } }, completeFiles)
    expect(ok).toBe(false)
    expect(out.filter((line) => line.includes('agent.env'))).toEqual([
      'fail agent.env.HARNESS_WORKSPACE is reserved (HARNESS_* is set by Harness)',
      'warn agent.env.ODD uses a variable Harness does not expand: ${user}/bin',
    ])
  })

  it('toolchain and viewer commands: a script that must exist, or a shell line that is not checked', () => {
    const { ok, out } = check({ ...complete, toolchain: { setup: 'missing-setup.sh', doctor: './doctor.sh' }, viewer: { command: 'node viewer.mjs', url: 'https://example.com:${port}/' } }, completeFiles)
    expect(ok).toBe(false)
    expect(out.slice(-4)).toEqual([
      'fail toolchain.setup missing-setup.sh does not exist',
      'ok   toolchain.doctor ./doctor.sh',
      'ok   viewer.command is a shell line',
      'warn viewer.url is not loopback; the pane expects a local server',
    ])
  })

  it('a viewer of its own: a missing command, a url with no port, ${artifact} with nothing to fill it', () => {
    const { ok, out } = check({ ...complete, viewer: { command: 'viewer.sh', url: 'http://127.0.0.1:4000/?file=${artifact}' } }, completeFiles)
    expect(ok).toBe(false)
    expect(out.slice(-3)).toEqual([
      'fail viewer.command viewer.sh does not exist',
      'fail viewer.url has no ${port}: Harness picks the port, the URL must use it',
      'warn viewer.url uses ${artifact} but no artifactExtensions are declared: only a verdict can name one',
    ])
  })

  it('a used viewer: installed with the harness; a narrowed url must still use the port', () => {
    const plain = check({ ...complete, viewer: { use: 'acme/pane' } }, completeFiles)
    expect(plain.ok).toBe(true)
    expect(plain.out.at(-1)).toBe('ok   viewer.use acme/pane — installed with this harness; its command and URL come from that package')
    expect(check({ ...complete, viewer: { use: 'acme/pane', url: 'http://127.0.0.1:${port}/?file=${artifact}' } }, completeFiles).ok).toBe(true)
    const portless = check({ ...complete, viewer: { use: 'acme/pane', url: 'http://127.0.0.1:4000/' } }, completeFiles)
    expect(portless.ok).toBe(false)
    expect(portless.out.at(-1)).toBe('fail viewer.url has no ${port}: Harness picks the port, the URL must use it')
  })

  it('a verdict outside .harness/ is allowed, and said', () => {
    const { ok, out } = check({ ...complete, verdict: 'out/verdict.json' }, completeFiles)
    expect(ok).toBe(true)
    expect(out.at(-1)).toBe('warn verdict out/verdict.json is outside .harness/ — allowed, but the convention is .harness/verdict.json')
  })
})
