import 'dart:convert';

import '../core/local_key_value_store.dart';
import '../core/models.dart';

/// The last profile of the account signed in here, so the app opens as them with no wait (task #2169). It is kept with the
/// machine id it was read under, and read only under that id: a machine row has one owner, and a new sign-in's session has no
/// machine id until its own is resolved, so a match proves the same account with no network. The server's answer always
/// replaces it. Anything unreadable reads as none, which is the wait there was before.
class ProfileCache {
  ProfileCache(this._storage);

  final LocalKeyValueStore? _storage;
  static const key = 'signed_in_profile_v1';

  Future<CurrentUserProfile?> read(String machineId) async {
    final kept = await readKept();
    return kept == null || kept.machineId != machineId ? null : kept.profile;
  }

  /// The record with the machine id it was proven under, before the CLI has named one: what a launch opens as while
  /// `harness auth status` still runs (task #3561). Only that answer proves it, as [read] does.
  Future<({String machineId, CurrentUserProfile profile})?> readKept() async {
    final storage = _storage;
    if (storage == null) return null;
    try {
      final stored = await storage.read(key);
      if (stored == null) return null;
      final value = jsonDecode(stored);
      if (value is! Map) return null;
      final (machineId, id, email, name, avatar) = (
        value['machineId'],
        value['id'],
        value['email'],
        value['name'],
        value['avatarUrl'],
      );
      if (machineId is! String || machineId.isEmpty) return null;
      if (id is! String || id.isEmpty || email is! String || email.isEmpty) {
        return null;
      }
      if (name is! String? || avatar is! String?) return null;
      return (
        machineId: machineId,
        profile: CurrentUserProfile(
          id: id,
          email: email,
          name: name,
          avatarUrl: avatar,
        ),
      );
    } catch (_) {
      return null;
    }
  }

  /// One at a time, in the order asked: a sign-out's clear never lands before a write already on its way.
  Future<void> _last = Future.value();
  Future<void> _inOrder(Future<void> Function() step) =>
      _last = _last.then((_) => step());

  Future<void> write(String machineId, CurrentUserProfile profile) =>
      _inOrder(() async {
        final id = profile.id;
        if (id == null || id.isEmpty) return;
        try {
          await _storage?.write(
            key,
            jsonEncode({
              'machineId': machineId,
              'id': id,
              'email': profile.email,
              'name': profile.name,
              'avatarUrl': profile.avatarUrl,
            }),
          );
        } catch (_) {
          /* Only the next open's wait depends on it. */
        }
      });

  Future<void> clear() => _inOrder(() async {
    try {
      await _storage?.delete(key);
    } catch (_) {
      /* A record left behind is read only under its own machine id, or by [readKept] for a launch that waits for the CLI
         to name that id before it trusts it, and that never opens from it twice (task #3561). */
    }
  });
}
