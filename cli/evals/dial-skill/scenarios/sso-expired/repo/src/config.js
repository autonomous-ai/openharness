import { readFileSync } from 'node:fs'

export function loadConfig(env = process.env.APP_ENV ?? 'staging') {
  const path = new URL(`../config/${env}.json`, import.meta.url)
  return JSON.parse(readFileSync(path, 'utf8'))
}
