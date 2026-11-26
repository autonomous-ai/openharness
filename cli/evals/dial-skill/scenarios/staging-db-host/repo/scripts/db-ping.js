import { loadConfig } from '../src/config.js'
import { reach } from '../src/db.js'

const env = process.argv[2] ?? 'development'
const { db } = loadConfig(env)
try {
  await reach(db)
  console.log(`db: ${env} answers at ${db.host}:${db.port}`)
} catch (error) {
  console.error(`db: ${env}: ${error.message}`)
  process.exit(1)
}
