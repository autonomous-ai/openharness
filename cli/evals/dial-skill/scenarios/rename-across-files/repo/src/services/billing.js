import { getUser } from '../users/index.js'

const MONTHLY_CENTS = { free: 0, pro: 1200 }

export async function invoiceFor(id) {
  const user = await getUser(id)
  return { to: user.email, cents: MONTHLY_CENTS[user.plan] }
}
