import { getUser } from '../users/index.js'

export async function profile(id) {
  const user = await getUser(id)
  return { name: user.name, plan: user.plan }
}
