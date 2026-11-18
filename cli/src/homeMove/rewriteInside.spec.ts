/**
 * What names the old tree, inside it (docs/plans/2026-11-18-linux-xdg-paths-design.md, The move, step 6): each record
 * that stores a path under ~/.harness names the entry's new place, and the journal holds what each was, to put it back.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHomeAdopter, readAdoptedHomes } from '../engines/kit/homeAdoption.js'
import type { Done } from './journal.js'
import { planMove } from './plan.js'
import { dropAside, restoreAside, restoreFile, rewriteInside } from './rewriteInside.js'

type Homes = { claude: string[]; codex: string[] }
type FileDone = Extract<Done, { did: 'file' }>

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** A home whose ~/.harness of [names] is staged, as step 5 leaves it: each entry in its root's `.moving` folder. */
function staged(names = ['cli', 'dsh', 'claude-profiles', 'runtime']) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'move-inside-')))
  homes.push(home)
  const plan = planMove(home, {}, names)
  const at = (entry: string, ...rest: string[]): string => join(plan.entries.find((each) => each.name === entry)!.staged, ...rest)
  const dataDir = at('cli', 'data')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  return { home, plan, at, dataDir, old: (...rest: string[]): string => join(plan.legacy, ...rest) }
}

/** Writes [value] (JSON, or a string as it is) at [path]; returns the journal line its rewrite must leave. */
function put(path: string, value: unknown, mode = 0o600): FileDone {
  const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, text, { mode })
  chmodSync(path, mode)
  return { did: 'file', path, before: Buffer.from(text).toString('base64') }
}

/** The move's journal, checking that each line is written while what it names is still as it was. */
function journal() {
  const done: Done[] = []
  return {
    done,
    add(step: Done): void {
      if (step.did === 'file') expect(readFileSync(step.path).toString('base64')).toBe(step.before)
      if (step.did === 'aside') expect([existsSync(step.path), existsSync(step.aside)]).toEqual([true, false])
      done.push(step)
    },
  }
}

const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
const sets = (catalog: Homes) => ({ claude: new Set(catalog.claude), codex: new Set(catalog.codex) })

/** Every name under [path] with its bytes, and with [stamped] its inode and time: what any write would change. */
function tree(path: string, stamped = false): Record<string, string> {
  const found: Record<string, string> = {}
  const walk = (at: string): void => {
    const info = lstatSync(at)
    const stamp = stamped ? `${info.ino}:${info.mtimeMs}:` : ''
    if (info.isDirectory()) {
      found[relative(path, at)] = `${stamp}folder`
      for (const name of readdirSync(at)) walk(join(at, name))
    } else found[relative(path, at)] = `${stamp}${readFileSync(at).toString('base64')}`
  }
  walk(path)
  return found
}

const POOL = ['.adoptions', '.adopted', '.confirmations']

/** An engine-home journal with its catalog and two sealed adoptions: 000.json, 001.json, .adopted, .confirmations/001.committed. */
function sealedJournal(t: ReturnType<typeof staged>): { file: string; catalog: FileDone; homes: Homes; moved: Homes } {
  const file = join(t.dataDir, 'engine-homes.json')
  const catalog = put(file, { claude: [t.old('claude-profiles', 'work')], codex: [] })
  createHomeAdopter(file).adopt({ claude: ['/h2/.claude-personal'], codex: [] })
  createHomeAdopter(file).adopt({ claude: [], codex: [t.old('claude-profiles', 'codex-work')] })
  expect(readdirSync(`${file}.adoptions`).filter((name) => name.endsWith('.json')).sort()).toEqual(['000.json', '001.json'])
  expect(readdirSync(`${file}.confirmations`)).toEqual(['001.committed'])
  expect(existsSync(`${file}.adopted`)).toBe(true)
  return {
    file, catalog,
    homes: { claude: [t.old('claude-profiles', 'work'), '/h2/.claude-personal'], codex: [t.old('claude-profiles', 'codex-work')] },
    moved: { claude: [`${t.plan.data}/claude-profiles/work`, '/h2/.claude-personal'], codex: [`${t.plan.data}/claude-profiles/codex-work`] },
  }
}

describe('the move rewrites what names the old tree, inside it', () => {
  it('runtime/current-node and current-grid, and any other current-* file there whose text is a path in the old tree', () => {
    const t = staged()
    const pointers = [
      put(t.at('runtime', 'current-node'), `${t.old('runtime', 'node-v24.11.0-linux-x64', 'bin', 'node')}\n`),
      put(t.at('runtime', 'current-grid'), `${t.old('runtime', 'grid-b7', 'bin', 'grid')}\n`),
      put(t.at('runtime', 'current-tmux'), `${t.old('runtime', 'tmux-3.5a', 'bin', 'tmux')}\n`),
    ]
    const system = put(t.at('runtime', 'current-other'), '/usr/bin/tmux\n')
    const steps = journal()
    expect(rewriteInside(t.plan, t.dataDir, steps)).toEqual({ files: 3, left: [] })
    expect(pointers.map((pointer) => readFileSync(pointer.path, 'utf8'))).toEqual([
      `${t.plan.state}/runtime/node-v24.11.0-linux-x64/bin/node\n`,
      `${t.plan.state}/runtime/grid-b7/bin/grid\n`,
      `${t.plan.state}/runtime/tmux-3.5a/bin/tmux\n`,
    ])
    expect(readFileSync(system.path, 'utf8')).toBe('/usr/bin/tmux\n')
    expect(steps.done).toHaveLength(3)
    expect(steps.done).toEqual(expect.arrayContaining(pointers))
  })

  it('registry.json (claudeHome, transcriptPath, cwd) and stopped-agents/*.json', () => {
    const t = staged()
    const row = {
      id: 'a1', claudeHome: t.old('claude-profiles', 'work'),
      transcriptPath: t.old('claude-profiles', 'work', 'projects', 'p', 's.jsonl'), cwd: t.old('community', 'k', 'project'),
    }
    const moved = {
      id: 'a1', claudeHome: `${t.plan.data}/claude-profiles/work`,
      transcriptPath: `${t.plan.data}/claude-profiles/work/projects/p/s.jsonl`, cwd: `${t.plan.data}/community/k/project`,
    }
    const registry = put(join(t.dataDir, 'registry.json'), [row])
    const stopped = put(join(t.dataDir, 'stopped-agents', 'a1.json'), { version: 1, session: row })
    const steps = journal()
    expect(rewriteInside(t.plan, t.dataDir, steps)).toEqual({ files: 2, left: [] })
    expect(json(registry.path)).toEqual([moved])
    expect(json(stopped.path)).toEqual({ version: 1, session: moved })
    expect(steps.done).toEqual([registry, stopped])
  })

  it('claude-profiles.json, codex-profiles.json; dial-setup.json, dial-skill.json; node-migration.json', () => {
    const t = staged()
    const work = t.old('claude-profiles', 'work')
    const movedWork = `${t.plan.data}/claude-profiles/work`
    const records = [
      put(join(t.dataDir, 'claude-profiles.json'), [work, '/h2/.claude-personal']),
      put(join(t.dataDir, 'codex-profiles.json'), [t.old('claude-profiles', 'codex-work')]),
      put(join(t.dataDir, 'dial-setup.json'), { dial: true, homes: { claude: [work], codex: [] }, pluginHomes: [work] }),
      put(join(t.dataDir, 'dial-skill.json'), { removed: {}, homes: { claude: [work], codex: [] }, pluginHomes: [] }),
      put(t.at('cli', 'node-migration.json'), { reason: 'rolled-back', at: 1, node: t.old('runtime', 'node-v24.11.0-linux-x64', 'bin', 'node') }),
    ]
    const steps = journal()
    expect(rewriteInside(t.plan, t.dataDir, steps)).toEqual({ files: 5, left: [] })
    expect(records.map((record) => json(record.path))).toEqual([
      [movedWork, '/h2/.claude-personal'],
      [`${t.plan.data}/claude-profiles/codex-work`],
      { dial: true, homes: { claude: [movedWork], codex: [] }, pluginHomes: [movedWork] },
      { removed: {}, homes: { claude: [movedWork], codex: [] }, pluginHomes: [] },
      { reason: 'rolled-back', at: 1, node: `${t.plan.state}/runtime/node-v24.11.0-linux-x64/bin/node` },
    ])
    expect(steps.done).toHaveLength(5)
    expect(steps.done).toEqual(expect.arrayContaining(records))
  })

  it('dsh/installed.json: dir moves, and every record gains setup pending, a linked one too while the runtime moves', () => {
    const t = staged()
    const godogen = { id: 'autonomous/godogen', dir: t.old('dsh', 'autonomous', 'godogen'), source: 'https://example.com/godogen.git', ref: 'main', commit: 'abc', linked: false, installedAt: 1 }
    const score = { id: 'autonomous/score', dir: t.old('dsh', 'autonomous', 'score'), source: 'https://example.com/score.git', ref: null, commit: null, linked: false, installedAt: 2, setup: 'needs-setup' }
    // Its folder is a link in the tree to a checkout outside it: the link moves, the checkout's files do not, and what its
    // setup built there runs on Harness's Python, in the runtime that moves.
    const dev = { id: 'me/dev', dir: t.old('dsh', 'me', 'dev'), source: '/src/dev', ref: null, commit: null, linked: true, installedAt: 3 }
    const index = put(t.at('dsh', 'installed.json'), [godogen, score, dev])
    const steps = journal()
    expect(rewriteInside(t.plan, t.dataDir, steps)).toEqual({ files: 1, left: [] })
    expect(json(index.path)).toEqual([
      { ...godogen, dir: `${t.plan.data}/dsh/autonomous/godogen`, setup: 'pending' },
      { ...score, dir: `${t.plan.data}/dsh/autonomous/score`, setup: 'pending' },
      { ...dev, dir: `${t.plan.data}/dsh/me/dev`, setup: 'pending' },
    ])
    expect(steps.done).toEqual([index])
  })

  it('dsh/installed.json with no runtime in the tree: a linked record gains no mark, as nothing it built names the tree', () => {
    const t = staged(['cli', 'dsh'])
    const godogen = { id: 'autonomous/godogen', dir: t.old('dsh', 'autonomous', 'godogen'), source: 'https://example.com/godogen.git', ref: 'main', commit: 'abc', linked: false, installedAt: 1 }
    const dev = { id: 'me/dev', dir: t.old('dsh', 'me', 'dev'), source: '/src/dev', ref: null, commit: null, linked: true, installedAt: 3 }
    const index = put(t.at('dsh', 'installed.json'), [godogen, dev])
    expect(rewriteInside(t.plan, t.dataDir, journal())).toEqual({ files: 1, left: [] })
    expect(json(index.path)).toEqual([
      { ...godogen, dir: `${t.plan.data}/dsh/autonomous/godogen`, setup: 'pending' },
      { ...dev, dir: `${t.plan.data}/dsh/me/dev` },
    ])
  })

  it('engine-homes.json is sealed again', () => {
    const t = staged()
    const { file, catalog, homes: before, moved } = sealedJournal(t)
    const pool = Object.fromEntries(POOL.map((name) => [name, tree(`${file}${name}`)]))
    const steps = journal()
    expect(rewriteInside(t.plan, t.dataDir, steps)).toEqual({ files: 1, left: [] })
    expect(sets(readAdoptedHomes(file).homes)).toEqual(sets(moved))
    expect(sets(before)).not.toEqual(sets(moved))
    expect(json(file)).toEqual({ claude: [`${t.plan.data}/claude-profiles/work`], codex: [] })
    expect(steps.done).toEqual([catalog, ...POOL.map((name) => ({ did: 'aside', path: `${file}${name}`, aside: `${file}${name}.before-move` }))])
    for (const name of POOL) expect(tree(`${file}${name}.before-move`)).toEqual(pool[name])
    // A new pool of one sealed record.
    expect(readdirSync(`${file}.adoptions`).filter((name) => name.endsWith('.json'))).toEqual(['000.json'])
    // The finish deletes the old pool; the new one reads on its own.
    for (const step of steps.done) if (step.did === 'aside') dropAside(step)
    expect(readdirSync(t.dataDir).filter((name) => name.endsWith('.before-move'))).toEqual([])
    expect(sets(readAdoptedHomes(file).homes)).toEqual(sets(moved))
  })

  it('with no pool on disk only the catalog is rewritten', () => {
    const t = staged()
    const file = join(t.dataDir, 'engine-homes.json')
    const catalog = put(file, { claude: [t.old('claude-profiles', 'work'), '/h2/.claude-personal'], codex: [] })
    const steps = journal()
    expect(rewriteInside(t.plan, t.dataDir, steps)).toEqual({ files: 1, left: [] })
    expect(json(file)).toEqual({ claude: [`${t.plan.data}/claude-profiles/work`, '/h2/.claude-personal'], codex: [] })
    expect(readdirSync(t.dataDir)).toEqual(['engine-homes.json'])
    expect(steps.done).toEqual([catalog])
  })

  it('restoreAside undoes the new pool', () => {
    const t = staged()
    const { file, homes: before } = sealedJournal(t)
    const was = tree(t.dataDir)
    const steps = journal()
    rewriteInside(t.plan, t.dataDir, steps)
    for (const step of [...steps.done].reverse()) {
      if (step.did === 'file') restoreFile(step)
      if (step.did === 'aside') restoreAside(step)
    }
    expect(tree(t.dataDir)).toEqual(was)
    expect(sets(readAdoptedHomes(file).homes)).toEqual(sets(before))
  })

  it('restoreAside with no aside on disk leaves the path', () => {
    const t = staged()
    // A crash between the journal line and the rename.
    const path = join(t.dataDir, 'engine-homes.json.adopted')
    writeFileSync(path, 'sealed\n')
    restoreAside({ did: 'aside', path, aside: `${path}.before-move` })
    expect(readFileSync(path, 'utf8')).toBe('sealed\n')
  })

  it('an engine-home journal readAdoptedHomes refuses is left and named', () => {
    const t = staged()
    const { file } = sealedJournal(t)
    writeFileSync(join(`${file}.adoptions`, 'stray'), '')
    expect(() => readAdoptedHomes(file)).toThrow()
    const was = tree(t.dataDir)
    const steps = journal()
    expect(rewriteInside(t.plan, t.dataDir, steps)).toEqual({ files: 0, left: [file] })
    // Nothing of it is renamed, nor its catalog rewritten.
    expect(tree(t.dataDir)).toEqual(was)
    expect(steps.done).toEqual([])
  })

  it('in each moved profile, plugins/installed_plugins.json (installPath) and plugins/known_marketplaces.json (installLocation)', () => {
    const t = staged()
    const profiles = ['work', 'personal']
    const plugin = (home: string) => ({ version: 2, plugins: { 'dial@harness': [{ scope: 'user', installPath: `${home}/plugins/cache/harness/dial/1.0.0`, version: '1.0.0' }] } })
    const marketplace = (home: string) => ({ harness: { source: { source: 'directory', path: '/src/marketplace' }, installLocation: `${home}/plugins/marketplaces/harness`, lastUpdated: '2026-11-18T00:00:00.000Z' } })
    const records = profiles.flatMap((profile) => [
      put(t.at('claude-profiles', profile, 'plugins', 'installed_plugins.json'), plugin(t.old('claude-profiles', profile))),
      put(t.at('claude-profiles', profile, 'plugins', 'known_marketplaces.json'), marketplace(t.old('claude-profiles', profile))),
    ])
    const steps = journal()
    expect(rewriteInside(t.plan, t.dataDir, steps)).toEqual({ files: 4, left: [] })
    expect(records.map((record) => json(record.path))).toEqual(profiles.flatMap((profile) => [
      plugin(`${t.plan.data}/claude-profiles/${profile}`), marketplace(`${t.plan.data}/claude-profiles/${profile}`),
    ]))
    expect(steps.done).toHaveLength(4)
    expect(steps.done).toEqual(expect.arrayContaining(records))
  })

  it('only a string that starts with an old entry\'s path changes', () => {
    const t = staged()
    // Spelled as no writer here spells it: every byte but the two moved strings stays.
    const text = `{"beside":${JSON.stringify(`${t.home}/.harness-other/x`)}, ${JSON.stringify(t.old('dsh', 'a'))} : "a key",\n`
      + `\t"count": 3.50, "elsewhere": "/opt/h/.harness/dsh", "within": ${JSON.stringify(`see ${t.old('dsh')}`)},\n`
      + `  "entry": ${JSON.stringify(t.old('dsh'))}, "below":${JSON.stringify(t.old('dsh', 'a'))} }`
    const registry = put(join(t.dataDir, 'registry.json'), text)
    const steps = journal()
    expect(rewriteInside(t.plan, t.dataDir, steps)).toEqual({ files: 1, left: [] })
    expect(readFileSync(registry.path, 'utf8')).toBe(text
      .replace(`"entry": ${JSON.stringify(t.old('dsh'))}`, `"entry": ${JSON.stringify(`${t.plan.data}/dsh`)}`)
      .replace(`"below":${JSON.stringify(t.old('dsh', 'a'))}`, `"below":${JSON.stringify(`${t.plan.data}/dsh/a`)}`))
    expect(steps.done).toEqual([registry])
  })

  it('a file nothing in changed is not written', () => {
    const t = staged()
    put(join(t.dataDir, 'claude-profiles.json'), ['/h2/.claude-personal'])
    put(t.at('runtime', 'current-node'), '/usr/bin/node\n')
    put(t.at('dsh', 'installed.json'), [{ id: 'me/dev', dir: '/src/dev', source: '/src/dev', ref: null, commit: null, linked: true, installedAt: 3, setup: 'pending' }])
    const file = join(t.dataDir, 'engine-homes.json')
    put(file, { claude: ['/h2/.claude-personal'], codex: [] })
    createHomeAdopter(file).adopt({ claude: [], codex: ['/h2/.codex'] })
    const was = tree(t.home, true)
    const steps = journal()
    expect(rewriteInside(t.plan, t.dataDir, steps)).toEqual({ files: 0, left: [] })
    expect(tree(t.home, true)).toEqual(was)
    expect(steps.done).toEqual([])
  })

  it('a file that is not JSON is left and named', () => {
    const t = staged()
    const cut = `{"claudeHome":${JSON.stringify(t.old('claude-profiles', 'work'))}`
    const registry = put(join(t.dataDir, 'registry.json'), cut)
    const profiles = put(join(t.dataDir, 'claude-profiles.json'), [t.old('claude-profiles', 'work')])
    const steps = journal()
    expect(rewriteInside(t.plan, t.dataDir, steps)).toEqual({ files: 1, left: [registry.path] })
    expect(readFileSync(registry.path, 'utf8')).toBe(cut)
    expect(steps.done).toEqual([profiles])
  })

  it('modes are kept', () => {
    const t = staged()
    const registry = put(join(t.dataDir, 'registry.json'), [{ cwd: t.old('community', 'k', 'project') }], 0o600)
    const plugins = put(t.at('claude-profiles', 'work', 'plugins', 'installed_plugins.json'), { installPath: t.old('claude-profiles', 'work', 'plugins', 'cache') }, 0o644)
    expect(rewriteInside(t.plan, t.dataDir, journal())).toEqual({ files: 2, left: [] })
    expect(statSync(registry.path).mode & 0o7777).toBe(0o600)
    expect(statSync(plugins.path).mode & 0o7777).toBe(0o644)
  })

  it('a data folder kept elsewhere by ADAPTER_DATA_DIR is rewritten where it is', () => {
    const t = staged()
    const kept = join(t.home, 'kept', 'data')
    const registry = put(join(kept, 'registry.json'), [{ claudeHome: t.old('claude-profiles', 'work') }])
    const steps = journal()
    expect(rewriteInside(t.plan, kept, steps)).toEqual({ files: 1, left: [] })
    expect(json(registry.path)).toEqual([{ claudeHome: `${t.plan.data}/claude-profiles/work` }])
    expect(steps.done).toEqual([registry])
  })

  it('restoreFile puts back the exact bytes, or removes a file that was not there', () => {
    const t = staged()
    const registry = put(join(t.dataDir, 'registry.json'), `[ {"cwd" : ${JSON.stringify(t.old('community', 'k'))},\t"n": 1.50} ]\n`, 0o640)
    const steps = journal()
    rewriteInside(t.plan, t.dataDir, steps)
    expect(readFileSync(registry.path).toString('base64')).not.toBe(registry.before)
    restoreFile(registry)
    expect(readFileSync(registry.path).toString('base64')).toBe(registry.before)
    expect(statSync(registry.path).mode & 0o7777).toBe(0o640)
    const made = join(t.dataDir, 'dial-setup.json')
    writeFileSync(made, '{}')
    restoreFile({ did: 'file', path: made, before: null })
    expect(existsSync(made)).toBe(false)
  })
})
