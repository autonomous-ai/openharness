import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_cache_manager/flutter_cache_manager.dart';
import 'package:http/http.dart' as http;

import 'package:harness_mobile/logging/app_log.dart';

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

  /// Moves the moment the files kept stop being what they were: another
  /// account, nobody's, or the account's emptied ([clear]). Asked for, not
  /// done: a screen showing a kept file lets it go at once, not after the
  /// emptying, which waits for fetches under way.
  ValueListenable<int> get turns => _turns;
  final _turns = ValueNotifier(0);

  /// The account [keepOnly] was last asked to keep files for.
  String? _asked;

  /// Whether [keepOnly] has emptied all but [_account]'s files: until it
  /// has, the folder may hold what an earlier run, or another account, left.
  bool _kept = false;

  /// Whether [_account]'s own files are to go too: a [clear] that failed.
  /// The next [keepOnly] empties them.
  bool _clearOwed = false;

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
  /// (nobody signed in, or Swarm off) empties everything. A file that could
  /// not go throws, after the rest went; the next call tries again.
  Future<void> keepOnly(String? accountId) {
    final turned = accountId != _asked;
    _asked = accountId;
    final change = _serially(() async {
      if (accountId != _account) {
        _account = accountId;
        _kept = _clearOwed = false;
      }
      if (_kept && !_clearOwed) return;
      await _close();
      final root = await _root();
      if (await root.exists()) {
        final keep = accountId == null || _clearOwed ? null : _name(accountId);
        (Object, StackTrace)? failed;
        await for (final entry in root.list(followLinks: false)) {
          if (entry.uri.pathSegments.lastWhere((s) => s.isNotEmpty) == keep) {
            continue;
          }
          try {
            await _delete(entry);
          } catch (error, stack) {
            failed ??= (error, stack);
          }
        }
        if (failed case (final error, final stack)) {
          Error.throwWithStackTrace(error, stack);
        }
      }
      _kept = true;
      _clearOwed = false;
    });
    if (turned) _turn();
    return change;
  }

  /// Empties the account's files: a Swarm left its list. One that could not
  /// go throws, and the next [keepOnly] empties them.
  Future<void> clear() {
    final change = _serially(() async {
      await _close();
      final account = _account;
      if (account == null) return;
      _clearOwed = true;
      await _delete(await _folderOf(account));
      _clearOwed = false;
    });
    _turn();
    return change;
  }

  /// Tells of a change once it is queued, so a file asked for on hearing of
  /// it waits for the change, and is the new holder's.
  void _turn() => _turns.value++;

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
        fileService: _fileService ?? SwarmFileFetch(),
      ),
    );
  }

  Future<Directory> _folderOf(String account) async =>
      Directory('${(await _root()).path}/${_name(account)}');

  /// An account's folder name: its id, written so no id can reach outside.
  static String _name(String account) =>
      base64Url.encode(utf8.encode(account)).replaceAll('=', '');

  /// Deletes [entry]; one already gone is no failure, any other is thrown.
  static Future<void> _delete(FileSystemEntity entry) async {
    try {
      await entry.delete(recursive: true);
    } on PathNotFoundException {
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
  SwarmAttachmentKeeper(
    this.host, {
    SwarmAttachmentStore? store,
    this.retry = const Duration(minutes: 1),
  }) : store = store ?? swarmAttachments {
    host.addListener(_hostChanged);
    _hostChanged();
  }

  final SwarmHost host;
  final SwarmAttachmentStore store;

  /// How long after a failed emptying it is tried again; twice as long after
  /// each failure in a row, up to [_retryAtMost].
  final Duration retry;

  static const _retryAtMost = Duration(hours: 1);

  /// The wait before the next try, while emptying keeps failing.
  Duration? _wait;
  Timer? _again;
  bool _disposed = false;

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
    _emptying(store.keepOnly(session?.accountId));
    _listChanged();
  }

  void _listChanged() {
    final inbox = _session?.inbox;
    if (inbox == null || !inbox.loaded) return;
    final listed = {for (final swarm in inbox.swarms) swarm.id};
    final before = _listed;
    _listed = listed;
    if (before != null && !listed.containsAll(before)) {
      _emptying(store.clear());
    }
  }

  /// Emptying runs on its own. One that fails says so in the app's log and is
  /// tried again ([retry]): for the account signed in then, which also
  /// empties what a failed [SwarmAttachmentStore.clear] left.
  void _emptying(Future<void> emptying) => unawaited(
    emptying.then(
      (_) {
        _wait = null;
      },
      onError: (Object error, StackTrace stack) {
        appLog.failure(
          'swarm',
          'Swarm files could not be emptied',
          error: error,
          stackTrace: stack,
        );
        if (_disposed) return;
        final next = _wait == null ? retry : _wait! * 2;
        final wait = _wait = next > _retryAtMost ? _retryAtMost : next;
        _again?.cancel();
        _again = Timer(
          wait,
          () => _emptying(store.keepOnly(host.session?.accountId)),
        );
      },
    ),
  );

  void dispose() {
    _disposed = true;
    _again?.cancel();
    host.removeListener(_hostChanged);
    _session?.inbox.removeListener(_listChanged);
  }
}

/// The cache's fetch of a chat file: `HttpFileService`'s, with a redirect
/// refused, so a picture comes only from the host its message names and
/// nothing from another host is kept or drawn.
class SwarmFileFetch extends FileService {
  SwarmFileFetch({http.Client? client}) : _client = client ?? http.Client();

  final http.Client _client;

  @override
  Future<FileServiceResponse> get(
    String url, {
    Map<String, String>? headers,
  }) async {
    final request = http.Request('GET', Uri.parse(url))
      ..followRedirects = false;
    if (headers != null) request.headers.addAll(headers);
    return HttpGetResponse(await _client.send(request));
  }
}
