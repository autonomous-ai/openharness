/** The desktop owns unread state. The token identifies one occurrence, not one agent or sentence. */
export interface UnreadNotification {
  agentId: string
  machineId: string
  question: boolean
  text: string
  readToken?: string
}

/** Fixed firmware field: never truncate an identity into another valid identity. */
export function notificationReadToken(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,63}$/.test(value) ? value : undefined
}
