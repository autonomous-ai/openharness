/**
 * `npm run connectors:import <config-connector-auth.json>`: write the connector gateway's OAuth apps
 * into MongoDB (`connector_apps`), with the backend's DATABASE_URL. Only the `auth_type: app` entries are
 * written; others sign in from the computer. A convenience: the rows can as well be edited in Compass.
 * Prints the codes written, never a secret.
 */
import { readFileSync } from 'fs'
import { importApps } from './lib/connectorGateway.js'
import { prisma } from './lib/prisma.js'

const file = process.argv[2]
if (!file) {
  console.error('Usage: npm run connectors:import <config-connector-auth.json>')
  process.exit(2)
}
try {
  const codes = await importApps(readFileSync(file, 'utf8'))
  console.log(`connector apps written: ${codes.join(', ') || 'none (no auth_type: app entry)'}`)
} catch (error) {
  console.error(`connector apps not written: ${(error as Error).message}`)
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
