/** Teams above Swarms (docs/plans/2026-10-27-swarm-teams.md). In code a Team is an `org`, so that `team` keeps meaning
 *  the Harness Team account, the macOS user for teammates' work. The on-screen word is ORG_LABEL, here alone. */
export const ORG_LABEL = 'Team'

export type OrgRole = 'owner' | 'admin' | 'member' | 'guest'
export type OrgAction = 'people.list' | 'swarms.listAll' | 'swarm.create' | 'swarm.joinOpen' | 'swarm.invite' | 'swarm.manage' | 'org.invite'
  | 'org.rename' | 'org.transfer' | 'org.delete'

/** Deny by default: an action is allowed only to the roles listed. No role reads a Swarm it is not in. */
const ALLOWED: Record<OrgAction, readonly OrgRole[]> = {
  'people.list': ['owner', 'admin', 'member'],
  'swarms.listAll': ['owner', 'admin'],
  'swarm.create': ['owner', 'admin', 'member'],
  'swarm.joinOpen': ['owner', 'admin', 'member'],
  /** To a Swarm they are in. */
  'swarm.invite': ['owner', 'admin', 'member'],
  'swarm.manage': ['owner', 'admin'],
  'org.invite': ['owner', 'admin'],
  'org.rename': ['owner'],
  'org.transfer': ['owner'],
  'org.delete': ['owner'],
}

export const orgCan = (role: OrgRole, action: OrgAction): boolean => ALLOWED[action].includes(role)

/** Roles each role may give. Ownership moves only by transfer, never by a role change. */
const GIVES: Record<OrgRole, readonly OrgRole[]> = { owner: ['admin', 'member', 'guest'], admin: ['member', 'guest'], member: [], guest: [] }

export const mayAssignRole = (actor: OrgRole, role: OrgRole): boolean => GIVES[actor].includes(role)
/** Changing someone's role or removing them: an owner manages everyone else, an admin members and guests. */
export const mayManageMember = (actor: OrgRole, target: OrgRole): boolean => GIVES[actor].includes(target)
