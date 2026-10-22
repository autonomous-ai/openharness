import 'dart:async';

import 'package:flutter/foundation.dart';

import 'pull_request_entry.dart';

/// The state of the pull requests that the sidebar's workgroups link to, read in one batch for every row on
/// screen, by this window's own computer and its GitHub login — the same reader the Pull requests pane uses
/// (`git_pull_requests_status`). It asks again every minute while a PR can still change, and says nothing at all
/// when that reader is not there (an older CLI) or GitHub cannot be read: a row then simply has no PR state.
class SidebarPullRequests extends ChangeNotifier {
  SidebarPullRequests({
    required this.read,
    this.active = _always,
    this.every = const Duration(seconds: 60),
  });

  /// The batch reader; null where this window has none.
  final Future<Map<String, dynamic>> Function(List<String> urls)? read;

  /// Whether to read now: the window is in front. A hidden window reads nothing.
  final bool Function() active;

  /// How long after a read that something may still change to read again.
  final Duration every;

  static bool _always() => true;

  /// What was read, by link.
  final entries = <String, SuperTabPullRequestEntry>{};

  /// The reader answered that this window cannot read pull requests; nothing is asked again.
  bool unsupported = false;

  Set<String> _wanted = {};
  Timer? _timer;
  int _run = 0;
  bool _reading = false, _disposed = false, _failed = false;

  /// The pull request state for [url], if it has been read.
  SuperTabPullRequestEntry? of(String url) => entries[url];

  /// The links the rows on screen name. Reads those not yet known, once, now; a changed set reads again.
  void want(Set<String> urls) {
    if (setEquals(urls, _wanted)) return;
    _wanted = {...urls};
    unawaited(refresh());
  }

  /// Reads every wanted link that can still change.
  Future<void> refresh() async {
    _timer?.cancel();
    final reader = read;
    if (_disposed || reader == null || unsupported || !active()) return;
    final urls = _wanted
        .where((url) => entries[url]?.finalState != true)
        .toList();
    if (urls.isEmpty) return;
    if (_reading) {
      // One read at a time; the links that arrived meanwhile are read as soon as it ends.
      _run++;
      return;
    }
    _reading = true;
    final run = ++_run;
    var changed = false;
    _failed = false;
    try {
      for (var i = 0; i < urls.length; i += 50) {
        final answer = await reader(urls.skip(i).take(50).toList());
        if (_disposed) return;
        final error = answer['error'];
        if (const [
          'UNSUPPORTED',
          'E2EE_REQUIRED',
          'OWNER_REQUIRED',
          'LOCAL_GITHUB_UNAVAILABLE',
        ].contains(error)) {
          unsupported = true;
          if (entries.isNotEmpty) {
            entries.clear();
            changed = true;
          }
          break;
        }
        if (error == 'GH_MISSING' || error == 'GH_SIGNED_OUT') {
          // A changed login must not leave yesterday's private titles under today's account.
          if (entries.isNotEmpty) {
            entries.clear();
            changed = true;
          }
          _failed = true;
          break;
        }
        if (error is String || answer['rows'] is! List) _failed = true;
        for (final raw
            in answer['rows'] is List ? answer['rows'] as List : const []) {
          if (raw is! Map) continue;
          final entry = SuperTabPullRequestEntry.fromJson(
            Map<String, dynamic>.from(raw),
          );
          if (entry == null ||
              !urls.contains(entry.url.toString()) ||
              entry.status == 'unavailable') {
            continue;
          }
          final key = entry.url.toString();
          if (!_same(entries[key], entry)) {
            entries[key] = entry;
            changed = true;
          }
        }
      }
    } catch (_) {
      _failed = true;
    } finally {
      _reading = false;
    }
    if (_disposed) return;
    if (changed) notifyListeners();
    if (run != _run) {
      // Something was wanted while this read ran.
      unawaited(refresh());
    } else if (!unsupported &&
        (_failed || _wanted.any((url) => entries[url]?.finalState != true))) {
      _timer = Timer(every, () => unawaited(refresh()));
    }
  }

  static bool _same(SuperTabPullRequestEntry? a, SuperTabPullRequestEntry b) =>
      a != null &&
      a.state == b.state &&
      a.status == b.status &&
      a.mergeState == b.mergeState &&
      a.review == b.review &&
      a.passed == b.passed &&
      a.failed == b.failed &&
      a.pending == b.pending &&
      a.total == b.total &&
      a.autoMerge == b.autoMerge &&
      a.title == b.title;

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}
