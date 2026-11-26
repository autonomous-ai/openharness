import { readFileSync } from 'node:fs'

export function loadConfig(env = process.env.APP_ENV ?? 'development') {
  const config = JSON.parse(readFileSync(new URL(`../config/${env}.json`, import.meta.url), 'utf8'))
  // The password never sits in a config file: each environment's comes from its own secret store.
  return { ...config, db: { ...config.db, password: process.env.PGPASSWORD } }
}
