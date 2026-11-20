import { config } from 'dotenv'
import { envFilePath } from './envFields.js'

// Harness is started from users' projects. Their .env belongs to the project, not to the daemon:
// reading it can move this machine to a different backend, account store or encryption identity.
// Dev and release builds use the same defaults. An isolated backend is always an explicit choice.
// A start that becomes the daemon narrows process.env after this ran, and reads the file again
// (docs/plans/2026-11-17-daemon-minimal-env-design.md).
export function loadEnvFile(env: NodeJS.ProcessEnv = process.env): void {
  const path = envFilePath(env)
  if (!path) return
  const result = config({ path, processEnv: env, quiet: true, override: false })
  if (result.error) throw new Error(`Cannot read Harness environment file: ${path}`, { cause: result.error })
}

loadEnvFile()
