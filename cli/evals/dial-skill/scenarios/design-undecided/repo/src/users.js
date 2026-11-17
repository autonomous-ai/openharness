import { findUserById, saveUser } from './db.js'

// Runs on every authenticated request (src/auth.js), so it is our hottest query.
export async function getUser(id) {
  const user = await findUserById(id)
  if (!user) throw new Error(`user ${id} not found`)
  return user
}

export async function updateUser(id, changes) {
  const user = { ...(await getUser(id)), ...changes, id }
  await saveUser(user)
  return user
}
