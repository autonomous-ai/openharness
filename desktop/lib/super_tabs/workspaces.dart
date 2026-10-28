import 'package:flutter/foundation.dart';

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

/// The person's Workspaces and the invitations waiting for them, for the
/// Workspace menu at the top of the Swarm sidebar. Read when the menu is
/// built or opened and after each change made here, not polled: a Workspace
/// changes rarely, and the next open shows what changed meanwhile. One per
/// [SuperTabClient]; nothing read for one account is shown to the next.
class SwarmWorkspaces extends ChangeNotifier {
  SwarmWorkspaces(this.client) : api = SwarmWorkspacesApi(client);

  static final _all = Expando<SwarmWorkspaces>();
  static SwarmWorkspaces of(SuperTabClient client) =>
      _all[client] ??= SwarmWorkspaces(client);

  final SuperTabClient client;
  final SwarmWorkspacesApi api;
  String? _readFor;
  List<SwarmWorkspace>? _workspaces;
  List<SwarmWorkspaceInvitation> _invitations = const [];
  String? _error;
  Future<void>? _reading;

  bool get _current => _readFor != null && _readFor == client.account;

  /// Null until read, and from a backend without Workspaces.
  List<SwarmWorkspace>? get workspaces => _current ? _workspaces : null;
  List<SwarmWorkspaceInvitation> get invitations =>
      _current ? _invitations : const [];

  /// Why the last read failed; the last list read stays shown.
  String? get error => _current ? _error : null;

  /// Owners and admins always see the menu, to manage people; anyone with
  /// several Workspaces or an invitation waiting, to switch or accept. A
  /// member or guest of one Workspace sees the sidebar as before Workspaces.
  bool get showsMenu {
    final all = workspaces;
    if (all == null || all.isEmpty) return false;
    return all.length > 1 ||
        invitations.isNotEmpty ||
        all.any((w) => w.role.managesPeople);
  }

  /// The Workspace holding the Swarm [tabId]; for one no Workspace lists, the
  /// first the person manages, else their first.
  SwarmWorkspace? current(String tabId) {
    final all = workspaces;
    if (all == null || all.isEmpty) return null;
    return all.where((w) => w.swarms.any((s) => s.id == tabId)).firstOrNull ??
        all.where((w) => w.role.managesPeople).firstOrNull ??
        all.first;
  }

  /// The Swarm on screen, as the Workspace menu last saw it: a new Swarm
  /// goes to its Workspace (docs/plans/2026-10-27-swarm-workspaces.md: Cmd-S
  /// creates the new Swarm in the current Workspace).
  String? shownTabId;
  String? _chosenForNewSwarm;

  /// Workspaces the person may create a Swarm in.
  List<SwarmWorkspace> get swarmHomes => [
    for (final w in workspaces ?? const <SwarmWorkspace>[])
      if (w.role.createsSwarms) w,
  ];

  /// The next new Swarm goes to [workspaceId] ("New Swarm in …").
  void chooseForNewSwarm(String workspaceId) =>
      _chosenForNewSwarm = workspaceId;

  /// Where a new Swarm is created: the Workspace chosen for it (used once),
  /// else the current one, else the first the person may create Swarms in.
  /// Null when the backend has no Workspaces: it then creates the Swarm in
  /// the person's own Workspace, as before.
  String? takeNewSwarmWorkspace() {
    final chosen = _chosenForNewSwarm;
    _chosenForNewSwarm = null;
    final homes = swarmHomes;
    if (homes.isEmpty) return null;
    final shown = shownTabId == null ? null : current(shownTabId!);
    return homes.where((w) => w.id == chosen).firstOrNull?.id ??
        homes.where((w) => w.id == shown?.id).firstOrNull?.id ??
        homes.first.id;
  }

  Future<void> refresh() =>
      _reading ??= _read().whenComplete(() => _reading = null);

  Future<void> _read() async {
    final account = client.account;
    if (account == null) return;
    try {
      final workspaces = await api.list();
      final invitations = workspaces == null
          ? const <SwarmWorkspaceInvitation>[]
          : await api.invitationsForMe();
      if (client.account != account) return;
      _readFor = account;
      _workspaces = workspaces;
      _invitations = invitations;
      _error = null;
    } on SuperTabFailure catch (failure) {
      _failed(account, failure.message);
    } on FormatException {
      _failed(account, _unreadable);
    } on TypeError {
      // A row of the wrong shape, from a backend this client does not know.
      _failed(account, _unreadable);
    }
    notifyListeners();
  }

  static const _unreadable = 'Workspaces could not be read.';

  /// Keeps the last list read for [account], and says why this read failed.
  void _failed(String account, String message) {
    if (client.account != account) return;
    if (_readFor != account) {
      _readFor = account;
      _workspaces = null;
      _invitations = const [];
    }
    _error = message;
  }
}
