import { describe, expect, it } from 'vitest'
import { LINE_MAX, NAME_MAX, NEEDS_MAX, SHARDS_MAX, shardName, shardsOf } from './suites.js'

const FILE = `# Suites

The suites CI does not run, a row for each shard.

| Shard | Needs | Command |
|---|---|---|
| desktop-macos-1 | macos, flutter | \`python3 scripts/test-desktop.py --shard 1/2\` |
   |desktop-macos-2|  macOS ,flutter|\`python3   scripts/test-desktop.py\t--shard 2/2\`|
| cli/core | | \`npm --prefix cli run test:core\` |
`
const row = (name: string, needs = '', command = 'make test') => `| ${name} | ${needs} | \`${command}\` |`

describe('a project\'s suites file', () => {
  it('reads each row that names a shard, what its computer needs and its command, in the file\'s order', () => {
    expect(shardsOf(FILE)).toEqual([
      { name: 'desktop-macos-1', needs: ['macos', 'flutter'], command: 'python3 scripts/test-desktop.py --shard 1/2' },
      // Spaces and a tab between words are one space, and a need is read in lower case.
      { name: 'desktop-macos-2', needs: ['macos', 'flutter'], command: 'python3 scripts/test-desktop.py --shard 2/2' },
      { name: 'cli/core', needs: [], command: 'npm --prefix cli run test:core' }])
  })

  it('reads no row from a file that is missing, empty, or no table of commands', () => {
    for (const text of [null, '', '# Suites\n\nRun them.', '| Shard | Needs | Command |\n|---|---|---|\n| unit | node | npm test |',
      // Two cells are a goal's row, four are no row, and one with no bar at an end is a sentence.
      '| unit | `npm test` |', '| unit | node | mac | `npm test` |', 'unit | node | `npm test` |', '| unit | node | `npm test`',
      // Words before the first bar or after the last, and an empty cell more, are no row either.
      'see | unit | node | `npm test` |', '| unit | node | `npm test` | twice', '| unit | node | `npm test` || more', '| unit | node | `npm test` ||',
      // A command of nothing would pass by running nothing, and one with a backtick at one end only is cut by nothing.
      '| unit | node | `` |', '| unit | node | ` ` |', '| unit | node | ` |', '| unit | node | `npm test` twice |', '| unit | node | npm test` |', '| unit | node | `npm test |']) {
      expect(shardsOf(text), String(text)).toEqual([])
    }
  })

  // A name is typed in a command and is part of a check's name on GitHub: never free text.
  it('reads a name only as lower-case letters, digits and . _ - /, a letter or digit first, and no longer than a name is', () => {
    for (const name of ['a', '9', 'desktop-macos-1', 'cli/core', 'e2e_3.of.8', 'x'.repeat(NAME_MAX)]) {
      expect(shardsOf(row(name)), name).toEqual([{ name, needs: [], command: 'make test' }])
      expect(shardName(name), name).toBe(true)
    }
    for (const name of ['', 'Desktop', 'desktop macos', '-desktop', '/core', '.hidden', 'unit!', 'unit;rm', 'unit`', 'ünit', 'x'.repeat(NAME_MAX + 1)]) {
      expect(shardsOf(row(name)), name).toEqual([])
      expect(shardName(name), name).toBe(false)
    }
    expect(shardName(7)).toBe(false)
  })

  it('reads needs as words with commas between, each once, and no row when one is not a word or there are too many', () => {
    expect(shardsOf(row('unit', 'macos,macos , node')).map(shard => shard.needs)).toEqual([['macos', 'node']])
    expect(shardsOf(row('unit', Array.from({ length: NEEDS_MAX }, (_, n) => `tool${n}`).join(','))).map(shard => shard.needs.length)).toEqual([NEEDS_MAX])
    for (const needs of ['mac os', 'macos,', ',macos', 'macos,,node', 'c++ compiler', '-x', 'x'.repeat(41), '$HOME',
      Array.from({ length: NEEDS_MAX + 1 }, (_, n) => `tool${n}`).join(',')]) {
      expect(shardsOf(row('unit', needs)), needs).toEqual([])
    }
    expect(shardsOf(row('unit', 'c++, python3, node_18, x86-64')).map(shard => shard.needs)).toEqual([['c++', 'python3', 'node_18', 'x86-64']])
  })

  // A command is run without a shell, the same on macOS, Linux and Windows: what needs one goes in a script.
  it('reads a command only as plain words: no quote, pipe, variable or other mark a shell would read', () => {
    for (const command of ['make', 'npx vitest run --config vitest.e2e.ci.config.ts --shard=1/8', './scripts/suite.sh 1/2', 'python3 -m pytest tests/e2e -k a,b',
      'make test JOBS=4', 'dart test --total-shards=2 --shard-index=0', 'tool user@host:path 50%+1']) {
      expect(shardsOf(row('unit', '', command)).map(shard => shard.command), command).toEqual([command])
    }
    for (const command of ['make test ARGS="--shard 1/2"', "sh -c 'npm test'", 'npm test && rm -rf x', 'npm test; ls', 'echo $HOME', 'npm test > out', 'npm test < in',
      'ls *', 'ls ~', 'a (b)', 'a \\ b', 'a #b', 'a !b', 'a {b}', 'a [b]', 'a ? b', 'npm tést']) {
      expect(shardsOf(row('unit', '', command)), command).toEqual([])
    }
    // A bar in a command ends its cell: four cells are no row.
    expect(shardsOf(row('unit', '', 'npm test | tee out'))).toEqual([])
    // A backtick in a command ends it early: what follows is no word.
    expect(shardsOf('| unit | | `echo `id`` |')).toEqual([])
  })

  it('counts a shard named twice once, and reads no more than a file holds', () => {
    expect(shardsOf([row('unit', '', 'make a'), row('unit', '', 'make b'), row('e2e', '', 'make c')].join('\r\n')))
      .toEqual([{ name: 'unit', needs: [], command: 'make a' }, { name: 'e2e', needs: [], command: 'make c' }])
    const many = shardsOf(Array.from({ length: SHARDS_MAX + 5 }, (_, n) => row(`shard-${n}`, '', `make shard-${n}`)).join('\n'))
    expect(many).toHaveLength(SHARDS_MAX)
    expect(many.at(-1)).toEqual({ name: `shard-${SHARDS_MAX - 1}`, needs: [], command: `make shard-${SHARDS_MAX - 1}` })
  })

  // Read by one split of a line no longer than a row is, so a file is read in time by its length, as the goal's is (goal.ts).
  it('reads no row from a line too long to be one, and the rows among a megabyte of the longest lines', () => {
    const longest = (length: number) => row('unit', '', `make ${'b'.repeat(length - '| unit |  | `make ` |'.length)}`)
    expect(longest(LINE_MAX)).toHaveLength(LINE_MAX)
    expect(shardsOf(longest(LINE_MAX))).toHaveLength(1)
    expect(shardsOf(longest(LINE_MAX + 1))).toEqual([])
    const slow = [`|${'|'.repeat(LINE_MAX - 1)}`, `| a |${' '.repeat(LINE_MAX - 10)}\`x`, `|${' |'.repeat(498)} x`]
    for (const line of slow) expect(line.length).toBeLessThanOrEqual(LINE_MAX)
    const file = [...Array.from({ length: 1_000 }, (_, n) => slow[n % slow.length]), `| a${' '.repeat(400_000)}| x`, row('unit')].join('\n')
    expect(shardsOf(file)).toEqual([{ name: 'unit', needs: [], command: 'make test' }])
  })
})
