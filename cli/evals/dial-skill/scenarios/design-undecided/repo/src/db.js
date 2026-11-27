import { readFileSync } from 'node:fs'

export const config = JSON.parse(readFileSync(new URL('../config/database.json', import.meta.url), 'utf8'))

const users = new Map([
  ['u1', { id: 'u1', name: 'Ada Park', email: 'ada@example.invalid', plan: 'team', role: 'admin' }],
  ['u2', { id: 'u2', name: 'Bo Lindqvist', email: 'bo@example.invalid', plan: 'free', role: 'member' }],
])

let queries = 0

export function queryCount() {
  return queries
}

// Dev and test stand-in for the Postgres pool at config.host: the same rows, and the round trip a real query costs.
async function roundTrip() {
  queries++
  await new Promise((resolve) => setTimeout(resolve, 20))
}

export async function findUserById(id) {
  await roundTrip()
  return users.get(id) ?? null
}

export async function saveUser(user) {
  await roundTrip()
  users.set(user.id, user)
}
