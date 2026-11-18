/**
 * Every path under the account's ~/.harness is built by config/harnessHome.ts, so a later change of the home's layout
 * (XDG, docs/plans/2026-11-18-harness-paths-design.md) is one table. This guard fails on a hand-built one, in the shapes
 * the code used before the module: a `.harness` segment joined onto a home, `.harness` straight after home text, and a
 * pattern that matches a home path. A project's or workspace's `.harness/` and `.harness-<name>` files are not the home.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..')
const HOOK = join(SRC, '..', 'hook')

/** A `.harness` path segment that starts a string literal, after a separator or not: '.harness', ".harness/runtime", '/.harness', '\\.harness'. */
const SEGMENT = /(['"`])(?:\\\\|[\\/])?\.harness(?:[\\/][^'"`\n]*)?\1/g
/**
 * A home, on the literal's line or one of the two lines above it: SEGMENT is a hit only with one. Any "home" in any case
 * (homedir(), userInfo().homedir, homeDir, ownerHome, HOME), USERPROFILE in any case, or an account.
 */
const HOME = /home|userprofile|\baccount\b/i
/** `.harness` straight after home text in one literal: $HOME/.harness, ~/.harness, %USERPROFILE%\.harness. */
const INLINE = /(?:\$HOME|~|%USERPROFILE%|\$env:USERPROFILE)[\\/]+\.harness(?![\w-])/g
/** `.harness` straight after an interpolation, ${x}/.harness: a hit only near a home, like SEGMENT, as ${workspace}/.harness is a project's. */
const INTERPOLATED = /\}[\\/]+\.harness(?![\w-])/g
/** A regular expression that matches a home path: \/\.harness, [\\/]\.harness. */
const PATTERN = /(?:\\\/|\[\\\\\/\])\\\.harness(?![\w-])/g

interface Hit { file: string, line: number, text: string }

const printed = (hit: Hit): string => `${hit.file}:${hit.line}: ${hit.text}`

/** The hits in one file's source; `file` is relative to cli/src, or `hook/…`. */
function hitsIn(file: string, source: string): Hit[] {
  const lines = withoutComments(source.split('\n'), file.endsWith('.sh'))
  return lines.flatMap((code, index) => {
    const nearHome = lines.slice(Math.max(0, index - 2), index + 1).some((line) => HOME.test(line))
    const texts = [...(nearHome ? [...code.matchAll(SEGMENT), ...code.matchAll(INTERPOLATED)] : []), ...code.matchAll(INLINE), ...code.matchAll(PATTERN)]
    return texts.map(([text]) => ({ file, line: index + 1, text }))
  })
}

/**
 * The lines with comments blanked, so line numbers stay. A block comment runs from a line whose first text is `/*` to
 * the first line holding its end; a line comment starts at `//` (`#` in a shell script) at a line's start or after
 * whitespace, which a URL's `://` is not.
 */
function withoutComments(lines: string[], shell: boolean): string[] {
  let inBlock = false
  const lineComment = shell ? /(?:^|\s)#/ : /(?:^|\s)\/\//
  return lines.map((line) => {
    if (inBlock || (!shell && line.trimStart().startsWith('/*'))) {
      inBlock = !line.includes('*/', inBlock ? 0 : line.indexOf('/*') + 2)
      return ''
    }
    const at = line.search(lineComment)
    return at === -1 ? line : line.slice(0, at)
  })
}

/** Whether a matched text is all of one shape. */
const isShape = (shape: RegExp) => (text: string): boolean => new RegExp(`^(?:${shape.source})$`).test(text)

const ALLOWED: { files: string[], text: (text: string) => boolean, why: string }[] = [
  { files: ['hook/notify.mjs'], text: () => true, why: 'Runs as an installed copy with no import from src; its bytes feed Codex\'s trusted hash' },
  { files: ['engines/kit/notifyHooks.ts'], text: isShape(PATTERN), why: 'LEGACY_SCRIPT: what old installs wrote' },
  { files: ['lib/localSocket.ts'], text: isShape(PATTERN), why: 'prepareShortFolder checks the shape of a folder it is handed' },
  { files: ['harnessd/platform.ts'], text: isShape(SEGMENT), why: 'The master imports only Node and its own folder; its fallback is listed for PR 2' },
  { files: ['cli.ts', 'lib/uninstall/command.ts', 'config/startHome.ts', 'config/testIsolation.ts'], text: (text) => text.startsWith('~'), why: 'Help and message text a person reads' },
]

const allowed = (hit: Hit): boolean => ALLOWED.some((entry) => entry.files.includes(hit.file) && entry.text(hit.text))

/** Every hit in cli/src and cli/hook but tests, fixtures, generated code and the module itself. */
function treeHits(): Hit[] {
  const hits: Hit[] = []
  const walk = (dir: string, name: (path: string) => string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '__fixtures__' && entry.name !== 'generated') walk(path, name)
        continue
      }
      const file = name(path)
      if (!/\.(?:ts|mjs|js|cjs|sh)$/.test(file) || /\.(?:spec|test)\.ts$/.test(file) || file === 'config/harnessHome.ts') continue
      hits.push(...hitsIn(file, readFileSync(path, 'utf8')))
    }
  }
  walk(SRC, (path) => relative(SRC, path).replaceAll('\\', '/'))
  walk(HOOK, (path) => `hook/${relative(HOOK, path).replaceAll('\\', '/')}`)
  return hits
}

describe('no hand-built home .harness path outside config/harnessHome.ts', () => {
  it('finds each shape in a planted line', () => {
    for (const planted of [
      'const dir = join(homedir(), \'.harness\', \'cli\')',
      'const dir = join(home, \'.harness/runtime\')',
      'const h = process.env.HOME ?? \'\'\nconst x = 1\nconst dir = join(h, \'.harness\')',
      'const dir = join(userInfo().homedir, \'.harness\')',
      'const where = os.homedir\nconst dir = join(where(), \'.harness\')',
      'const dir = join(homeDir, \'.harness\')',
      'const dir = join(userHome, \'.harness\')',
      'const dir = join(ownerHome, \'.harness\')',
      'const dir = join(env.UserProfile, \'.harness\')',
      'const dir = homedir() + \'/.harness/cli\'',
      'const dir = join(home, \'/.harness\')',
      String.raw`const dir = home + '\\.harness'`,
      'const dir = "$HOME/.harness/run"',
      'const dir = `${home}/.harness/logs`',
      String.raw`const dir = '%USERPROFILE%\\.harness'`,
      String.raw`const pattern = /\/\.harness\/cli/`,
      String.raw`const pattern = /[\\/]\.harness[\\/]s/`,
    ]) expect(hitsIn('lib/planted.ts', planted), planted).toHaveLength(1)
  })

  it('ignores comments, a project\'s folder and .harness-<name> files', () => {
    const planted = [
      '// join(home, \'.harness\')',
      '/*',
      ' * join(home, \'.harness\')',
      ' */',
      'const a = join(workspace, \'.harness\', \'runtime\')',
      'const b = \'.harness/handoff\'',
      'const runtime = `${workspace}/.harness/runtime`',
      'const handoff = `${cwd}/.harness/handoff/${id}.json`',
      'const c = \'.harness-team-privacy\'',
      'const d = `${file}.harness-${process.pid}.tmp`',
      'const e = owner.harness',
    ].join('\n')
    expect(hitsIn('lib/planted.ts', planted)).toEqual([])
  })

  it('cli/src and cli/hook hold none but the allowlisted', () => {
    const hits = treeHits().filter((hit) => !allowed(hit))
    expect(hits.map(printed), 'Build the path with harnessPath() from config/harnessHome.ts.').toEqual([])
  })

  it('every allowlist entry still matches a hit', () => {
    const hits = treeHits()
    const stale = ALLOWED.flatMap(({ files, text }) => files.filter((file) => !hits.some((hit) => hit.file === file && text(hit.text))))
    expect(stale).toEqual([])
  })
})
