import { getUser } from '../users/index.js'

export async function welcomeMail(id) {
  const user = await getUser(id)
  return { to: user.email, subject: `Welcome, ${user.name}` }
}
