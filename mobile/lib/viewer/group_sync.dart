import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import '../e2ee/bytes.dart';
import '../e2ee/envelope.dart';
import '../e2ee/relay_session_crypto.dart';
import 'password_link.dart' show RelaySocketFactory, defaultRelaySocket;
import 'viewer_key_store.dart';

/// The trust group, on a device with no harness CLI — the viewer's half of `cli/src/lib/e2ee/
/// trustGroup.ts` and `groupSyncer.ts`.
///
/// Every machine and phone of an account that has linked, directly or through another member, trusts
/// every other. Any session this phone opens to a machine is a chance to swap rosters with it
/// (`group_sync`, sealed): the phone learns every machine's key and pins it — no password for those —
/// and the machine learns the phone and every machine the phone linked, and passes them on.
///
/// By product decision this favours ease over strictness: what an authenticated peer sends is taken
/// as-is. The relay still cannot add anyone, since rosters only cross sealed sessions.

/// A device's entry for ITSELF is stamped older than anything, so any removal beats it — see
/// groupSyncer.ts `SELF_STAMP`.
const int groupSelfStamp = 1;
const int _maxMembers = 256;
const int _maxTombstones = 256;
const Duration _maxClockSkew = Duration(hours: 24);
final RegExp _machineIdPattern = RegExp(r'^[a-f0-9]{32}$');

class GroupMember {
  const GroupMember({
    required this.pub,
    required this.kind,
    required this.label,
    required this.at,
    this.machineId,
  });

  final String pub;
  final String kind; // 'machine' | 'viewer'
  final String label;
  final int at;
  final String? machineId;

  bool get isMachine => kind == 'machine';

  /// Null for anything malformed — the same rule as trustGroup.ts `parseMember`.
  static GroupMember? tryParse(Object? raw, {DateTime? now}) {
    if (raw is! Map) return null;
    final pub = raw['pub'], at = raw['at'], kind = raw['kind'];
    if (!_isPub(pub) || !_isStamp(at, now ?? DateTime.now())) return null;
    if (kind != 'machine' && kind != 'viewer') return null;
    final id = raw['machineId'];
    final machineId = id is String && _machineIdPattern.hasMatch(id)
        ? id
        : null;
    if (kind == 'machine' && machineId == null) return null;
    return GroupMember(
      pub: pub as String,
      kind: kind as String,
      label: _cleanLabel(raw['label']) ?? machineId ?? 'device',
      at: at as int,
      machineId: kind == 'machine' ? machineId : null,
    );
  }

  Map<String, Object> toJson() => {
    'pub': pub,
    'kind': kind,
    'label': label,
    'at': at,
    'machineId': ?machineId,
  };

  bool sameAs(GroupMember o) =>
      pub == o.pub &&
      kind == o.kind &&
      label == o.label &&
      at == o.at &&
      machineId == o.machineId;
}

class GroupTombstone {
  const GroupTombstone(this.pub, this.at);
  final String pub;
  final int at;

  static GroupTombstone? tryParse(Object? raw, {DateTime? now}) {
    if (raw is! Map) return null;
    final pub = raw['pub'], at = raw['at'];
    if (!_isPub(pub) || !_isStamp(at, now ?? DateTime.now())) return null;
    return GroupTombstone(pub as String, at as int);
  }

  Map<String, Object> toJson() => {'pub': pub, 'at': at};
}

class GroupRoster {
  const GroupRoster(this.members, this.removed);
  static const empty = GroupRoster([], []);

  final List<GroupMember> members;
  final List<GroupTombstone> removed;

  static GroupRoster parse(Object? raw, {DateTime? now}) {
    if (raw is! Map) return empty;
    final members = raw['members'], removed = raw['removed'];
    return GroupRoster(
      members is List
          ? members
                .take(_maxMembers)
                .map((m) => GroupMember.tryParse(m, now: now))
                .whereType<GroupMember>()
                .toList()
          : const [],
      removed is List
          ? removed
                .take(_maxTombstones)
                .map((t) => GroupTombstone.tryParse(t, now: now))
                .whereType<GroupTombstone>()
                .toList()
          : const [],
    );
  }

  Map<String, Object> toJson() => {
    'members': [for (final m in members) m.toJson()],
    'removed': [for (final t in removed) t.toJson()],
  };
}

class GroupMerge {
  const GroupMerge(this.roster, this.upserted, this.dropped);
  final GroupRoster roster;
  final List<GroupMember> upserted;
  final List<GroupMember> dropped;
}

/// trustGroup.ts `mergeRoster`, line for line: the newest entry for a key wins, a tombstone beats
/// every entry it is not older than, and a device never takes itself in.
GroupMerge mergeGroupRoster(
  GroupRoster local,
  GroupRoster incoming,
  String selfPub,
) {
  final tombs = <String, int>{};
  for (final t in [...local.removed, ...incoming.removed]) {
    if (t.pub == selfPub) continue;
    final prev = tombs[t.pub];
    tombs[t.pub] = prev == null || t.at > prev ? t.at : prev;
  }
  final members = <String, GroupMember>{
    for (final m in local.members)
      if (m.pub != selfPub) m.pub: m,
  };
  final before = Map.of(members);
  for (final m in incoming.members) {
    if (m.pub == selfPub) continue;
    final existing = members[m.pub];
    if (existing == null || m.at > existing.at) members[m.pub] = m;
  }
  final dropped = <GroupMember>[];
  for (final pub in [...members.keys]) {
    final tomb = tombs[pub];
    if (tomb != null && tomb >= members[pub]!.at) {
      members.remove(pub);
      if (before[pub] case final prev?) dropped.add(prev);
    }
  }
  final removed = [
    for (final e in tombs.entries) GroupTombstone(e.key, e.value),
  ]..sort((a, b) => b.at.compareTo(a.at));
  final kept = members.values.toList()..sort((a, b) => b.at.compareTo(a.at));
  final roster = GroupRoster(
    kept.take(_maxMembers).toList(),
    removed.take(_maxTombstones).toList(),
  );
  final upserted = [
    for (final m in roster.members)
      if (before[m.pub] == null || !before[m.pub]!.sameAs(m)) m,
  ];
  return GroupMerge(roster, upserted, dropped);
}

/// One roster swap with a machine, as the app calls it — `DirectLink.syncGroup`.
typedef GroupSync = Future<GroupSyncOutcome> Function(
  String machineId, {
  required String label,
});

/// What one exchange changed on this phone.
class GroupSyncOutcome {
  const GroupSyncOutcome({this.pinned = const [], this.unpinned = const []});
  static const none = GroupSyncOutcome();

  /// Machines this phone can now reach without their password.
  final List<String> pinned;

  /// Machines the group removed; this phone no longer dials them.
  final List<String> unpinned;

  bool get changed => pinned.isNotEmpty || unpinned.isNotEmpty;
}

/// Swaps rosters with one machine over a short-lived sealed session of its own, then pins what it
/// learned. Never throws: a machine that is offline, too old to answer or refuses leaves everything
/// as it was.
Future<GroupSyncOutcome> syncTrustGroup({
  required String machineId,
  required ViewerKeyStore keys,
  required String accessToken,
  required String wsBaseUrl,
  required String autonomousEnv,
  required String label,
  RelaySocketFactory socket = defaultRelaySocket,
  Duration timeout = const Duration(seconds: 20),
  Map<String, Object?>? devlog,
  Future<void> Function(String machinePub, Object? devlog)? onDevlog,
}) async {
  WebSocketChannel? channel;
  try {
    final pin = await keys.peer(machineId);
    if (pin == null) return GroupSyncOutcome.none;
    final identity = await keys.identity();
    final selfPub = b64e(identity.pub);
    final local = await _seeded(keys, selfPub);
    final self = GroupMember(
      pub: selfPub,
      kind: 'viewer',
      label: label,
      at: groupSelfStamp,
    );
    final crypto = await RelaySessionCrypto.start(
      machineId: machineId,
      identity: identity,
      peerPub: pin.pub,
    );
    final uri = Uri.parse('$wsBaseUrl/api/web-ws')
        .replace(queryParameters: {'autonomousEnv': autonomousEnv});
    final ch = channel = socket(uri, [accessToken]);
    final reply = await () async {
      await ch.ready;
      return _exchange(ch, crypto, machineId, {
        'requestId': b64e(secureRandomBytes(12)),
        'self': self.toJson(),
        ...local.toJson(),
        // The device key log's head (device_log_sync.dart): the machine answers with its own.
        'devlog': ?devlog,
      });
    }().timeout(timeout, onTimeout: () => null);
    if (reply == null || reply['error'] != null) return GroupSyncOutcome.none;
    if (reply['devlog'] != null) await onDevlog?.call(b64e(pin.pub), reply['devlog']);

    final incoming = GroupRoster.parse(reply);
    final theirs = GroupMember.tryParse(reply['self']);
    // The machine may describe only itself, as the key this phone dialed and verified.
    final members = [
      ...incoming.members,
      if (theirs != null &&
          theirs.machineId == machineId &&
          theirs.pub == b64e(pin.pub))
        theirs,
    ];
    final merged = mergeGroupRoster(
      local,
      GroupRoster(members, incoming.removed),
      selfPub,
    );
    await keys.writeGroupRoster(merged.roster.toJson());
    return await _apply(keys, merged);
  } catch (_) {
    return GroupSyncOutcome.none;
  } finally {
    if (channel != null) unawaited(channel.sink.close());
  }
}

/// This phone's roster, with every machine it has pinned folded in — how a machine this phone linked
/// by password reaches the rest of the group, and how links made before the group existed join it.
Future<GroupRoster> _seeded(ViewerKeyStore keys, String selfPub) async {
  final stored = GroupRoster.parse(await keys.groupRoster());
  // Only pins the roster does not name yet: a pin's `linkedAt` is when THIS device pinned it (the
  // group's own pins included), and folding that in again would restamp the member as new on every
  // swap and push the change around the whole group.
  final known = {for (final m in stored.members) m.pub};
  final pins = [
    for (final p in await keys.peers())
      if (!known.contains(b64e(p.pub)))
        ?GroupMember.tryParse({
          'pub': b64e(p.pub),
          'machineId': p.machineId,
          'kind': 'machine',
          'label': p.label.isEmpty ? p.machineId : p.label,
          'at': p.linkedAt.millisecondsSinceEpoch,
        }),
  ];
  return mergeGroupRoster(stored, GroupRoster(pins, const []), selfPub).roster;
}

Future<GroupSyncOutcome> _apply(ViewerKeyStore keys, GroupMerge merged) async {
  final pinned = <String>[], unpinned = <String>[];
  for (final m in merged.upserted) {
    final id = m.machineId;
    if (!m.isMachine || id == null) continue;
    final current = await keys.peer(id);
    if (current != null && b64e(current.pub) == m.pub) continue;
    await keys.pin(id, b64d(m.pub), label: m.label);
    pinned.add(id);
  }
  for (final m in merged.dropped) {
    final id = m.machineId;
    if (id == null) continue;
    final current = await keys.peer(id);
    if (current == null || b64e(current.pub) != m.pub) continue;
    if (await keys.unlink(id)) unpinned.add(id);
  }
  return GroupSyncOutcome(pinned: pinned, unpinned: unpinned);
}

/// select → hello/welcome → one sealed `group_sync` → its sealed `_result`.
Future<Map<String, dynamic>?> _exchange(
  WebSocketChannel channel,
  RelaySessionCrypto crypto,
  String machineId,
  Map<String, Object?> request,
) async {
  void send(Map<String, dynamic> frame) => channel.sink.add(jsonEncode(frame));
  send({
    'type': 'machine_select',
    'payload': {'machineId': machineId},
  });
  var selected = false;
  await for (final raw in channel.stream) {
    final frame = raw is String ? jsonObjectOf(utf8Bytes(raw)) : null;
    if (frame == null) continue;
    final type = frame['type'];
    final payload = frame['payload'];
    if (!selected) {
      if (type == 'connected' &&
          payload is Map &&
          payload['machineId'] == machineId) {
        selected = true;
        send(crypto.helloFrame());
      } else if (type == 'machine_select_error') {
        return null;
      }
      continue;
    }
    if (type == 'e2e_denied') return null;
    if (type == 'e2e_welcome' && payload is Map<String, dynamic>) {
      if (!await crypto.handleWelcome(payload)) return null;
      send(crypto.wrapOutgoing({'type': 'group_sync', 'payload': request}));
      continue;
    }
    if (type == 'group_sync_result') {
      final opened = crypto.unwrapIncoming(frame);
      final body = opened?['payload'];
      if (body is Map<String, dynamic> &&
          body['requestId'] == request['requestId']) {
        return body;
      }
    }
  }
  return null;
}

bool _isPub(Object? v) {
  if (v is! String || v.length > 64) return false;
  try {
    return b64d(v).length == 32;
  } on FormatException {
    return false;
  }
}

bool _isStamp(Object? v, DateTime now) =>
    v is int && v > 0 && v <= now.add(_maxClockSkew).millisecondsSinceEpoch;

String? _cleanLabel(Object? v) {
  if (v is! String) return null;
  final label = v
      .replaceAll(RegExp(r'[\u0000-\u001f\u007f]'), ' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  if (label.isEmpty) return null;
  return label.length > 60 ? label.substring(0, 60) : label;
}
