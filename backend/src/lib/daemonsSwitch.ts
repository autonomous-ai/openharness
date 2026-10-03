/**
 * Server availability (daemons/README.md, "Off switches"), separate from account opt-in:
 *
 *   HARNESS_DAEMONS        env.ts defaults to `true`; explicit false disables it. Off, zoo routes are never registered
 *                          (`/api/zoo` and `/api/zoo/ops` answer the server's ordinary 404), nothing
 *                          writes the zoo, and no socket subscribes to `zoo_changed`.
 *   HARNESS_DAEMONS_USERS  optional, with the switch on: comma-separated user ids or emails (emails in
 *                          any case). Only those accounts see the zoo; everyone else gets the same 404 as
 *                          if the switch were off. Empty: every account may opt in.
 *   Experimental settings  focus_bar_creature must also be true. Missing choices are off.
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

/** Whether this account may opt in to the zoo. */
export function daemonsFor(sw: DaemonsSwitch, user: { sub: string; email?: string | null } | null | undefined): boolean {
  if (!sw.on || !user) return false
  if (!sw.users) return true
  return sw.users.has(user.sub) || (!!user.email && sw.users.has(user.email.toLowerCase()))
}

/** One line for the boot log: what this server does with daemons. Never lists who. */
export function describeDaemonsSwitch(sw: DaemonsSwitch): string {
  if (!sw.on) return 'daemons: off (HARNESS_DAEMONS)'
  return sw.users ? `daemons: available to ${sw.users.size} allowlisted account${sw.users.size === 1 ? '' : 's'} (account opt-in required)` : 'daemons: available (account opt-in required)'
}
