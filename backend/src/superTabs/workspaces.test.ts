import { describe, expect, it } from 'vitest'
import { mayAssignRole, mayManageMember, workspaceCan, type WorkspaceRole } from './workspaces.js'

const roles: WorkspaceRole[] = ['owner', 'admin', 'member', 'guest']
const allowed = (action: Parameters<typeof workspaceCan>[1]) => roles.filter(role => workspaceCan(role, action))

describe('what each Workspace role may do (design: Roles)', () => {
  it('shows the Workspace people list to members and above, never to guests', () => {
    expect(allowed('people.list')).toEqual(['owner', 'admin', 'member'])
  })

  it('shows every Workspace Swarm name only to owners and admins', () => {
    expect(allowed('swarms.listAll')).toEqual(['owner', 'admin'])
  })

  it('lets members and above create Swarms and join those open to the Workspace', () => {
    expect(allowed('swarm.create')).toEqual(['owner', 'admin', 'member'])
    expect(allowed('swarm.joinOpen')).toEqual(['owner', 'admin', 'member'])
    expect(allowed('swarm.invite')).toEqual(['owner', 'admin', 'member'])
  })

  it('lets only owners and admins invite to the Workspace or manage any Swarm of it', () => {
    expect(allowed('workspace.invite')).toEqual(['owner', 'admin'])
    expect(allowed('swarm.manage')).toEqual(['owner', 'admin'])
  })

  it('keeps renaming, transferring and deleting the Workspace to its owner', () => {
    for (const action of ['workspace.rename', 'workspace.transfer', 'workspace.delete'] as const) expect(allowed(action)).toEqual(['owner'])
  })
})

describe('who may give a role or manage a person', () => {
  it('lets an owner give any role but owner, and an admin only member or guest', () => {
    expect(roles.filter(role => mayAssignRole('owner', role))).toEqual(['admin', 'member', 'guest'])
    expect(roles.filter(role => mayAssignRole('admin', role))).toEqual(['member', 'guest'])
    expect(roles.filter(role => mayAssignRole('member', role))).toEqual([])
    expect(roles.filter(role => mayAssignRole('guest', role))).toEqual([])
  })

  it('lets an owner manage everyone but the owner, and an admin only members and guests', () => {
    expect(roles.filter(role => mayManageMember('owner', role))).toEqual(['admin', 'member', 'guest'])
    expect(roles.filter(role => mayManageMember('admin', role))).toEqual(['member', 'guest'])
    expect(roles.filter(role => mayManageMember('member', role))).toEqual([])
  })
})
