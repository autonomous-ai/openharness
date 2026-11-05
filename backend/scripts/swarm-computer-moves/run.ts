// One row per computer (#3122): computers listed in Swarms under two accounts before a sign-in moved them. From this release a
// sign-in moves the computer's entries by itself (superTabs/computerMoves.ts); this moves the ones listed twice already, once.
// Dry run by default: it prints each computer's account seen last and the other accounts' machines, and writes nothing.
// Rows count as one computer by their computer id alone, which is self-declared: a pinned ADAPTER_COMPUTER_ID shared by
// containers under different accounts reads as one computer here. The write moves an entry only where both accounts' logs
// hold the same machine key for it (computerMoves.ts sameComputerKey), so those containers are listed and left alone.
//   cd backend && DATABASE_URL="$(read-only URL from its environment file)" npx tsx scripts/swarm-computer-moves/run.ts
// `--write` is a production write: run it only in the backend release Ken says go for, with the release's own login.
//   cd backend && npx tsx scripts/swarm-computer-moves/run.ts --write
// Safe to run twice: an entry moved is gone. It prints JSON only, machine and account ids, never an email or a name. What it
// moved can be added back by its owner (Add machine).
import { PrismaClient } from '@prisma/client'
import { SuperTabStore } from '../../src/superTabs/store.js'
import { cleanUpComputers } from '../../src/superTabs/computerMoves.js'

const write = process.argv.includes('--write')
const env = process.argv.find(arg => arg.startsWith('--env='))?.slice('--env='.length) ?? 'prod'
const db = new PrismaClient()
try {
  const result = await cleanUpComputers(db, new SuperTabStore(db), env, { write })
  console.log(JSON.stringify({ write, env, ...result }, null, 2))
} finally {
  await db.$disconnect()
}
