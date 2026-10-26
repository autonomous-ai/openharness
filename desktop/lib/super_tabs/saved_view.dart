import 'dart:convert';

import '../core/local_key_value_store.dart';

/// The last view of a Swarm tab as read: the state the tab draws and the open
/// conversation's last page, kept on this device so the next open draws it at
/// once and reads after ([SuperTabReading.drawsSaved]; the web, where that
/// first read is seconds away). One per account and tab, a few per account,
/// none over [maxBytes], and none of what the tab never shows.
class SuperTabSavedViews {
  SuperTabSavedViews(this.storage, {this.maxBytes = 512 * 1024});

  final LocalKeyValueStore storage;
  final int maxBytes;

  /// How many Swarms an account keeps a view of, most recently used first.
  static const maxTabs = 3;

  /// What `SuperTabSnapshot.fromJson` reads: everything else in a state is
  /// never drawn, so it is never kept (agent starts carry their tasks).
  static const _drawn = {
    'version',
    'id',
    'name',
    'ownerId',
    'paused',
    'project',
    'people',
    'agents',
    'machines',
    'conversations',
    'invitations',
    'leadsConversationId',
    'localModels',
    'mentionsWaiting',
    'projects',
  };

  String _key(String account, String tabId) => 'super_tab.view.$account.$tabId';
  String _index(String account) => 'super_tab.views.$account';

  /// The account whose views this device keeps: the one to forget when
  /// another signs in, in this page or after a reload.
  static const _owner = 'super_tab.saved_by';

  Future<void> _tail = Future.value();

  /// One operation at a time here, and across this browser's tabs under its
  /// lock: each one reads and rewrites the account's index.
  Future<T> _serial<T>(Future<T> Function() action) {
    final run = _tail.then(
      (_) => storage.synchronized('super_tab.views', action),
    );
    _tail = run.then((_) {}, onError: (Object _) {});
    return run;
  }

  Future<List<String>> _tabs(String account) async {
    try {
      final raw = await storage.read(_index(account));
      return raw == null
          ? <String>[]
          : (jsonDecode(raw) as List).whereType<String>().toList();
    } on FormatException {
      return <String>[];
    }
  }

  /// Puts [tabId] first in the account's index. Best effort when reading: a
  /// storage that refuses must not fail the open.
  Future<void> _use(String account, String tabId) async {
    final tabs = (await _tabs(account))..remove(tabId);
    tabs.insert(0, tabId);
    for (final gone in tabs.skip(maxTabs)) {
      await storage.delete(_key(account, gone));
    }
    await storage.write(
      _index(account),
      jsonEncode(tabs.take(maxTabs).toList()),
    );
  }

  /// The view saved for [tabId], or null: none, unreadable, another shape,
  /// or a storage that refuses (full, private mode). It never throws.
  Future<Map<String, dynamic>?> read(String account, String tabId) =>
      _serial(() async {
        try {
          final raw = await storage.read(_key(account, tabId));
          if (raw == null) return null;
          final view = jsonDecode(raw);
          if (view is! Map<String, dynamic> ||
              view['state'] is! Map<String, dynamic> ||
              view['revision'] is! int) {
            return null;
          }
          try {
            await _use(account, tabId);
          } catch (_) {}
          return view;
        } catch (_) {
          return null;
        }
      });

  /// Keeps [view] for [tabId]; one over the cap is not kept, and the older
  /// one goes with it rather than staying behind, older still.
  Future<void> write(String account, String tabId, Map<String, dynamic> view) =>
      _serial(() async {
        // Only for the account using this device: after a sign-out in
        // another tab, or another account's claim, a late write keeps nothing.
        if (await storage.read(_owner) != account) return;
        final state = view['state'] as Map<String, dynamic>;
        final text = jsonEncode({
          ...view,
          'state': {
            for (final entry in state.entries)
              if (_drawn.contains(entry.key)) entry.key: entry.value,
          },
        });
        if (_utf8Length(text) > maxBytes) {
          await _forget(account, tabId);
          return;
        }
        await storage.write(_key(account, tabId), text);
        await _use(account, tabId);
      });

  Future<void> forget(String account, String tabId) =>
      _serial(() => _forget(account, tabId));

  Future<void> _forget(String account, String tabId) async {
    await storage.delete(_key(account, tabId));
    final tabs = (await _tabs(account))..remove(tabId);
    await storage.write(_index(account), jsonEncode(tabs));
  }

  /// Signing out, or another account: nothing of this one stays behind.
  Future<void> forgetAccount(String account) =>
      _serial(() => _forgetAccount(account));

  Future<void> _forgetAccount(String account) async {
    for (final tab in await _tabs(account)) {
      await storage.delete(_key(account, tab));
    }
    await storage.delete(_index(account));
  }

  /// [account] (null when signed out) is the one using this device now: the
  /// views of any other account that used it, before a reload too, go.
  Future<void> claim(String? account) => _serial(() async {
    final owner = await storage.read(_owner);
    if (owner == account) return;
    if (owner != null) await _forgetAccount(owner);
    if (account == null) {
      await storage.delete(_owner);
    } else {
      await storage.write(_owner, account);
    }
  });

  /// UTF-8 bytes of [text], without encoding a copy of it to count them.
  static int _utf8Length(String text) {
    var bytes = 0;
    for (final rune in text.runes) {
      bytes += rune < 0x80
          ? 1
          : rune < 0x800
          ? 2
          : rune < 0x10000
          ? 3
          : 4;
    }
    return bytes;
  }
}
