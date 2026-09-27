/**
 * The daemons' server switch (daemons/README.md, "Off switches"). Every deploy ships them dark:
 *
 *   HARNESS_DAEMONS        off unless `true`, `1`, `on` or `yes`. Off, the zoo routes are never registered
 *                          (`/api/zoo` and `/api/zoo/ops` answer the server's ordinary 404), nothing
 *                          publishes `zoo_changed`, and no socket subscribes to it.
 *   HARNESS_DAEMONS_USERS  optional, with the switch on: comma-separated user ids or emails (emails in
 *                          any case). Only those accounts see the zoo; everyone else gets the same 404 as
 *                          if the switch were off. Empty: every account.
 *
 * A client (harnessd, the desktop, the phone, hn) treats a 404 from `GET /api/zoo` as "daemons are off":
 * it hides everything daemon-related and behaves exactly as it did before daemons existed.
 */
export interface DaemonsSwitch {
  on: boolean
  /** Who may see the zoo while on: lower-cased emails and exact user ids. Null: everyone. */
  users: ReadonlySet<string> | null
}

export const DAEMONS_DARK: DaemonsSwitch = { on: false, users: null }
export const DAEMONS_EVERYONE: DaemonsSwitch = { on: true, users: null }

const TRUE = new Set(['true', '1', 'on', 'yes'])

export function parseDaemonsSwitch(flag: string | undefined, users?: string): DaemonsSwitch {
  const on = TRUE.has((flag ?? '').trim().toLowerCase())
  const list = (users ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => s.includes('@') ? s.toLowerCase() : s)
  return { on, users: list.length ? new Set(list) : null }
}

/** Whether this account sees the zoo. */
export function daemonsFor(sw: DaemonsSwitch, user: { sub: string; email?: string | null } | null | undefined): boolean {
  if (!sw.on || !user) return false
  if (!sw.users) return true
  return sw.users.has(user.sub) || (!!user.email && sw.users.has(user.email.toLowerCase()))
}

/** One line for the boot log: what this server does with daemons. Never lists who. */
export function describeDaemonsSwitch(sw: DaemonsSwitch): string {
  if (!sw.on) return 'daemons: off (HARNESS_DAEMONS)'
  return sw.users ? `daemons: on for ${sw.users.size} allowlisted account${sw.users.size === 1 ? '' : 's'}` : 'daemons: on for everyone'
}
