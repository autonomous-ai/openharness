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
    final storage = _storage;
    if (storage == null) return null;
    try {
      final stored = await storage.read(key);
      if (stored == null) return null;
      final value = jsonDecode(stored);
      if (value is! Map || value['machineId'] != machineId) return null;
      final (id, email, name, avatar) = (
        value['id'],
        value['email'],
        value['name'],
        value['avatarUrl'],
      );
      if (id is! String || id.isEmpty || email is! String || email.isEmpty) {
        return null;
      }
      if (name is! String? || avatar is! String?) return null;
      return CurrentUserProfile(
        id: id,
        email: email,
        name: name,
        avatarUrl: avatar,
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
      /* A record left behind is read only under its own machine id. */
    }
  });
}
