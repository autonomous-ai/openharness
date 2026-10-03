import { config } from 'dotenv'
import { resolve } from 'node:path'

// Harness is started from users' projects. Their .env belongs to the project, not to the daemon:
// reading it can move this machine to a different backend, account store or encryption identity.
// Dev and release builds use the same defaults. An isolated backend is always an explicit choice.
const file = process.env.HARNESS_ENV_FILE?.trim() || process.env.DOTENV_CONFIG_PATH?.trim()
if (file) {
  const path = resolve(file)
  const result = config({ path, quiet: true, override: false })
  if (result.error) throw new Error(`Cannot read Harness environment file: ${path}`, { cause: result.error })
}
