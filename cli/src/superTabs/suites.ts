/**
 * The suites a project's CI does not run, as its repository lists them (anh Dee, 2026-11-11: "end to end testing with
 * runners … takes forever on one machine").
 *
 * CI splits its own suites over runners. The ones it does not run (here: Desktop on macOS, the coverage gates, VM tests)
 * run on one computer, in turn, and a Swarm has many people's computers. So a project lists each such suite as its shards in
 * `agents/SUITES.md`, a table of three columns: a shard's name, what its computer needs, and its command, in backticks. A
 * shard's result is a commit status named `suite: <shard>` on the exact commit it ran on (githubSuite.ts), which the train
 * counts as any check of that commit (githubMerge.ts checksOf). The design, and what of it is built, is
 * docs/design/2026-11-11-swarm-allocator/suites-across-machines.md.
 *
 * The file is the repository's text, and each cell goes somewhere it could do harm as free text: a name is typed in a
 * command and is part of a check's name on GitHub, a need is compared with what a computer reports, and a command is to be
 * run on a person's computer without a shell, the same on macOS, Linux and Windows. So each is read as plain words only, and
 * a row that is anything else is no row. What needs a quote, a pipe or a variable goes in a script of the repository.
 *
 * Here only the reading. Nothing is run.
 */

export const SUITES_FILE = 'agents/SUITES.md'
/** How a shard's check is named on GitHub, before the shard's name as its row writes it. */
export const SUITE_CHECK = 'suite: '
/** The most shards read, as a train carries twenty pull requests at most: each is a status written in a person's name for
 *  every train. A name fits a command line and a check's name; a row's needs are a few tools and a system. */
export const SHARDS_MAX = 20, NAME_MAX = 60, NEEDS_MAX = 8
/** The longest line read as a row, as a goal's (goal.ts): it bounds a command. */
export const LINE_MAX = 1_000

/** One row: the shard's name, what its computer needs (the words `needs:` labels use, assign/crew.ts machineHas), and its
 *  command as words with one space between. */
export interface Shard { name: string; needs: string[]; command: string }

const NAME = new RegExp(`^[a-z0-9][a-z0-9._/-]{0,${NAME_MAX - 1}}$`)
const NEED = /^[a-z0-9][a-z0-9_.+-]{0,39}$/
/** A command's word: letters, digits, and the marks no shell reads. */
const WORD = /^[A-Za-z0-9_./:=@%+,-]+$/

/** Whether [value] is a shard's name: lower-case letters, digits and `. _ - /`, a letter or digit first. */
export const shardName = (value: unknown): value is string => typeof value === 'string' && NAME.test(value)

/** The shards of a suites file: each table row of three cells whose third is a command in backticks, in the file's order. A
 *  header, a rule, a row of any other width and any other line are none; nor is a row whose name, needs or command is not
 *  plain words. A name written twice counts once. Each line is split once and is no longer than [LINE_MAX], so a file is read
 *  in time by its length. */
export function shardsOf(text: string | null): Shard[] {
  const shards = new Map<string, Shard>()
  for (const line of (text ?? '').split(/\r?\n/)) {
    if (line.length > LINE_MAX) continue
    // `| name | needs | \`command\` |`: a bar at each end and two between. A bar inside a cell makes one cell more.
    const cells = line.trim().split('|')
    if (cells.length !== 5 || cells[0] !== '' || cells[4] !== '') continue
    const name = cells[1]!.trim(), wanted = cells[2]!.trim(), cell = cells[3]!.trim()
    if (!NAME.test(name) || shards.has(name) || !cell.startsWith('`') || !cell.endsWith('`')) continue
    // Spaces and tabs between words are one space. A command of no word would pass by running nothing.
    const words = cell.slice(1, -1).trim().split(/[ \t]+/)
    if (!words.every(word => WORD.test(word))) continue
    const needs = wanted ? [...new Set(wanted.split(',').map(need => need.trim().toLowerCase()))] : []
    if (needs.length > NEEDS_MAX || !needs.every(need => NEED.test(need))) continue
    shards.set(name, { name, needs, command: words.join(' ') })
    if (shards.size >= SHARDS_MAX) break
  }
  return [...shards.values()]
}
