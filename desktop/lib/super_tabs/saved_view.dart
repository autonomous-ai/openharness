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

  /// The view saved for [tabId], or null: none, unreadable, or another shape.
  Future<Map<String, dynamic>?> read(String account, String tabId) async {
    final raw = await storage.read(_key(account, tabId));
    if (raw == null) return null;
    try {
      final view = jsonDecode(raw);
      if (view is! Map<String, dynamic> ||
          view['state'] is! Map<String, dynamic> ||
          view['revision'] is! int) {
        return null;
      }
      await _use(account, tabId);
      return view;
    } on FormatException {
      return null;
    }
  }

  /// Keeps [view] for [tabId]; one over the cap is not kept, and the older
  /// one goes with it rather than staying behind, older still.
  Future<void> write(
    String account,
    String tabId,
    Map<String, dynamic> view,
  ) async {
    final state = view['state'] as Map<String, dynamic>;
    final text = jsonEncode({
      ...view,
      'state': {
        for (final entry in state.entries)
          if (_drawn.contains(entry.key)) entry.key: entry.value,
      },
    });
    if (utf8.encode(text).length > maxBytes) {
      await forget(account, tabId);
      return;
    }
    await storage.write(_key(account, tabId), text);
    await _use(account, tabId);
  }

  Future<void> forget(String account, String tabId) async {
    await storage.delete(_key(account, tabId));
    final tabs = (await _tabs(account))..remove(tabId);
    await storage.write(_index(account), jsonEncode(tabs));
  }

  /// Signing out, or another account: nothing of this one stays behind.
  Future<void> forgetAccount(String account) async {
    for (final tab in await _tabs(account)) {
      await storage.delete(_key(account, tab));
    }
    await storage.delete(_index(account));
  }
}
