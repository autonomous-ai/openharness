import 'dart:async';

import 'package:flutter/foundation.dart';

import 'pull_request_entry.dart';

/// Reads pull requests' status on this computer, as the PR pane does
/// (`AppNotifier.readPullRequestsStatus`).
typedef SuperTabPullRequestRead = Future<Map<String, dynamic>> Function(
  List<String> urls,
);

/// What this computer's GitHub says about the pull requests live cards show:
/// title, state and checks. Read with the viewer's own sign-in, so a card shows
/// only what the viewer could read on GitHub. Nothing to read (no reader, no
/// sign-in, no access) leaves a card with the Swarm's facts alone, quietly.
/// Every watched pull request is read again [every], merged and closed ones
/// too: a sign-out or another GitHub account must not leave their private
/// titles behind. This computer's reader answers a final state from its own
/// cache, kept per GitHub account (cli lib/pullRequestsStatus.ts).
class SuperTabPullRequestFacts extends ChangeNotifier {
  SuperTabPullRequestFacts(this._read);

  static const every = Duration(seconds: 60);
  static const _batch = 50;
  static const _signedOut = {'GH_MISSING', 'GH_SIGNED_OUT'};

  final SuperTabPullRequestRead? _read;
  final _entries = <String, SuperTabPullRequestEntry>{};
  final _watchers = <String, int>{};
  Timer? _timer;
  bool _reading = false, _disposed = false;

  SuperTabPullRequestEntry? of(String url) => _entries[url];

  /// A card shows [urls]: read the ones not read yet, then keep them fresh
  /// until [unwatch].
  void watch(Iterable<String> urls) {
    final unread = [
      for (final url in urls)
        if ((_watchers[url] = (_watchers[url] ?? 0) + 1) == 1 &&
            !_entries.containsKey(url))
          url,
    ];
    if (unread.isNotEmpty) unawaited(_refresh(unread));
    _schedule();
  }

  void unwatch(Iterable<String> urls) {
    for (final url in urls) {
      final count = (_watchers[url] ?? 0) - 1;
      if (count > 0) {
        _watchers[url] = count;
      } else {
        _watchers.remove(url);
      }
    }
    _schedule();
  }

  void _schedule() {
    if (_read == null || _watchers.isEmpty) {
      _timer?.cancel();
      _timer = null;
      return;
    }
    _timer ??= Timer.periodic(
      every,
      (_) => unawaited(_refresh(_watchers.keys.toList())),
    );
  }

  Future<void> _refresh(List<String> urls) async {
    final read = _read;
    if (read == null || _reading || urls.isEmpty) return;
    _reading = true;
    try {
      for (var i = 0; i < urls.length; i += _batch) {
        final answer = await read(urls.skip(i).take(_batch).toList());
        if (_disposed) return;
        if (_signedOut.contains(answer['error'])) {
          // Another account's private titles never stay under a changed login.
          _entries.clear();
          break;
        }
        _take(answer['rows'], urls);
      }
    } catch (_) {
      // An unreachable computer keeps what it read last.
    } finally {
      _reading = false;
    }
    if (_disposed) return;
    _schedule();
    notifyListeners();
  }

  void _take(Object? rows, List<String> asked) {
    for (final raw in rows is List ? rows : const []) {
      if (raw is! Map) continue;
      final entry = SuperTabPullRequestEntry.fromJson(
        Map<String, dynamic>.from(raw),
      );
      final url = entry?.url.toString();
      if (entry == null || !asked.contains(url)) continue;
      // An account that cannot read it forgets it; a failed read keeps the
      // last answer.
      if (entry.status == 'found') {
        _entries[url!] = entry;
      } else if (entry.status == 'no_access') {
        _entries.remove(url);
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}
