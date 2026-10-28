import 'client.dart';
import 'controller.dart';
import 'model.dart';

/// A person's role in a Workspace (docs/plans/2026-10-27-swarm-workspaces.md).
/// The backend enforces every role (superTabs/workspaces.ts); these only
/// decide which controls Desktop offers, so a refused one still says why.
enum SwarmWorkspaceRole {
  owner('Owner'),
  admin('Admin'),
  member('Member'),
  guest('Guest');

  const SwarmWorkspaceRole(this.label);
  final String label;

  /// An unknown role from a newer backend reads as the least one.
  static SwarmWorkspaceRole parse(Object? value) => values.firstWhere(
    (role) => role.name == value,
    orElse: () => SwarmWorkspaceRole.guest,
  );

  /// Roles this one may give. Ownership moves only by transfer.
  List<SwarmWorkspaceRole> get gives => switch (this) {
    owner => const [admin, member, guest],
    admin => const [member, guest],
    member || guest => const [],
  };

  /// Changing someone's role or removing them: an owner manages everyone
  /// else, an admin members and guests.
  bool manages(SwarmWorkspaceRole target) => gives.contains(target);

  /// Workspace settings: people, invitations and Swarm visibility.
  bool get managesPeople => this == owner || this == admin;
  bool get renames => this == owner;
  bool get createsSwarms => this != guest;
}

/// A Swarm as a Workspace lists it: the person's own, one open to the
/// Workspace, or, for owners and admins, any (its name only).
class SwarmWorkspaceSwarm {
  SwarmWorkspaceSwarm.fromJson(Map<String, dynamic> row)
    : id = row['id'] as String,
      name = row['name'] as String? ?? '',
      openToWorkspace = row['workspaceVisibility'] == 'workspace',
      member = row['member'] == true;
  final String id, name;
  final bool openToWorkspace;

  /// The person is in it, so it opens; otherwise they may only join or see it.
  final bool member;
}

class SwarmWorkspace {
  SwarmWorkspace.fromJson(Map<String, dynamic> row)
    : id = row['id'] as String,
      name = row['name'] as String? ?? '',
      role = SwarmWorkspaceRole.parse(row['role']),
      revision = (row['revision'] as num?)?.toInt() ?? 0,
      swarms = List.unmodifiable([
        for (final swarm in row['swarms'] as List? ?? const [])
          SwarmWorkspaceSwarm.fromJson(superTabMap(swarm)),
      ]);
  final String id, name;
  final SwarmWorkspaceRole role;
  final int revision;
  final List<SwarmWorkspaceSwarm> swarms;
}

class SwarmWorkspaceMember {
  SwarmWorkspaceMember.fromJson(Map<String, dynamic> row)
    : userId = row['userId'] as String,
      email = row['email'] as String? ?? '',
      role = SwarmWorkspaceRole.parse(row['role']);
  final String userId, email;
  final SwarmWorkspaceRole role;
}

/// An invitation: one the Workspace sent ([workspaceId] and [name] empty), or
/// one waiting for the person.
class SwarmWorkspaceInvitation {
  SwarmWorkspaceInvitation.fromJson(Map<String, dynamic> row)
    : workspaceId = row['workspaceId'] as String? ?? '',
      name = row['name'] as String? ?? '',
      email = row['email'] as String? ?? '',
      role = SwarmWorkspaceRole.parse(row['role']),
      expiresAt = DateTime.fromMillisecondsSinceEpoch(
        (row['expiresAt'] as num?)?.toInt() ?? 0,
      );
  final String workspaceId, name, email;
  final SwarmWorkspaceRole role;
  final DateTime expiresAt;
}

typedef SwarmWorkspacePeople = ({
  List<SwarmWorkspaceMember> members,
  List<SwarmWorkspaceInvitation> invitations,
});

/// The backend's Workspace routes (backend/src/routes/superTabs.ts), through
/// the account's [SuperTabClient], so a late answer cannot cross an account.
class SwarmWorkspacesApi {
  SwarmWorkspacesApi(this.client);
  final SuperTabClient client;

  static const _root = '/api/super-tabs';
  static String _workspace(String id) =>
      '$_root/workspaces/${Uri.encodeComponent(id)}';
  static String _swarm(String id) => '$_root/${Uri.encodeComponent(id)}';

  List<T> _rows<T>(
    Map<String, dynamic> answer,
    String key,
    T Function(Map<String, dynamic>) read,
  ) => List.unmodifiable([
    for (final row in answer[key] as List? ?? const []) read(superTabMap(row)),
  ]);

  /// The person's Workspaces, or null from a backend without them.
  Future<List<SwarmWorkspace>?> list() async {
    try {
      return _rows(
        await client.map('GET', '$_root/workspaces'),
        'workspaces',
        SwarmWorkspace.fromJson,
      );
    } on SuperTabFailure catch (failure) {
      if (failure.statusCode == 404) return null;
      rethrow;
    }
  }

  Future<List<SwarmWorkspaceInvitation>> invitationsForMe() async => _rows(
    await client.map('GET', '$_root/workspace-invitations'),
    'invitations',
    SwarmWorkspaceInvitation.fromJson,
  );

  Future<SwarmWorkspacePeople> members(String workspaceId) async {
    final answer = await client.map(
      'GET',
      '${_workspace(workspaceId)}/members',
    );
    return (
      members: _rows(answer, 'members', SwarmWorkspaceMember.fromJson),
      invitations: _rows(
        answer,
        'invitations',
        SwarmWorkspaceInvitation.fromJson,
      ),
    );
  }

  /// The new Workspace's id.
  Future<String> create({
    required String operationId,
    required String name,
  }) async =>
      (await client.map(
            'POST',
            '$_root/workspaces',
            body: {'operationId': operationId, 'name': name},
          ))['id']
          as String? ??
      '';

  Future<void> rename(String workspaceId, String name) =>
      client.request('POST', _workspace(workspaceId), body: {'name': name});

  Future<void> invite(
    String workspaceId, {
    required String email,
    required SwarmWorkspaceRole role,
  }) => client.request(
    'POST',
    '${_workspace(workspaceId)}/invitations',
    body: {'email': email, 'role': role.name},
  );

  Future<void> accept(String workspaceId) => client.request(
    'POST',
    '${_workspace(workspaceId)}/accept',
    body: const {},
  );

  Future<void> setRole(
    String workspaceId,
    String userId,
    SwarmWorkspaceRole role,
  ) => client.request(
    'POST',
    '${_workspace(workspaceId)}/members/${Uri.encodeComponent(userId)}',
    body: {'role': role.name},
  );

  /// How many of the Workspace's Swarms the person is still being removed
  /// from; the backend's sweep finishes them.
  Future<int> remove(String workspaceId, String userId) async =>
      ((await client.map(
                'POST',
                '${_workspace(workspaceId)}/members/${Uri.encodeComponent(userId)}/remove',
                body: const {},
              ))['pending']
              as num?)
          ?.toInt() ??
      0;

  Future<void> transfer(String workspaceId, String userId) => client.request(
    'POST',
    '${_workspace(workspaceId)}/transfer',
    body: {'userId': userId},
  );

  Future<void> setSwarmOpenToWorkspace(String tabId, {required bool open}) =>
      client.request(
        'POST',
        '${_swarm(tabId)}/workspace-visibility',
        body: {'visibility': open ? 'workspace' : 'invite-only'},
      );

  /// Joins a Swarm open to the Workspace, as a collaborator.
  Future<void> join(String tabId, {required String operationId}) =>
      client.request(
        'POST',
        '${_swarm(tabId)}/workspace-join',
        body: {'operationId': operationId},
      );
}
