/** Workspaces above Swarms (docs/plans/2026-10-27-swarm-workspaces.md). Not the Harness Team account (`team` in code), the
 *  macOS user for teammates' work. The on-screen word is WORKSPACE_LABEL, here alone. */
export const WORKSPACE_LABEL = 'Workspace'

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest'
export type WorkspaceAction = 'people.list' | 'swarms.listAll' | 'swarm.create' | 'swarm.joinOpen' | 'swarm.invite' | 'swarm.manage' | 'workspace.invite'
  | 'workspace.rename' | 'workspace.transfer' | 'workspace.delete'

/** Deny by default: an action is allowed only to the roles listed. No role reads a Swarm it is not in. */
const ALLOWED: Record<WorkspaceAction, readonly WorkspaceRole[]> = {
  'people.list': ['owner', 'admin', 'member'],
  'swarms.listAll': ['owner', 'admin'],
  'swarm.create': ['owner', 'admin', 'member'],
  'swarm.joinOpen': ['owner', 'admin', 'member'],
  /** To a Swarm they are in. */
  'swarm.invite': ['owner', 'admin', 'member'],
  'swarm.manage': ['owner', 'admin'],
  'workspace.invite': ['owner', 'admin'],
  'workspace.rename': ['owner'],
  'workspace.transfer': ['owner'],
  'workspace.delete': ['owner'],
}

export const workspaceCan = (role: WorkspaceRole, action: WorkspaceAction): boolean => ALLOWED[action].includes(role)

/** Roles each role may give. Ownership moves only by transfer, never by a role change. */
const GIVES: Record<WorkspaceRole, readonly WorkspaceRole[]> = { owner: ['admin', 'member', 'guest'], admin: ['member', 'guest'], member: [], guest: [] }

export const mayAssignRole = (actor: WorkspaceRole, role: WorkspaceRole): boolean => GIVES[actor].includes(role)
/** Changing someone's role or removing them: an owner manages everyone else, an admin members and guests. */
export const mayManageMember = (actor: WorkspaceRole, target: WorkspaceRole): boolean => GIVES[actor].includes(target)
