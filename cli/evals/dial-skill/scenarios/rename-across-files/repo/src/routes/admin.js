import { getUser, userIds } from '../users/index.js'

export async function memberList() {
  const users = await Promise.all(userIds().map((id) => getUser(id)))
  return users.map((user) => `${user.name} <${user.email}> ${user.plan}`)
}
