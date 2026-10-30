import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Harness's read-only recipes for a Buddy (docs/specs/2026-10-30-buddy-read-access.md): `harness buddy-read NAME`, which
 * its guard lets it run once its person approved it, outside Claude Code's sandbox as Harness's own commands run. Each is
 * a fixed read, so a routine measurement needs no free-form shell, and each handles any login itself, so the Buddy never
 * sees one.
 *
 * db-size is Juno's database read (Lead, 10-30): the row count of each collection by estimatedDocumentCount, and the
 * attachments' bytes as a $sum of size on SuperTabAttachment, nothing wider. The login is the read-only one Ken's clone
 * keeps as MONGODB_PROD_RO_URL in .secrets/mongodb-prod-readonly.env; mongosh gets it by environment only, never on its
 * command line, where any process could read it, and refuses any login with a role beyond reading.
 */

/** The roles of a read-only login: reading data and the cluster's own statistics. */
const READ_ROLES = ['read', 'readAnyDatabase', 'clusterMonitor']

/** What mongosh runs for db-size, with no rc file of the person's: its login from the environment, its roles checked first. */
export const DB_SIZE_SCRIPT = [
  'const db = connect(process.env.HARNESS_RO_DB_URL);',
  `const roles = ((db.runCommand({ connectionStatus: 1 }).authInfo || {}).authenticatedUserRoles || []).map((r) => r.role);`,
  `if (!roles.length || roles.some((role) => !${JSON.stringify(READ_ROLES)}.includes(role))) { print(JSON.stringify({ refused: 'not read-only', roles })); quit(3) }`,
  'const collections = {};',
  'for (const name of db.getCollectionNames().sort()) collections[name] = db.getCollection(name).estimatedDocumentCount();',
  `const total = db.SuperTabAttachment.aggregate([{ $group: { _id: null, bytes: { $sum: '$size' } } }]).toArray()[0];`,
  'print(JSON.stringify({ database: db.getName(), collections, attachmentBytes: total ? total.bytes : 0 }));',
].join('\n')

/** Where the read-only login is kept, in the main clone (a worktree has no .secrets folder), and its variable. */
const LOGIN_FILE = join('.secrets', 'mongodb-prod-readonly.env')
const LOGIN_VARIABLE = 'MONGODB_PROD_RO_URL'

/** [name]'s value in an env file: NAME=value, with export before it or quotes around the value. */
function envValue(text: string, name: string): string | null {
  for (const line of text.split('\n')) {
    const match = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*?)\\s*$`).exec(line)
    if (match) return match[1]!.replace(/^(['"])(.*)\1$/, '$2') || null
  }
  return null
}

/** [text] with every connection string, and the login's own user and password wherever they appear, taken out. */
function scrub(text: string, url: string): string {
  let clean = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]*@[^\s'"]*/gi, '<connection string>')
  try {
    const { username, password } = new URL(url)
    for (const part of [password, username].map(decodeURIComponent).filter(part => part.length >= 3)) clean = clean.split(part).join('<hidden>')
  } catch { /* not a URL: nothing more to find */ }
  return clean
}

export interface BuddyReadDeps { cwd: string; path: string; write: (text: string) => void }

export async function buddyReadCommand(args: readonly string[], deps: BuddyReadDeps = { cwd: process.cwd(), path: process.env.PATH ?? '',
  write: (text) => { process.stdout.write(text) } }): Promise<number> {
  if (args.length !== 1 || args[0] !== 'db-size') {
    deps.write('Usage: harness buddy-read db-size\n  db-size: each collection\'s row count and the attachments\' bytes, through the read-only login.\n')
    return 2
  }
  const common = spawnSync('git', ['-C', deps.cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 10_000 })
  const file = common.status === 0 ? join(dirname(common.stdout.trim()), LOGIN_FILE) : null
  let url: string | null = null
  try { url = file ? envValue(readFileSync(file, 'utf8'), LOGIN_VARIABLE) : null } catch { /* none here */ }
  if (!url) {
    deps.write(`No read-only database login here: it is ${LOGIN_VARIABLE} in ${file ?? LOGIN_FILE} of this project's clone.\n`)
    return 1
  }
  const run = spawnSync('mongosh', ['--nodb', '--quiet', '--norc', '--eval', DB_SIZE_SCRIPT], { encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, PATH: deps.path, HARNESS_RO_DB_URL: url } })
  if (run.error) {
    deps.write(`mongosh could not run here: ${scrub(run.error.message, url)}\n`)
    return 1
  }
  deps.write(scrub(`${run.stdout}${run.status === 0 ? '' : run.stderr}`, url))
  return run.status === 0 ? 0 : run.status === 3 ? 3 : 1
}
