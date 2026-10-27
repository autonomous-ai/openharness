import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_cache_manager/flutter_cache_manager.dart';

import 'swarm_session.dart';

/// The folder, under the app's private temporary folder, that the phone keeps
/// Swarm's files in: one folder per account inside it.
const _folder = 'swarm-attachments';

/// A file nobody opens for this long goes.
const swarmAttachmentStale = Duration(days: 7);

/// At most this many files are kept; the least recently opened go first.
const swarmAttachmentCap = 200;

/// The phone's copies of Swarm's files, for the pictures shown in a chat
/// ([SwarmAttachment]).
///
/// Fetched exactly as the chip opens them: the public link on Harness's file
/// storage, with no credential of the app's. Kept in the app's private
/// temporary folder (never backed up, never seen by another app), for one
/// account only ([keepOnly]); a file goes after [swarmAttachmentStale]
/// unopened, and the oldest past [swarmAttachmentCap].
///
/// Emptied by [SwarmAttachmentKeeper] on sign-out, Swarm turned off, another
/// account, and a Swarm leaving the account's list.
class SwarmAttachmentStore {
  SwarmAttachmentStore({
    Future<Directory> Function()? root,
    this._fileService,
    this._files,
  }) : _root = root ?? (() => IOFileSystem.createDirectory(_folder));

  final Future<Directory> Function() _root;
  final FileService? _fileService;
  final FileSystem Function(Directory folder)? _files;

  /// The account files are kept for; null while nobody's are.
  String? _account;

  /// Whether [keepOnly] has run: until it has, the folder may hold what an
  /// earlier run left, whoever's it was.
  bool _kept = false;

  /// The fetches under way. Emptying waits for them, so none writes into a
  /// folder already emptied, and the cache is never closed under one.
  final _fetching = <Future<void>>{};

  /// The account's cache, opened by the first file asked for after a change.
  Future<CacheManager>? _cache;

  /// [keepOnly] and [clear] one after the other, never over each other.
  Future<void> _changing = Future.value();

  /// [url]'s file, fetched the first time and kept after. Throws while nobody's
  /// files are kept. Asked while they are being emptied, it waits for that.
  Future<File> file(Uri url) async {
    await _changing;
    final account = _account;
    if (account == null) throw StateError('No account to keep files for.');
    final fetch = _fetch(account, url);
    final done = fetch.then<void>((_) {}, onError: (Object _) {});
    _fetching.add(done);
    try {
      return await fetch;
    } finally {
      _fetching.remove(done);
    }
  }

  Future<File> _fetch(String account, Uri url) async =>
      (await (_cache ??= _cacheFor(account))).getSingleFile(url.toString());

  /// Keeps [accountId]'s files and empties every other account's; with null
  /// (nobody signed in, or Swarm off) empties everything.
  Future<void> keepOnly(String? accountId) => _serially(() async {
    if (_kept && accountId == _account) return;
    _kept = true;
    _account = accountId;
    await _close();
    final root = await _root();
    if (!await root.exists()) return;
    final keep = accountId == null ? null : _name(accountId);
    await for (final entry in root.list(followLinks: false)) {
      if (entry.uri.pathSegments.lastWhere((s) => s.isNotEmpty) == keep) {
        continue;
      }
      await _delete(entry);
    }
  });

  /// Empties the account's files: a Swarm left its list.
  Future<void> clear() => _serially(() async {
    await _close();
    final account = _account;
    if (account == null) return;
    await _delete(await _folderOf(account));
  });

  /// Runs [change] after the changes before it and the fetches under way. One
  /// that fails holds up none after it.
  Future<void> _serially(Future<void> Function() change) {
    final run = _changing.then((_) async {
      await Future.wait([..._fetching]);
      await change();
    });
    _changing = run.catchError((Object _) {});
    return run;
  }

  Future<void> _close() async {
    final cache = _cache;
    _cache = null;
    await (await cache)?.dispose();
  }

  Future<CacheManager> _cacheFor(String account) async {
    final folder = await _folderOf(account);
    final key = '$_folder/${_name(account)}';
    return CacheManager(
      Config(
        key,
        stalePeriod: swarmAttachmentStale,
        maxNrOfCacheObjects: swarmAttachmentCap,
        // In the account's folder, so emptying it takes what was kept and the
        // record of it together.
        repo: JsonCacheInfoRepository.withFile(
          File('${folder.path}/index.json'),
        ),
        fileSystem: _files?.call(folder) ?? IOFileSystem(key),
        fileService: _fileService ?? HttpFileService(),
      ),
    );
  }

  Future<Directory> _folderOf(String account) async =>
      Directory('${(await _root()).path}/${_name(account)}');

  /// An account's folder name: its id, written so no id can reach outside.
  static String _name(String account) =>
      base64Url.encode(utf8.encode(account)).replaceAll('=', '');

  static Future<void> _delete(FileSystemEntity entry) async {
    try {
      await entry.delete(recursive: true);
    } on FileSystemException {
      // Already gone.
    }
  }
}

/// The app's one store of Swarm's files.
final swarmAttachments = SwarmAttachmentStore();

/// Keeps [store] to the account whose Swarm [host] reads: the files go on
/// sign-out, Swarm turned off and another account ([SwarmAttachmentStore.keepOnly]),
/// and when a Swarm leaves the account's list ([SwarmAttachmentStore.clear]).
/// The shell's, for its lifetime; at start it empties what no one now signed
/// in left behind.
class SwarmAttachmentKeeper {
  SwarmAttachmentKeeper(this.host, {SwarmAttachmentStore? store})
    : store = store ?? swarmAttachments {
    host.addListener(_hostChanged);
    _hostChanged();
  }

  final SwarmHost host;
  final SwarmAttachmentStore store;

  SwarmSession? _session;

  /// The Swarms last read in the account's list; null until it is read.
  Set<String>? _listed;

  void _hostChanged() {
    final session = host.session;
    if (!identical(session, _session)) {
      _session?.inbox.removeListener(_listChanged);
      _session = session;
      _listed = null;
      session?.inbox.addListener(_listChanged);
    }
    unawaited(store.keepOnly(session?.accountId));
    _listChanged();
  }

  void _listChanged() {
    final inbox = _session?.inbox;
    if (inbox == null || !inbox.loaded) return;
    final listed = {for (final swarm in inbox.swarms) swarm.id};
    final before = _listed;
    _listed = listed;
    if (before != null && !listed.containsAll(before)) {
      unawaited(store.clear());
    }
  }

  void dispose() {
    host.removeListener(_hostChanged);
    _session?.inbox.removeListener(_listChanged);
  }
}
