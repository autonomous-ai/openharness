import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:cryptography/dart.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../core/harness_file_store.dart';
import '../e2ee/bytes.dart';
import 'model.dart';
import 'swarm_reader.dart';

/// One Swarm of the Home kept: its listing and its view.
typedef SwarmHomeEntry = ({String id, String name, SwarmHomeSwarm view});

/// The Keychain item the kept Home is sealed under.
abstract interface class SwarmHomeKey {
  Future<String?> read();
  Future<void> write(String value);
  Future<void> delete();
}

/// [SwarmHomeKey] in the iOS Keychain (Android: Keystore-backed), readable
/// after the first unlock and never carried to another device or a backup.
class KeychainSwarmHomeKey implements SwarmHomeKey {
  const KeychainSwarmHomeKey();

  static const _storage = FlutterSecureStorage(
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.first_unlock_this_device,
    ),
  );
  static const _name = 'swarm_home_key';

  @override
  Future<String?> read() => _storage.read(key: _name);

  @override
  Future<void> write(String value) => _storage.write(key: _name, value: value);

  @override
  Future<void> delete() => _storage.delete(key: _name);
}

/// The last Swarm Home of the signed-in account, kept so a cold start draws
/// it at once and reads after (owner, 2026-10-27). Only what Home draws
/// ([swarmHomeSwarm]), sealed with ChaCha20-Poly1305 under a random key in
/// the Keychain, in [file] beside the app's state. One account's at a time.
///
/// A view that does not open — no key, another account's, a damaged file —
/// is none, and goes: never an error. [clear] takes the key too, so a file
/// left behind opens for nobody.
class SwarmHomeCache {
  SwarmHomeCache({required this.key, required this.file});

  /// The device's: the Keychain, and a file beside the app's state.
  factory SwarmHomeCache.device() => SwarmHomeCache(
    key: const KeychainSwarmHomeKey(),
    file: File('${HarnessFileStore.shared.directory.path}/swarm-home.bin'),
  );

  final SwarmHomeKey key;
  final File file;

  static const _format = 1;
  static const _aead = DartChacha20.poly1305Aead();
  static const _nonceBytes = 12, _macBytes = 16;

  Future<void> _tail = Future.value();

  /// One operation at a time: a clear is never undone by a write before it.
  Future<T> _serial<T>(Future<T> Function() action) {
    final run = _tail.then((_) => action());
    _tail = run.then((_) {}, onError: (Object _) {});
    return run;
  }

  /// [accountId]'s Home as kept, or null: none, or none that opens.
  Future<List<SwarmHomeEntry>?> read(String accountId) => _serial(() async {
    try {
      if (!await file.exists()) return null;
      final secret = await key.read();
      final opened = secret == null
          ? null
          : _open(b64d(secret), await file.readAsBytes());
      final kept = opened == null ? null : _entries(opened, accountId);
      if (kept == null) await _forget();
      return kept;
    } catch (_) {
      await _forget();
      return null;
    }
  });

  /// Keeps [swarms] as [accountId]'s Home. Best effort: a Keychain or disk
  /// that refuses keeps nothing, and says nothing.
  Future<void> write(String accountId, List<SwarmHomeEntry> swarms) =>
      _serial(() async {
        try {
          var secret = await key.read();
          if (secret == null) {
            secret = b64e(secureRandomBytes(32));
            await key.write(secret);
          }
          final clear = utf8.encode(
            jsonEncode({
              'format': _format,
              'account': accountId,
              'swarms': [
                for (final s in swarms)
                  {
                    'id': s.id,
                    'name': s.name,
                    'state': s.view.state,
                    'partners': s.view.partners,
                  },
              ],
            }),
          );
          final nonce = secureRandomBytes(_nonceBytes);
          final box = _aead.encryptSync(
            clear,
            secretKey: SecretKeyData(b64d(secret)),
            nonce: nonce,
          );
          await file.parent.create(recursive: true);
          await File('${file.path}.next')
              .writeAsBytes(box.concatenation(), flush: true);
          await File('${file.path}.next').rename(file.path);
        } catch (_) {
          await _forget();
        }
      });

  /// Nothing kept: no view, and no key it could be opened with.
  Future<void> clear() => _serial(() async {
    await _forget();
    try {
      await key.delete();
    } catch (_) {}
  });

  Future<void> _forget() async {
    for (final path in [file.path, '${file.path}.next']) {
      try {
        await File(path).delete();
      } on FileSystemException {
        // Not there.
      }
    }
  }

  static Map<String, dynamic>? _open(Uint8List secret, Uint8List sealed) {
    if (sealed.length < _nonceBytes + _macBytes) return null;
    try {
      final clear = _aead.decryptSync(
        SecretBox.fromConcatenation(
          sealed,
          nonceLength: _nonceBytes,
          macLength: _macBytes,
        ),
        secretKey: SecretKeyData(secret),
      );
      final json = jsonDecode(utf8.decode(clear));
      return json is Map<String, dynamic> ? json : null;
    } on SecretBoxAuthenticationError {
      return null;
    }
  }

  static List<SwarmHomeEntry>? _entries(
    Map<String, dynamic> kept,
    String accountId,
  ) {
    if (kept['format'] != _format || kept['account'] != accountId) return null;
    return [
      for (final raw in kept['swarms'] as List)
        if (raw case {
          'id': final String id,
          'name': final String name,
          'state': final Map<String, dynamic> state,
          'partners': final Map<String, dynamic> partners,
        })
          (
            id: id,
            name: name,
            view: (
              state: state,
              partners: {
                for (final MapEntry(:key, :value) in partners.entries)
                  if (value is String) key: value,
              },
            ),
          ),
    ];
  }
}

/// What keeps an inbox's Home in its [SwarmHomeCache]: at once when a Swarm
/// was read again from nothing, left the list, or its access ended — what was
/// kept may hold what the person can no longer read. Any other change is kept
/// at most once each [wait], and what is left when Harness goes behind
/// ([flush]), so a busy Swarm costs one write in a while, not one a read. No
/// timer: nothing outlives the screens.
class SwarmHomeKeeper {
  SwarmHomeKeeper(this.cache, this.accountId, {required this.wait});

  final SwarmHomeCache cache;
  final String accountId;
  final Duration wait;

  /// Each Swarm's [SwarmReader.generation] as last kept.
  var _kept = <String, int>{};
  DateTime? _wrote;
  bool _pending = false;

  /// The account's Home as kept, or null.
  Future<List<SwarmHomeEntry>?> restore() => cache.read(accountId);

  /// The Swarms listed now ([swarms]) as their [readers] hold them. Nothing
  /// while all that is held is what was kept, and nothing has left.
  void keep(
    Map<String, SwarmReader> readers,
    List<({String id, String name})> swarms,
  ) {
    final read = readers.entries.any(
      (e) => e.value.generation != (_kept[e.key] ?? 0),
    );
    final left = _kept.keys.any((id) => !readers.containsKey(id));
    if (read || left) return _write(readers, swarms);
    if (readers.values.every((r) => r.generation == 0)) return;
    final last = _wrote;
    if (last == null || DateTime.now().difference(last) >= wait) {
      return _write(readers, swarms);
    }
    _pending = true;
  }

  /// Harness goes behind: a change not kept yet is kept now.
  void flush(
    Map<String, SwarmReader> readers,
    List<({String id, String name})> swarms,
  ) {
    if (_pending) _write(readers, swarms);
  }

  void _write(
    Map<String, SwarmReader> readers,
    List<({String id, String name})> swarms,
  ) {
    _pending = false;
    _wrote = DateTime.now();
    _kept = {for (final e in readers.entries) e.key: e.value.generation};
    unawaited(
      cache.write(accountId, [
        for (final swarm in swarms)
          if (readers[swarm.id] case final reader?
              when !reader.accessRevoked && reader.snapshot != null)
            (
              id: swarm.id,
              name: swarm.name,
              view: swarmHomeSwarm(reader.snapshot!, reader.partners),
            ),
      ]),
    );
  }
}

/// One Swarm as Home last drew it: a state [SuperTabSnapshot.fromJson] reads,
/// thinned to what Home, its drawer and a project's rows draw, and each
/// conversation's partner ([swarmPartners]).
typedef SwarmHomeSwarm = ({
  Map<String, dynamic> state,
  Map<String, String> partners,
});

/// [snapshot] thinned to what Home draws: its projects, its agents by name,
/// engine and status, and each conversation's title, project, people and work
/// status. Nothing a chat holds — no message, brief, check, task, question or
/// email — nor machines, starts or what waits on the person, which come with
/// the next read.
SwarmHomeSwarm swarmHomeSwarm(
  SuperTabSnapshot snapshot,
  Map<String, String> partners,
) => (
  state: {
    'version': 1,
    'id': snapshot.id,
    'name': snapshot.name,
    'ownerId': snapshot.ownerId,
    'paused': snapshot.paused,
    'leadsConversationId': ?snapshot.leadsConversationId,
    'projects': [for (final p in snapshot.projects) _project(p)],
    'people': [
      for (final p in snapshot.people)
        {'id': p.id, 'email': '', 'role': p.role},
    ],
    'agents': [for (final a in snapshot.agents) _agent(a)],
    'conversations': [for (final c in snapshot.conversations) _conversation(c)],
    'machines': const <Object>[],
    'starts': const <Object>[],
    'invitations': const <Object>[],
  },
  partners: {...partners},
);

Map<String, dynamic> _project(SuperTabProject p) => {
  'id': p.id,
  'name': p.name,
  'ownerId': p.ownerId,
  'leadConversationId': p.leadConversationId,
  'visibility': p.isPrivate ? 'private' : 'public',
  'members': [
    for (final id in p.memberIds) {'id': id},
  ],
  'skillMode': p.skillMode,
  'skillSet': p.skillSet,
  'updateMinutes': p.updateMinutes,
};

Map<String, dynamic> _agent(SuperTabAgent a) => {
  'id': a.id,
  'projectId': a.hasProjectId ? a.projectId : null,
  'name': a.name,
  'displayName': ?a.displayName,
  'machineId': a.machineId,
  'harnessId': a.harnessId,
  'contributorId': a.contributorId,
  'machineOwnerId': a.machineOwnerId,
  'role': ?a.role,
  'roleId': ?a.roleId,
  'limitedUntil': ?a.limitedUntil?.toIso8601String(),
  'downSince': ?a.downSince?.toIso8601String(),
  'configuration': {
    for (final key in const ['engine', 'model', 'effort'])
      if (a.configuration[key] case final String value) key: value,
  },
};

Map<String, dynamic> _conversation(SuperTabConversation c) => {
  'id': c.id,
  'projectId': c.projectId,
  'number': ?c.number,
  'title': c.title,
  'leadId': ?c.leadId,
  'agentIds': c.agentIds,
  'archived': c.archived,
  'dormant': c.dormant,
  if (c.audience case final people?)
    'audience': {
      'people': [
        for (final id in people) {'id': id},
      ],
    },
  'brief': '',
  if (c.assignment case final work?)
    'assignment': {
      'id': work['id'],
      'agentId': work['agentId'],
      'status': work['status'],
    },
};
