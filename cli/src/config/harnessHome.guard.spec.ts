/**
 * Every path under the account's ~/.harness is built by config/harnessHome.ts, so a later change of the home's layout
 * (XDG, docs/plans/2026-11-18-harness-paths-design.md) is one table. This guard fails on a hand-built one, in the shapes
 * the code used before the module: a `.harness` segment joined onto a home, `.harness` straight after home text, a
 * pattern that matches a home path, and the module's HARNESS_HOME_NAME used elsewhere. A project's or workspace's
 * `.harness/` and `.harness-<name>` files are not the home.
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
/** The home folder's name, which joined onto a home is a hand-built path with no literal to find. */
const NAME = /\bHARNESS_HOME_NAME\b/g

/** [code] is the hit's whole line, without comments, trimmed. */
interface Hit { file: string, line: number, text: string, code: string }

const printed = (hit: Hit): string => `${hit.file}:${hit.line}: ${hit.text}`

/** The hits in one file's source; `file` is relative to cli/src, or `hook/…`. */
function hitsIn(file: string, source: string): Hit[] {
  const lines = withoutComments(source.split('\n'), file.endsWith('.sh'))
  return lines.flatMap((code, index) => {
    const nearHome = lines.slice(Math.max(0, index - 2), index + 1).some((line) => HOME.test(line))
    const texts = [...(nearHome ? [...code.matchAll(SEGMENT), ...code.matchAll(INTERPOLATED)] : []), ...code.matchAll(INLINE), ...code.matchAll(PATTERN), ...code.matchAll(NAME)]
    return texts.map(([text]) => ({ file, line: index + 1, text, code: code.trim() }))
  })
}

/**
 * The lines without their comments, so line numbers stay and the code beside a comment is still read. A comment starts
 * outside a string literal, at a line's start or after whitespace, which a URL's `://` is not: `//` to the line's end,
 * `/*` to its `*\/` on this line or a later one, and `#` in a shell script. A literal ends with its line, so a quote in a
 * regular expression hides no more than the rest of that line.
 */
function withoutComments(lines: string[], shell: boolean): string[] {
  let inBlock = false
  return lines.map((line) => {
    let code = ''
    let quote = ''
    for (let at = 0; at < line.length; at++) {
      const char = line[at]
      if (inBlock) {
        if (line.startsWith('*/', at)) { inBlock = false; at++ }
        continue
      }
      if (quote) {
        // An escaped character, a quote among them, does not end the literal.
        if (char === '\\') { code += line.slice(at, at + 2); at++; continue }
        if (char === quote) quote = ''
      } else {
        const starts = at === 0 || /\s/.test(line[at - 1])
        if (starts && (shell ? char === '#' : line.startsWith('//', at))) break
        if (starts && !shell && line.startsWith('/*', at)) { inBlock = true; at++; continue }
        if (/['"`]/.test(char)) quote = char
      }
      code += char
    }
    return code
  })
}

/** A hit on one of these lines, each as Hit's [code]: a second hit in the same file is not excused with it. */
const onLine = (...lines: string[]) => (hit: Hit): boolean => lines.includes(hit.code)

const ALLOWED: { files: string[], hit: (hit: Hit) => boolean, why: string }[] = [
  { files: ['hook/notify.mjs'], hit: () => true, why: 'Runs as an installed copy with no import from src; its bytes feed Codex\'s trusted hash' },
  { files: ['engines/kit/notifyHooks.ts'], hit: onLine(String.raw`const LEGACY_SCRIPT = /\/\.harness\/cli\/(?:hook\/)?notify\.mjs$/`), why: 'LEGACY_SCRIPT: what old installs wrote' },
  { files: ['lib/localSocket.ts'], hit: onLine(String.raw`if (!/[\\/]\.harness[\\/]s[\\/][0-9a-f]{16}$/.test(folder)) return`), why: 'prepareShortFolder checks the shape of a folder it is handed' },
  { files: ['harnessd/platform.ts'], hit: onLine('return this.deps.dataDir ?? join(this.deps.home, \'.harness\', \'cli\', \'data\')'), why: 'The master imports only Node and its own folder: the fallback for a service built without the data folder' },
  { files: ['lib/uninstall/removal.ts'], hit: onLine('import { HARNESS_HOME_NAME } from \'../../config/harnessHome.js\'', 'const ROOT_NAME = HARNESS_HOME_NAME'), why: 'checkRoot refuses a root not named after the home folder' },
  { files: ['cli.ts', 'lib/uninstall/command.ts', 'config/startHome.ts', 'config/testIsolation.ts'], hit: (hit) => hit.text.startsWith('~'), why: 'Help and message text a person reads' },
]

const allowed = (hit: Hit): boolean => ALLOWED.some((entry) => entry.files.includes(hit.file) && entry.hit(hit))

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
      String.raw`const pattern = /[\\/]\.?harness[\\/]s/`,
      '/* a comment */ const dir = join(home, \'.harness\')',
      'const url = \'http://x //y\'; const dir = join(home, \'.harness\')',
      'const dir = join(homedir(), HARNESS_HOME_NAME, \'logs\')',
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

  it('excuses an allowlisted line, not another hit in the same file', () => {
    for (const [file, planted] of [
      ['harnessd/platform.ts', 'const logs = join(this.deps.home, \'.harness\', \'logs\')'],
      ['lib/localSocket.ts', String.raw`const pattern = /\/\.harness\/run/`],
      ['engines/kit/notifyHooks.ts', String.raw`const pattern = /\/\.harness\/run/`],
    ]) expect(hitsIn(file, planted).filter((hit) => !allowed(hit)), `${file}: ${planted}`).toHaveLength(1)
  })

  it('every allowlist entry still matches a hit', () => {
    const hits = treeHits()
    const stale = ALLOWED.flatMap((entry) => entry.files.filter((file) => !hits.some((hit) => hit.file === file && entry.hit(hit))))
    expect(stale).toEqual([])
  })
})
