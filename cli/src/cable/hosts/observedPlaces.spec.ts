import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { observedPlaces } from './observedPlaces.js'

let base: string
/** The default Claude Code home, its projects folder and a home the person moved. */
let claudeHome: string
let projects: string
let moved: string
let codexHome: string
let orca: { claude: string[]; codex: string[] }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'observed-places-'))
  claudeHome = join(base, '.claude')
  projects = join(claudeHome, 'projects')
  moved = join(base, 'moved')
  codexHome = join(base, '.codex')
  for (const dir of [projects, join(claudeHome, 'sessions'), join(moved, 'projects'), codexHome]) mkdirSync(dir, { recursive: true })
  orca = { claude: [], codex: [] }
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const places = () => observedPlaces({
  claudeRoots: () => [projects, join(moved, 'projects')],
  codexRoots: () => [codexHome],
  orca: () => orca,
})

/** An Orca account home with a `sessions` folder of its own; `projects` a folder, a link to `link`, or none. */
function orcaHome(name: string, projectsFolder: 'own' | 'none' | { link: string }): string {
  const home = join(base, 'orca', name)
  mkdirSync(join(home, 'sessions'), { recursive: true })
  if (projectsFolder === 'own') mkdirSync(join(home, 'projects'))
  else if (projectsFolder !== 'none') symlinkSync(projectsFolder.link, join(home, 'projects'))
  return home
}

describe('observedPlaces', () => {
  it('with no Orca home the places are today\'s', () => {
    const { claude, codex } = places()
    expect(claude.roots()).toEqual([projects, join(moved, 'projects')])
    expect(claude.records()).toEqual([join(claudeHome, 'sessions'), join(moved, 'sessions')])
    expect(codex.roots()).toEqual([codexHome])
  })

  it('a linked folder is read once', () => {
    const home = orcaHome('linked', { link: projects })
    orca.claude = [home]
    const { claude } = places()
    expect(claude.roots()).toEqual([projects, join(moved, 'projects')])
    expect(claude.records()).toEqual([join(claudeHome, 'sessions'), join(moved, 'sessions'), join(home, 'sessions')])
  })

  it('an Orca home\'s own projects folder is a root', () => {
    const home = orcaHome('own', 'own')
    orca.claude = [home]
    expect(places().claude.roots()).toEqual([projects, join(moved, 'projects'), join(home, 'projects')])
  })

  it('one with no projects folder adds no root', () => {
    const home = orcaHome('bare', 'none')
    orca.claude = [home]
    const { claude } = places()
    expect(claude.roots()).toEqual([projects, join(moved, 'projects')])
    expect(claude.records()).toEqual([join(claudeHome, 'sessions'), join(moved, 'sessions'), join(home, 'sessions')])
  })

  it('the same home twice, or the default home as an account, adds nothing twice', () => {
    const home = orcaHome('own', 'own')
    orca.claude = [home, home, claudeHome]
    const { claude } = places()
    expect(claude.roots()).toEqual([projects, join(moved, 'projects'), join(home, 'projects')])
    expect(claude.records()).toEqual([join(claudeHome, 'sessions'), join(moved, 'sessions'), join(home, 'sessions')])
  })

  it('Codex\'s roots are today\'s and then Orca\'s', () => {
    const first = join(base, 'orca', 'codex-1')
    const second = join(base, 'orca', 'codex-2')
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    symlinkSync(codexHome, join(base, 'codex-link'))
    orca.codex = [first, codexHome, join(base, 'codex-link'), second, first]
    expect(places().codex.roots()).toEqual([codexHome, first, second])
  })

  it('the lists follow the last read', () => {
    const { claude, codex } = places()
    expect(claude.roots()).toEqual([projects, join(moved, 'projects')])
    const home = orcaHome('later', 'own')
    const codexAccount = join(base, 'orca', 'codex-later')
    mkdirSync(codexAccount, { recursive: true })
    orca = { claude: [home], codex: [codexAccount] }
    expect(claude.roots()).toEqual([projects, join(moved, 'projects'), join(home, 'projects')])
    expect(claude.records()).toEqual([join(claudeHome, 'sessions'), join(moved, 'sessions'), join(home, 'sessions')])
    expect(codex.roots()).toEqual([codexHome, codexAccount])
  })
})
