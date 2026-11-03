import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Harness's read-only recipes for a Buddy (docs/specs/2026-10-30-buddy-read-access.md): `harness buddy-read NAME`, which
 * its guard lets it run once its person approved it, outside Claude Code's sandbox as Harness's own commands run. Each is
 * a fixed read, so a routine measurement needs no free-form shell, and each handles any login itself, so the Buddy never
 * sees one.
 *
 * db-size is Juno's database read (Lead, 10-30): the row count of each collection by estimatedDocumentCount, and the
 * attachments' bytes as a $sum of size on SuperTabAttachment, nothing wider. The login is the read-only one its person
 * keeps as MONGODB_PROD_RO_URL in ~/.secrets/mongodb-prod-readonly.env; mongosh gets it by environment only, never on its
 * command line, where any process could read it, and refuses any login with a role beyond reading.
 */

/** The roles of a read-only login. clusterMonitor is not one: its actions include setting changes. */
const READ_ROLES = ['read', 'readAnyDatabase']
/** What a read-only login may do, as the server lists its privileges (connectionStatus with showPrivileges): every action
 *  MongoDB 8.0 gives its read and readAnyDatabase roles (src/mongo/db/auth/builtin_roles.yml on branch v8.0, read 10-30),
 *  each a read. A role is only a name; a custom one named "read" could insert (review of #2310). planCacheRead reads the
 *  query planner's cache ($planCacheStats, planCacheListFilters); production's readAnyDatabase has it, and leaving it out
 *  refused Ken's login (10-30). 8.2's read adds performRawDataOperations, left out until production runs 8.2. */
const READ_ACTIONS = ['changeStream', 'collStats', 'dbHash', 'dbStats', 'find', 'killCursors', 'listCollections', 'listIndexes',
  'listSearchIndexes', 'planCacheRead', 'listDatabases']

/** What mongosh runs for db-size, with no rc file of the person's: its login from the environment, its roles checked first. */
export const DB_SIZE_SCRIPT = [
  'const db = connect(process.env.HARNESS_RO_DB_URL);',
  'const auth = db.runCommand({ connectionStatus: 1, showPrivileges: true }).authInfo || {};',
  'const roles = (auth.authenticatedUserRoles || []).map((r) => r.role);',
  'const actions = [].concat(...(auth.authenticatedUserPrivileges || []).map((p) => p.actions || []));',
  `if (!roles.length || !actions.length || roles.some((role) => !${JSON.stringify(READ_ROLES)}.includes(role))`
    + ` || actions.some((action) => !${JSON.stringify(READ_ACTIONS)}.includes(action))) { print(JSON.stringify({ refused: 'not read-only', roles })); quit(3) }`,
  // A number as JSON prints it. MongoDB hands 64-bit integers over as bson Longs (low and high 32-bit parts), which printed
  // as {"low":…,"high":…} on Ken's Mac (CLI 0.5.17, 10-30); past 2^53 a plain number would round, so those print as digits.
  'const plain = (value) => {',
  '  if (value === null || value === undefined) return 0;',
  "  if (typeof value === 'number') return value;",
  "  if (typeof value === 'object' && value._bsontype === 'Decimal128') return Number(String(value));",
  "  const big = typeof value === 'bigint' ? value : typeof value === 'object' && Number.isInteger(value.low) && Number.isInteger(value.high)",
  '    ? (BigInt(value.unsigned ? value.high >>> 0 : value.high) << 32n) + BigInt(value.low >>> 0) : null;',
  '  if (big === null) return Number(value);',
  '  return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : String(big);',
  '};',
  'const collections = {};',
  'for (const name of db.getCollectionNames().sort()) collections[name] = plain(db.getCollection(name).estimatedDocumentCount());',
  `const total = db.SuperTabAttachment.aggregate([{ $group: { _id: null, bytes: { $sum: '$size' } } }]).toArray()[0];`,
  'print(JSON.stringify({ database: db.getName(), collections, attachmentBytes: total ? plain(total.bytes) : 0 }));',
].join('\n')

/** Where the read-only login is kept, in the person's home, and its variable. One fixed place, wherever the command runs:
 *  looking in the clone the command ran from found nothing from a Swarm worktree on Ken's Mac (10-30), and a login in the
 *  working folder is one a pull request could add. The Buddy's guard keeps any .secrets folder closed to the Buddy itself,
 *  and its sandbox denies ~/.secrets by path. */
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

export interface BuddyReadDeps { home: string; path: string; write: (text: string) => void }

export async function buddyReadCommand(args: readonly string[], deps: BuddyReadDeps = { home: homedir(), path: process.env.PATH ?? '',
  write: (text) => { process.stdout.write(text) } }): Promise<number> {
  if (args.length !== 1 || args[0] !== 'db-size') {
    deps.write('Usage: harness buddy-read db-size\n  db-size: each collection\'s row count and the attachments\' bytes, through the read-only login.\n')
    return 2
  }
  const file = join(deps.home, LOGIN_FILE)
  let url: string | null = null
  try { url = envValue(readFileSync(file, 'utf8'), LOGIN_VARIABLE) } catch { /* none on this machine */ }
  if (!url) {
    deps.write(`No read-only database login on this machine. Put ${LOGIN_VARIABLE}=<the read-only connection string> in ${file}, `
      + 'in the home of the person this machine belongs to, readable by them alone (chmod 600). It is read from there wherever this runs.\n')
    return 1
  }
  const run = spawnSync('mongosh', ['--nodb', '--quiet', '--norc', '--eval', DB_SIZE_SCRIPT], { encoding: 'utf8', timeout: 120_000,
    // No usage data from this run (review of #2310). mongosh turns its telemetry off for one run only by this variable or
    // its global config file's forceDisableTelemetry (mongodb-js/mongosh packages/cli-repl/src/cli-repl.ts, read 10-30);
    // DO_NOT_TRACK does nothing there, and disableTelemetry() would change the person's own settings for good.
    env: { ...process.env, PATH: deps.path, HARNESS_RO_DB_URL: url, MONGOSH_FORCE_DISABLE_TELEMETRY_FOR_TESTING: '1' } })
  if (run.error) {
    deps.write(`mongosh could not run here: ${scrub(run.error.message, url)}\n`)
    return 1
  }
  deps.write(scrub(`${run.stdout}${run.status === 0 ? '' : run.stderr}`, url))
  return run.status === 0 ? 0 : run.status === 3 ? 3 : 1
}
