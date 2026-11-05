// One row per computer (#3122): computers listed in Swarms under two accounts before a sign-in moved them. From this release a
// sign-in moves the computer's entries by itself (superTabs/computerMoves.ts); this moves the ones listed twice already, once.
// Dry run by default: it writes nothing and prints each computer shared by two accounts, every move the write would make
// (Swarm, old entry and owner, new entry and owner), and every move the Swarm refuses (`left`, with its refusal's code). Both
// decide through the same checks, the dry run without a transaction, so what it prints is what the write does (task #3227:
// it once listed a move the write then refused). `--write` prints the moves it made and the ones it left: what Ken's go
// covered, and what each old owner can add back with Add machine.
// It reads every machine row that has a computer id, once, on the (computerId, userId) index: check that read's plan and the
// collection's size on the read-only login (dry run) before the go.
// Rows count as one computer by their computer id alone, which is self-declared: a pinned ADAPTER_COMPUTER_ID shared by
// containers under different accounts reads as one computer here. The write moves an entry only where both accounts' logs
// hold the same machine key for it (computerMoves.ts sameComputerKey), so those containers are listed and left alone.
// It needs DATABASE_URL and SWARM_WORKSPACES_REQUIRED, set to '1' or '0' as the server has it: it decides which Swarms a
// person may reach, and read unset it would pass a Swarm the server refuses (security review 1 of #3146), so it must be said.
// Billing is off here (it moves no plan or payment), so billing's credential key is not needed. It exits once it has printed.
//   cd backend && DATABASE_URL="$(read-only URL from its environment file)" SWARM_WORKSPACES_REQUIRED=<as the server> npx tsx scripts/swarm-computer-moves/run.ts
// `--write` is a production write: run it only in the backend release Ken says go for, with the release's own login.
//   cd backend && npx tsx scripts/swarm-computer-moves/run.ts --write
// Safe to run twice: an entry moved is gone. It prints JSON only, machine and account ids and refusal codes, never an email or
// a name. What it moved can be added back by its owner (Add machine).
/** Written in full before the exit below: a pipe's writes are asynchronous, and an exit drops what is still queued. */
const print = (stream: NodeJS.WriteStream, text: string) => new Promise<void>((resolve, reject) => stream.write(`${text}\n`, e => e ? reject(e) : resolve()))
if (process.env.SWARM_WORKSPACES_REQUIRED !== '0' && process.env.SWARM_WORKSPACES_REQUIRED !== '1') {
  await print(process.stderr, 'Set SWARM_WORKSPACES_REQUIRED to 1 or 0, as the server has it: it decides which Swarms a person may reach.')
  process.exit(1)
}
process.env.HARNESS_BILLING_ENABLED ??= 'false'
const [{ PrismaClient }, { SuperTabStore }, { cleanUpComputers }] = await Promise.all([
  import('@prisma/client'), import('../../src/superTabs/store.js'), import('../../src/superTabs/computerMoves.js'),
])

const write = process.argv.includes('--write')
const env = process.argv.find(arg => arg.startsWith('--env='))?.slice('--env='.length) ?? 'prod'
const db = new PrismaClient()
try {
  const result = await cleanUpComputers(db, new SuperTabStore(db), env, { write })
  await print(process.stdout, JSON.stringify({ write, env, ...result }, null, 2))
} catch (error) {
  // Its code and first line only: a database error carries its query, and this prints ids and codes alone.
  const code = typeof (error as { code?: unknown }).code === 'string' ? `${(error as { code: string }).code}: ` : ''
  await print(process.stderr, `The cleanup failed: ${code}${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`).catch(() => {})
  process.exitCode = 1
} finally {
  await db.$disconnect().catch(() => {})
  // The store's modules open the bus's Redis clients on import (lib/bus.ts), which reconnect for ever and whose quit waits for
  // a connection that may never come: the script ends here, once it has printed, instead of on them.
  process.exit()
}
