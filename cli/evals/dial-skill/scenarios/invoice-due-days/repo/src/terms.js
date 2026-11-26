// Days from an invoice's issue date until it is due, by plan.
const NET_DAYS = {
  starter: 14,
  team: 30,
}

export function netDays(plan) {
  const days = NET_DAYS[plan]
  if (days === undefined) throw new Error(`no payment terms for plan ${plan}`)
  return days
}

export function dueDate(plan, issued) {
  const due = new Date(issued)
  due.setUTCDate(due.getUTCDate() + netDays(plan))
  return due.toISOString().slice(0, 10)
}
