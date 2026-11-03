import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cryptography/cryptography.dart';
import 'package:cryptography/dart.dart';
import 'package:flutter/foundation.dart';

import '../core/harness_file_store.dart';
import '../e2ee/bytes.dart';
import '../logging/app_log.dart';
import 'swarm_home_cache.dart' show KeychainSwarmHomeKey, SwarmHomeKey;

/// Where [SwarmKept] keeps what it holds, one account's at a time.
abstract interface class SwarmKeptStore {
  /// [accountId]'s, or null: none, or none it can open.
  Future<Map<String, dynamic>?> read(String accountId);
  Future<void> write(String accountId, Map<String, dynamic> kept);

  /// Nothing kept, and nothing left that could open it.
  Future<void> clear();
}

/// [SwarmKeptStore] for tests and for a phone that keeps nothing past the run.
class MemorySwarmKeptStore implements SwarmKeptStore {
  Map<String, dynamic>? held;
  String heldBy = 'me';

  @override
  Future<Map<String, dynamic>?> read(String accountId) async =>
      accountId == heldBy ? held : null;

  @override
  Future<void> write(String accountId, Map<String, dynamic> kept) async {
    heldBy = accountId;
    held = jsonDecode(jsonEncode(kept)) as Map<String, dynamic>;
  }

  @override
  Future<void> clear() async => held = null;
}

/// What a person wrote and has not got through, sealed as the kept Home is
/// (`SwarmHomeCache`): ChaCha20-Poly1305 under a random key of its own in the
/// Keychain, in [file] beside the app's state. A file that does not open is
/// none, and goes; [clear] takes the key too.
class SealedSwarmKeptStore implements SwarmKeptStore {
  SealedSwarmKeptStore({required this.key, required this.file});

  /// The device's: one, so its clears and writes keep one order, whoever asks.
  factory SealedSwarmKeptStore.device() => _device ??= SealedSwarmKeptStore(
    key: const KeychainSwarmHomeKey(name: 'swarm_kept_key'),
    file: File('${HarnessFileStore.shared.directory.path}/swarm-kept.bin'),
  );
  static SealedSwarmKeptStore? _device;

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

  @override
  Future<Map<String, dynamic>?> read(String accountId) => _serial(() async {
    try {
      if (!await file.exists()) return null;
      final secret = await key.read();
      final opened = secret == null
          ? null
          : _open(b64d(secret), await file.readAsBytes());
      if (opened == null ||
          opened['format'] != _format ||
          opened['account'] != accountId) {
        await _forget();
        return null;
      }
      return opened;
    } catch (failure) {
      appLog.warn('swarm', 'Drafts not read: ${failure.runtimeType}');
      await _forget();
      return null;
    }
  });

  @override
  Future<void> write(String accountId, Map<String, dynamic> kept) =>
      _serial(() async {
        try {
          var secret = await key.read();
          if (secret == null) {
            secret = b64e(secureRandomBytes(32));
            await key.write(secret);
          }
          final nonce = secureRandomBytes(_nonceBytes);
          final box = _aead.encryptSync(
            utf8.encode(
              jsonEncode({'format': _format, 'account': accountId, ...kept}),
            ),
            secretKey: SecretKeyData(b64d(secret)),
            nonce: nonce,
          );
          await file.parent.create(recursive: true);
          final next = File('${file.path}.next');
          await next.writeAsBytes(box.concatenation(), flush: true);
          await next.rename(file.path);
        } catch (failure) {
          // Held in memory for this run; never words in the log.
          appLog.warn('swarm', 'Drafts not kept: ${failure.runtimeType}');
          await _forget();
        }
      });

  @override
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
}

/// A draft as kept: its words, and those it mentions by id.
typedef SwarmKeptDraft = ({String text, Map<String, String> mentions});

/// The account's drafts and unsent posts, by Swarm, chat and thread, for as
/// long as they are its own (Tony's mobile list, task 25; the desktop's
/// `threadDrafts`, #2610). Held here for the session, whatever a chat does, and
/// in [store] across restarts. One per [SwarmInbox]; [SwarmHost] clears the
/// store when the account leaves.
class SwarmKept extends ChangeNotifier {
  SwarmKept({
    required this.accountId,
    SwarmKeptStore? store,
    this.saveAfter = const Duration(milliseconds: 300),
  }) : _store = store {
    if (store == null) {
      _loaded = true;
      ready = Future.value();
    } else {
      ready = _load();
    }
  }

  static const maxDrafts = 500, maxPosts = 200;

  final String accountId;
  final SwarmKeptStore? _store;

  /// How long a draft waits to be written, while someone types.
  final Duration saveAfter;

  /// Done once what was kept is read back.
  late final Future<void> ready;

  bool get loaded => _loaded;
  bool _loaded = false;

  /// Oldest first, so the caps let the oldest go.
  final _drafts = <String, Map<String, dynamic>>{};
  final _posts = <String, Map<String, dynamic>>{};

  /// What changed before the read back: it wins over what was kept.
  final _touched = <String>{};
  Timer? _save;
  bool _disposed = false;

  static String _at(String tab, String chat, String? root) =>
      jsonEncode([tab, chat, root]);

  Future<void> _load() async {
    Map<String, dynamic>? kept;
    try {
      kept = await _store!.read(accountId);
    } catch (_) {
      // None: this run's stays in memory.
    }
    if (_disposed) return;
    final older = <String, Map<String, dynamic>>{};
    for (final raw in _list(kept?['drafts'])) {
      if (raw case {
        'tab': final String tab,
        'chat': final String chat,
        'text': final String _,
      }) {
        older[_at(tab, chat, raw['root'] as String?)] = raw;
      }
    }
    final olderPosts = <String, Map<String, dynamic>>{};
    for (final raw in _list(kept?['posts'])) {
      if (raw case {
        'tab': final String tab,
        'chat': final String chat,
        'posts': final List _,
      }) {
        olderPosts[_at(tab, chat, raw['root'] as String?)] = raw;
      }
    }
    bool isDropped(Map<String, dynamic> row) =>
        _dropped.any((gone) => gone(row));
    final held = older.length + olderPosts.length;
    older.removeWhere((at, row) => _touched.contains(at) || isDropped(row));
    olderPosts.removeWhere(
      (at, row) => _touched.contains(at) || isDropped(row),
    );
    // Something dropped before it was read: the file must lose it too.
    final filtered = older.length + olderPosts.length < held;
    // Older first, then what this run has already changed.
    final drafts = {...older, ..._drafts};
    final posts = {...olderPosts, ..._posts};
    _drafts
      ..clear()
      ..addAll(drafts);
    _posts
      ..clear()
      ..addAll(posts);
    _loaded = true;
    if (_touched.isNotEmpty || filtered) _saveSoon(now: filtered);
    notifyListeners();
  }

  static List<Map<String, dynamic>> _list(Object? raw) => [
    if (raw is List)
      for (final row in raw)
        if (row is Map<String, dynamic>) row,
  ];

  SwarmKeptDraft? draft(String tab, String chat, String? root) {
    final row = _drafts[_at(tab, chat, root)];
    if (row == null) return null;
    return (
      text: row['text'] as String,
      mentions: {
        if (row['mentions'] case final Map mentions)
          for (final MapEntry(:key, :value) in mentions.entries)
            if (key is String && value is String) key: value,
      },
    );
  }

  /// Keeps [text] as the draft there; empty, it leaves.
  void setDraft(
    String tab,
    String chat,
    String? root,
    String text, [
    Map<String, String> mentions = const {},
  ]) {
    if (_disposed) return;
    final at = _at(tab, chat, root);
    _touched.add(at);
    final was = _drafts.remove(at);
    if (text.isEmpty) {
      if (was != null) _saveSoon();
      return;
    }
    _drafts[at] = {
      'tab': tab,
      'chat': chat,
      'root': ?root,
      'text': text,
      if (mentions.isNotEmpty) 'mentions': mentions,
    };
    while (_drafts.length > maxDrafts) {
      _drafts.remove(_drafts.keys.first);
    }
    _saveSoon();
  }

  List<Map<String, dynamic>> posts(String tab, String chat, String? root) => [
    for (final post in _list(_posts[_at(tab, chat, root)]?['posts'])) post,
  ];

  int get _postCount =>
      _posts.values.fold(0, (n, row) => n + (row['posts'] as List).length);

  /// Keeps [posts] as those on their way there, written at once: a phone may
  /// be killed the moment after a send.
  void setPosts(
    String tab,
    String chat,
    String? root,
    List<Map<String, dynamic>> posts,
  ) {
    if (_disposed) return;
    final at = _at(tab, chat, root);
    final was = _posts[at];
    if (was == null && posts.isEmpty) return;
    _touched.add(at);
    _posts.remove(at);
    if (posts.isNotEmpty) {
      _posts[at] = {'tab': tab, 'chat': chat, 'root': ?root, 'posts': posts};
    }
    while (_postCount > maxPosts) {
      _posts.remove(_posts.keys.first);
    }
    _saveSoon(now: true);
  }

  /// The chats it holds something of in Swarm [tab].
  Set<String> chats(String tab) => {
    for (final row in [..._drafts.values, ..._posts.values])
      if (row['tab'] == tab) row['chat'] as String,
  };

  /// The Swarms it holds something of.
  Set<String> get tabs => {
    for (final row in [..._drafts.values, ..._posts.values])
      row['tab'] as String,
  };

  /// The person lost [chat]: nothing of it stays.
  void dropChat(String tab, String chat) =>
      _drop((row) => row['tab'] == tab && row['chat'] == chat);

  /// The person lost Swarm [tab]: nothing of it stays.
  void dropSwarm(String tab) => _drop((row) => row['tab'] == tab);

  void _drop(bool Function(Map<String, dynamic>) gone) {
    if (_disposed) return;
    for (final held in [_drafts, _posts]) {
      for (final at in [
        for (final MapEntry(:key, :value) in held.entries)
          if (gone(value)) key,
      ]) {
        held.remove(at);
        _touched.add(at);
      }
    }
    _dropped.add(gone);
    _saveSoon(now: true);
  }

  /// What was dropped before the read back: it does not come back with it.
  final _dropped = <bool Function(Map<String, dynamic>)>[];

  void _saveSoon({bool now = false}) {
    if (!_loaded || _store == null || _disposed) return;
    _save?.cancel();
    _save = null;
    if (now || saveAfter == Duration.zero) {
      unawaited(_write());
    } else {
      _save = Timer(saveAfter, () => unawaited(_write()));
    }
  }

  Future<void> _write() async {
    _save = null;
    await _store?.write(accountId, {
      'drafts': _drafts.values.toList(),
      'posts': _posts.values.toList(),
    });
  }

  /// Written now: the app going to the background may be its last moment.
  Future<void> flush() async {
    if (_disposed || !_loaded || _store == null) return;
    _save?.cancel();
    await _write();
  }

  @override
  void dispose() {
    if (_save != null) {
      _save?.cancel();
      unawaited(_write());
    }
    _disposed = true;
    super.dispose();
  }
}
