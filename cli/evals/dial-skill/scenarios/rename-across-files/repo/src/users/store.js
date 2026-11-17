const users = new Map([
  ['u1', { id: 'u1', name: 'Ada', email: 'ada@example.invalid', plan: 'pro' }],
  ['u2', { id: 'u2', name: 'Linus', email: 'linus@example.invalid', plan: 'free' }],
])

export async function getUser(id) {
  const user = users.get(id)
  if (!user) throw new Error(`no user ${id}`)
  return { ...user }
}

export function userIds() {
  return [...users.keys()]
}
