import 'dart:convert';

import '../core/local_key_value_store.dart';

/// The account a Swarm key in the client's storage belongs to, or null for a
/// key that is no account's. What the web keeps of an account beside its
/// saved views (docs/specs/2026-10-30-web-swarm-direct.md, Caching):
/// - `super_tab.<account>.<swarm>`: unsent drafts, selection, what is open;
/// - `super_tab.launch.<account>.<tab>.<conversation>`: an unsent New Harness
///   or New Project;
/// - `super_tab.hidden.<account>`: the Swarms hidden on this browser;
/// - `super_tab.personal.<account>`: the Swarm last chosen in the switcher.
/// The saved views' own keys (`super_tab.view…`, `super_tab.saved_by`) are
/// [SuperTabSavedViews]', which forgets them itself.
String? swarmKeyAccount(String key) {
  if (!key.startsWith('super_tab.')) return null;
  final parts = key.substring('super_tab.'.length).split('.');
  return switch (parts) {
    ['launch', final account, _, ...] => account,
    ['hidden' || 'personal', final account] => account,
    ['view' || 'views' || 'saved_by' || 'signed_out', ...] => null,
    [final account, _] => account,
    _ => null,
  };
}

/// The accounts signed out on this browser whose keys are swept again at each
/// sign-in or reload: another page of this browser may still have written one
/// of theirs after the sign-out swept them (it reloads, but not at once).
const signedOutAccountsKey = 'super_tab.signed_out';

/// How many signed-out accounts a browser remembers: the oldest goes first.
const maxSignedOutAccounts = 16;

/// Signing out on the web: every key of each account signed out on this
/// browser goes, [leaving] (the account signing out now, if any) with them,
/// and [bound] (the one signed in now) is no longer one of them. Another
/// account's keys stay. Under the browser's lock, so two pages never rewrite
/// the list over each other.
Future<void> forgetSwarmAccounts(
  LocalKeyValueStore storage, {
  required String? bound,
  String? leaving,
}) => storage.synchronized(signedOutAccountsKey, () async {
  final out = await _signedOut(storage);
  if (leaving != null && leaving != bound) {
    out
      ..remove(leaving)
      ..add(leaving);
  }
  if (bound != null) out.remove(bound);
  while (out.length > maxSignedOutAccounts) {
    out.removeAt(0);
  }
  if (out.isNotEmpty && storage is KeyListingLocalKeyValueStore) {
    for (final key in await storage.keys()) {
      if (out.contains(swarmKeyAccount(key))) await storage.delete(key);
    }
  }
  if (out.isEmpty) {
    await storage.delete(signedOutAccountsKey);
  } else {
    await storage.write(signedOutAccountsKey, jsonEncode(out));
  }
});

Future<List<String>> _signedOut(LocalKeyValueStore storage) async {
  try {
    final raw = await storage.read(signedOutAccountsKey);
    if (raw == null) return [];
    return (jsonDecode(raw) as List).whereType<String>().toList();
  } catch (_) {
    return [];
  }
}

/// The client's storage on the web: a write for an account that is not the
/// one signed in on this page is dropped, so a draft, a hidden Swarm, a
/// launch or a switcher pick saved after sign-out (a timer, a flush, a reply
/// landing late) writes nothing. Reads and deletes go through.
class SwarmAccountStorage
    implements BatchLocalKeyValueStore, SynchronizedLocalKeyValueStore {
  SwarmAccountStorage(this.inner, {required this.writes});

  final LocalKeyValueStore inner;

  /// Whether a key of this account may be written now.
  final bool Function(String account) writes;

  @override
  Future<String?> read(String key) => inner.read(key);

  @override
  Future<Map<String, String?>> readMany(Iterable<String> keys) =>
      inner.readMany(keys);

  @override
  Future<void> write(String key, String value) {
    final account = swarmKeyAccount(key);
    if (account != null && !writes(account)) return Future.value();
    return inner.write(key, value);
  }

  @override
  Future<void> delete(String key) => inner.delete(key);

  @override
  Future<T> synchronized<T>(String scope, Future<T> Function() action) =>
      inner.synchronized(scope, action);
}
