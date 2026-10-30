import 'dart:convert' show utf8;

import 'package:cryptography/dart.dart' show DartSha256;
import 'package:flutter/foundation.dart';

/// Shared tabs as the daemon's `shares` answer describes them. Every parser
/// returns null for a malformed entry and never throws; strings from another
/// account are kept exactly as given (plain text, the views ellipsize).

String? _str(Object? v) => v is String && v.isNotEmpty ? v : null;

/// A member's desk tab id for shared tab [sharedTabId] (R1): the first 32 hex
/// characters of sha256('harness-member-tab' + sharedTabId). Derived, so every
/// computer of the member names the tab the same and nothing is stored; and a
/// desk id in shape (32 lowercase hex, `isDeskId`), so a released desktop on
/// another of the member's computers keeps it. The raw 24-hex shared tab id
/// was not one: such a desktop gave the tab a fresh id at each launch and
/// seeded it back, a duplicate on the desk every time (final review of 1c, I5).
String memberDeskTabId(String sharedTabId) => [
  for (final b
      in const DartSha256()
          .hashSync(utf8.encode('harness-member-tab$sharedTabId'))
          .bytes
          .take(16))
    b.toRadixString(16).padLeft(2, '0'),
].join();

final _sharedTabIdShape = RegExp(r'^[0-9a-f]{24}$');

/// The desk tab an Agent Messages tab id names: the daemons file a member's
/// shared tab under its shared tab id (24 hex, which no desk id is), so that
/// one is the member's derived desk tab; any other is a desk tab id already.
String deskTabIdForMessages(String tabId) =>
    _sharedTabIdShape.hasMatch(tabId) ? memberDeskTabId(tabId) : tabId;

@immutable
class SharedTabHarness {
  const SharedTabHarness({
    required this.accountId,
    required this.machineId,
    required this.agentId,
    required this.name,
    required this.engine,
  });

  final String accountId, machineId, agentId, name, engine;

  String get key => '$machineId\u0000$agentId';

  static SharedTabHarness? fromJson(Object? json) {
    if (json is! Map) return null;
    final accountId = _str(json['accountId']),
        machineId = _str(json['machineId']),
        agentId = _str(json['agentId']);
    if (accountId == null || machineId == null || agentId == null) return null;
    final name = json['name'], engine = json['engine'];
    return SharedTabHarness(
      accountId: accountId,
      machineId: machineId,
      agentId: agentId,
      name: name is String ? name : '',
      engine: engine is String ? engine : '',
    );
  }
}

@immutable
class SharedTabMember {
  const SharedTabMember({
    required this.accountId,
    required this.email,
    required this.name,
  });

  final String accountId, email, name;

  static SharedTabMember? fromJson(Object? json) {
    if (json is! Map) return null;
    final accountId = _str(json['accountId']);
    if (accountId == null) return null;
    final email = json['email'], name = json['name'];
    return SharedTabMember(
      accountId: accountId,
      email: email is String ? email : '',
      name: name is String ? name : '',
    );
  }
}

@immutable
class SharedTab {
  // Not const: a const class cannot hold the late [_memberDeskTabId].
  SharedTab({
    required this.sharedTabId,
    required this.ownerTabId,
    required this.name,
    required this.version,
    required this.ownerAccountId,
    required this.ownerEmail,
    required this.ownerMachineId,
    required this.leader,
    required this.members,
    required this.harnesses,
    required this.invites,
    this.pendingInvites = const [],
  });

  final String sharedTabId;

  /// The desk tab the owner shared; null for a member's roster.
  final String? ownerTabId;
  final String name;
  final int version;
  final String ownerAccountId, ownerEmail, ownerMachineId;
  final ({String machineId, String agentId})? leader;
  final List<SharedTabMember> members;
  final List<SharedTabHarness> harnesses;
  final List<({String email, String expiresAt})> invites;

  /// The owner's pending invitations with the ids that revoke them; empty for
  /// a member, and from a daemon that does not list them.
  final List<({String id, String email, String expiresAt})> pendingInvites;

  bool ownedBy(String accountId) => ownerAccountId == accountId;

  /// A member's desk tab is derived from the shared tab id
  /// ([memberDeskTabId]); the owner's is the tab it shared (null when the
  /// daemon did not say, so it shows in no desk tab).
  String? deskTabId(String myAccountId) =>
      ownedBy(myAccountId) ? ownerTabId : _memberDeskTabId;

  /// Worked out once per tab: [SharedTabsController.tabForDesk] asks every
  /// shared tab for its desk id, for each desk tab, on every native menu
  /// flush — and each answer was a fresh SHA-256 of the shared tab id.
  late final String _memberDeskTabId = memberDeskTabId(sharedTabId);

  static SharedTab? fromJson(Object? json) {
    if (json is! Map) return null;
    final id = _str(json['sharedTabId']);
    final owner = json['owner'];
    if (id == null || owner is! Map) return null;
    final ownerAccount = _str(owner['accountId']);
    final harnesses = json['harnesses'], members = json['members'];
    if (ownerAccount == null || harnesses is! List) return null;
    final invites = json['invites'];
    final leaderJson = json['leader'];
    final leaderMachine = leaderJson is Map
        ? _str(leaderJson['machineId'])
        : null;
    final leaderAgent = leaderJson is Map ? _str(leaderJson['agentId']) : null;
    final name = json['name'],
        version = json['version'],
        ownerEmail = owner['email'];
    final tabId = json['tabId'];
    final pending = json['pendingInvites'];
    return SharedTab(
      pendingInvites: pending is List
          ? [
              for (final i in pending)
                if (i is Map &&
                    _str(i['id']) != null &&
                    _str(i['email']) != null)
                  (
                    id: i['id'] as String,
                    email: i['email'] as String,
                    expiresAt: i['expiresAt'] is String
                        ? i['expiresAt'] as String
                        : '',
                  ),
            ]
          : const [],
      sharedTabId: id,
      ownerTabId: tabId is String && tabId.isNotEmpty ? tabId : null,
      name: name is String ? name : '',
      version: version is int ? version : 0,
      ownerAccountId: ownerAccount,
      ownerEmail: ownerEmail is String ? ownerEmail : '',
      ownerMachineId: _str(owner['machineId']) ?? '',
      leader: leaderMachine != null && leaderAgent != null
          ? (machineId: leaderMachine, agentId: leaderAgent)
          : null,
      members: members is List
          ? members
                .map(SharedTabMember.fromJson)
                .whereType<SharedTabMember>()
                .toList()
          : const [],
      harnesses: harnesses
          .map(SharedTabHarness.fromJson)
          .whereType<SharedTabHarness>()
          .toList(),
      invites: invites is List
          ? [
              for (final i in invites)
                if (i is Map && _str(i['email']) != null)
                  (
                    email: i['email'] as String,
                    expiresAt: i['expiresAt'] is String
                        ? i['expiresAt'] as String
                        : '',
                  ),
            ]
          : const [],
    );
  }
}

@immutable
class SharedTabInvite {
  const SharedTabInvite({
    required this.id,
    required this.sharedTabId,
    required this.ownerEmail,
    required this.ownerMachineId,
    required this.tabName,
    required this.expiresAt,
  });

  final String id, sharedTabId, ownerEmail, ownerMachineId, tabName, expiresAt;

  static SharedTabInvite? fromJson(Object? json) {
    if (json is! Map) return null;
    final id = _str(json['id']), tab = _str(json['sharedTabId']);
    if (id == null || tab == null) return null;
    String s(String k) => json[k] is String ? json[k] as String : '';
    return SharedTabInvite(
      id: id,
      sharedTabId: tab,
      ownerEmail: s('ownerEmail'),
      ownerMachineId: s('ownerMachineId'),
      tabName: s('tabName'),
      expiresAt: s('expiresAt'),
    );
  }
}

@immutable
class SharedTabAlert {
  const SharedTabAlert({
    required this.id,
    required this.sharedTabId,
    required this.code,
    required this.at,
    this.count = 1,
  });

  final String id, sharedTabId, code, at;
  final int count;

  static SharedTabAlert? fromJson(Object? json) {
    if (json is! Map) return null;
    final id = _str(json['id']), tab = _str(json['sharedTabId']);
    if (id == null || tab == null) return null;
    final count = json['count'];
    return SharedTabAlert(
      id: id,
      sharedTabId: tab,
      code: json['error'] is String ? json['error'] as String : '',
      at: json['at'] is String ? json['at'] as String : '',
      count: count is int && count > 0 ? count : 1,
    );
  }
}

@immutable
class SharedTabNotice {
  const SharedTabNotice({
    required this.id,
    required this.sharedTabId,
    required this.kind,
    required this.at,
    this.error,
    this.machineId,
    this.agentId,
    this.ownerEmail,
  });

  final String id, sharedTabId, kind, at;

  /// [ownerEmail] is the tab owner's, carried by `removed` and `relay_taken`
  /// (the roster is gone or unread by the time a window shows them).
  final String? error, machineId, agentId, ownerEmail;

  static SharedTabNotice? fromJson(Object? json) {
    if (json is! Map) return null;
    final id = _str(json['id']),
        tab = _str(json['sharedTabId']),
        kind = _str(json['kind']);
    if (id == null || tab == null || kind == null) return null;
    return SharedTabNotice(
      id: id,
      sharedTabId: tab,
      kind: kind,
      at: json['at'] is String ? json['at'] as String : '',
      error: _str(json['error']),
      machineId: _str(json['machineId']),
      agentId: _str(json['agentId']),
      ownerEmail: _str(json['ownerEmail']),
    );
  }
}

@immutable
class SharedTabPending {
  const SharedTabPending({
    required this.sharedTabId,
    required this.op,
    required this.machineId,
    required this.agentId,
    required this.name,
    required this.since,
  });

  final String sharedTabId, op, machineId, agentId, name, since;

  static SharedTabPending? fromJson(Object? json) {
    if (json is! Map) return null;
    final tab = _str(json['sharedTabId']), op = json['op'];
    final machine = _str(json['machineId']), agent = _str(json['agentId']);
    if (tab == null || machine == null || agent == null) return null;
    if (op != 'add' && op != 'remove') return null;
    return SharedTabPending(
      sharedTabId: tab,
      op: op as String,
      machineId: machine,
      agentId: agent,
      name: json['name'] is String ? json['name'] as String : '',
      since: json['since'] is String ? json['since'] as String : '',
    );
  }
}

@immutable
class SharedActivity {
  const SharedActivity({
    required this.sharedTabId,
    required this.machineId,
    required this.agentId,
    required this.state,
    required this.validForMs,
    this.revision = 0,
  });

  final String sharedTabId, machineId, agentId;

  /// `working`, `idle` or `unknown`.
  final String state;
  final int validForMs;

  /// Grows with every frame the controller hands on, so a listener can order them.
  final int revision;

  SharedActivity withRevision(int revision) => SharedActivity(
    sharedTabId: sharedTabId,
    machineId: machineId,
    agentId: agentId,
    state: state,
    validForMs: validForMs,
    revision: revision,
  );

  static SharedActivity? fromJson(Object? json) {
    if (json is! Map) return null;
    final tab = _str(json['sharedTabId']);
    final machine = _str(json['machineId']), agent = _str(json['agentId']);
    if (tab == null || machine == null || agent == null) return null;
    final state = json['state'], valid = json['validForMs'];
    return SharedActivity(
      sharedTabId: tab,
      machineId: machine,
      agentId: agent,
      state: state == 'working' || state == 'idle'
          ? state as String
          : 'unknown',
      validForMs: valid is num && valid >= 0 ? valid.toInt() : 0,
    );
  }
}

@immutable
class SharedTabMe {
  const SharedTabMe({
    required this.accountId,
    required this.email,
    required this.machineId,
  });

  final String accountId, email, machineId;

  static SharedTabMe? fromJson(Object? json) {
    if (json is! Map) return null;
    final account = _str(json['accountId']);
    if (account == null) return null;
    return SharedTabMe(
      accountId: account,
      email: json['email'] is String ? json['email'] as String : '',
      machineId: json['machineId'] is String ? json['machineId'] as String : '',
    );
  }
}

List<T> _list<T>(Object? v, T? Function(Object?) parse) =>
    v is List ? v.map(parse).whereType<T>().toList() : <T>[];

@immutable
class SharedTabsSnapshot {
  const SharedTabsSnapshot({
    this.me,
    this.tabs = const [],
    this.invites = const [],
    this.alerts = const [],
    this.notices = const [],
    this.pending = const [],
    this.untrusted = const [],
    this.activity = const [],
  });

  final SharedTabMe? me;
  final List<SharedTab> tabs;
  final List<SharedTabInvite> invites;
  final List<SharedTabAlert> alerts;
  final List<SharedTabNotice> notices;
  final List<SharedTabPending> pending;

  /// Tabs whose owner's key changed and awaits a decision.
  final List<({String sharedTabId, String ownerEmail})> untrusted;
  final List<SharedActivity> activity;

  static const empty = SharedTabsSnapshot();

  static SharedTabsSnapshot? fromJson(Object? json) {
    if (json is! Map) return null;
    final untrusted = json['untrusted'];
    // An answer without a readable account is not a `shares` answer: the caller keeps what it knew.
    final me = SharedTabMe.fromJson(json['me']);
    if (me == null) return null;
    return SharedTabsSnapshot(
      me: me,
      tabs: _list(json['rosters'], SharedTab.fromJson),
      invites: _list(json['invites'], SharedTabInvite.fromJson),
      alerts: _list(json['alerts'], SharedTabAlert.fromJson),
      notices: _list(json['notices'], SharedTabNotice.fromJson),
      pending: _list(json['pending'], SharedTabPending.fromJson),
      untrusted: untrusted is List
          ? [
              for (final u in untrusted)
                if (u is Map && _str(u['sharedTabId']) != null)
                  (
                    sharedTabId: u['sharedTabId'] as String,
                    ownerEmail: u['ownerEmail'] is String
                        ? u['ownerEmail'] as String
                        : '',
                  ),
            ]
          : const [],
      activity: _list(json['activity'], SharedActivity.fromJson),
    );
  }

  /// Without the alerts and notices carrying these ids.
  SharedTabsSnapshot without(Set<String> ids) {
    if (ids.isEmpty) return this;
    return SharedTabsSnapshot(
      me: me,
      tabs: tabs,
      invites: invites,
      alerts: alerts.where((a) => !ids.contains(a.id)).toList(),
      notices: notices.where((n) => !ids.contains(n.id)).toList(),
      pending: pending,
      untrusted: untrusted,
      activity: activity,
    );
  }
}
