import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../core/local_key_value_store.dart';
import 'fork_link.dart';

/// Queued before authentication; persisted without credentials or project content.
class ForkInbox extends ChangeNotifier {
  ForkInbox(
    this.store, {
    this.channel = const MethodChannel('harness/community_links'),
  });
  final LocalKeyValueStore store;
  final MethodChannel channel;
  static const storageKey = 'community.forks.v1';
  final List<ForkLink> pending = [];
  Future<void> _tail = Future.value();
  String? error;
  Future<void> initialize() async {
    final saved = await store.read(storageKey);
    if (saved != null) {
      try {
        final data = jsonDecode(saved) as Map<String, dynamic>;
        for (final value in (data['pending'] as List).take(20)) {
          final link = ForkLink.parse(value as String);
          if (link != null) pending.add(link);
        }
      } on FormatException {
        /* Ignore an invalid inbox, never the app's other state. */
      } on TypeError {
        /* Older/corrupt inbox. */
      }
    }
    channel.setMethodCallHandler((call) async {
      if (call.method == 'open' && call.arguments is String) {
        await accept(call.arguments as String);
      }
    });
    try {
      final urls = await channel.invokeListMethod<String>('ready') ?? [];
      for (final url in urls) {
        await accept(url);
      }
    } on MissingPluginException {
      /* Unsupported host, including unit tests. */
    }
    notifyListeners();
  }

  Future<void> accept(String url) => _serialize(() async {
    final link = ForkLink.parse(url);
    if (link == null || pending.any((p) => p.key == link.key)) {
      return;
    }
    if (pending.length >= 20) return;
    pending.add(link);
    await _save();
    notifyListeners();
  });
  Future<void> complete(ForkLink link) => _serialize(() async {
    pending.removeWhere((p) => p.key == link.key);
    await _save();
    notifyListeners();
  });
  Future<void> _save() => store.write(
    storageKey,
    jsonEncode({'pending': pending.map((p) => p.url).toList()}),
  );
  Future<void> _serialize(Future<void> Function() action) {
    final result = _tail.then((_) => action());
    _tail = result.catchError((Object _) {});
    return result;
  }
}
