import { getUser } from './users.js'

const sessions = new Map([
  ['s-ada', 'u1'],
  ['s-bo', 'u2'],
])

export async function authenticate(request) {
  const userId = sessions.get(request.headers['x-session'])
  if (!userId) return null
  const user = await getUser(userId)
  return { user, isAdmin: user.role === 'admin' }
}
