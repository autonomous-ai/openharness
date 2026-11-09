import 'dart:async';
import 'dart:math';

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';

import '../logging/app_log.dart';
import 'github_feed.dart';
import 'github_issues.dart';
import 'model.dart';

/// What a project's agents do on GitHub, read for its channel (Swarm v4, anh Dee 2026-11-09: "i dont see any agent to agent
/// chat"): the comments they sign, the pull requests they open and that are merged, the tasks labelled for them. It is read on
/// this computer with the person's own `gh` ([SwarmGitHub.rest]) and kept only here, in memory: repository content stays on
/// GitHub, and nothing of it goes to our server.
///
/// It reads while [active] (the channel is open and the app in front), at most every [every]; a failure backs off, and a rate
/// limit waits for GitHub's word. Each of the three lists ([SwarmFeed]) is read [SwarmFeed.perPage] rows at a time, newest
/// first, with its last ETag: a list that has not changed is a 304, which GitHub does not count against the rate limit.
/// [more] reads the next page of each, up to [_pagesMax].
class SwarmChannelFeed extends ChangeNotifier {
  SwarmChannelFeed({
    required this.github,
    required this.repository,
    required this.channelId,
    this.every = const Duration(minutes: 1),
  });

  final SwarmGitHub github;

  /// `owner/name`.
  final String repository;

  /// The channel it is read for.
  final String channelId;

  /// The time between two rounds of reads while the channel is open: each round reads the comments, and every third the pull
  /// requests and the labels too ([SwarmFeed.every]). A round is three `gh` calls at the most, about 0.13 s of CPU each, so a
  /// channel left open and in front costs about 0.4% of a core.
  final Duration every;

  /// How many pages of each list are read at most (of [SwarmFeed.perPage] rows), so what is kept is bounded.
  static const _pagesMax = 4;

  /// The longest a failing read waits before it asks again.
  static const _backoffMax = Duration(minutes: 10);

  /// The longest a rate limit is waited out in one go: GitHub's reset may be an hour away, and a person who comes back sooner
  /// should not wait for it.
  static const _limitMax = Duration(minutes: 15);

  final _rows = {for (final feed in SwarmFeed.values) feed: <SwarmFeedRow>[]};
  final _etags = <SwarmFeed, String>{};
  final _pages = {for (final feed in SwarmFeed.values) feed: 0};
  final _full = {for (final feed in SwarmFeed.values) feed: false};
  Timer? _timer;
  Future<void>? _reading;
  var _active = false;
  var _failures = 0;
  var _disposed = false;
  var _version = 0;
  var _round = 0;
  DateTime? _nextRead;

  /// Why the last read failed, in the words the person sees; null when it did not. [retryAt] is when a rate-limited read tries
  /// again.
  String? error;
  DateTime? retryAt;

  /// Whether a first read has answered, however it ended: until then the channel does not say it is empty.
  var loaded = false;

  /// An "earlier" read is on its way, or its last one failed.
  var loadingMore = false;
  var moreFailed = false;

  /// What the channel's rows of this feed are in: apart from the channel's own, whose rows number theirs.
  String get _conversationId => 'github:$channelId';

  /// Reads while the channel is open and the app in front; stops otherwise, and reads at once on coming back unless it read
  /// lately.
  set active(bool on) {
    if (on == _active || _disposed) return;
    _active = on;
    if (!on) {
      _timer?.cancel();
      _timer = null;
      return;
    }
    final wait = _nextRead?.difference(clock.now());
    // What was shown may be long out of date: the first round after it reads every list.
    _round = 0;
    _arm(wait == null || wait.isNegative ? Duration.zero : wait);
  }

  void _arm(Duration delay) {
    _timer?.cancel();
    _timer = Timer(delay, () {
      _timer = null;
      unawaited(read());
    });
  }

  /// One round: the first page of each list that is due, [all] of them or not, at once. A round under way is joined.
  Future<void> read({bool all = false}) =>
      _reading ??= _readNewest(all: all).whenComplete(() {
        _reading = null;
        final delay = _delay();
        if (_active && !_disposed) _arm(delay);
      });

  /// How long until the next read: [every], longer after failures, and until GitHub's word after a rate limit.
  Duration _delay() {
    final limit = retryAt?.difference(clock.now());
    final delay = limit != null && !limit.isNegative
        ? (limit > _limitMax ? _limitMax : limit)
        : _failures == 0
        ? every
        : Duration(
            milliseconds: min(
              _backoffMax.inMilliseconds,
              every.inMilliseconds * pow(2, _failures - 1).toInt(),
            ),
          );
    _nextRead = clock.now().add(delay);
    return delay;
  }

  Future<void> _readNewest({required bool all}) async {
    SwarmGitHubError? failed;
    var changed = !loaded;
    if (all) _round = 0;
    final round = _round++;
    await Future.wait([
      for (final feed in SwarmFeed.values)
        if (round % feed.every == 0)
          _readFirst(feed).then<void>(
            (read) {
              changed |= read;
            },
            onError: (Object error) {
              failed ??= _named(error);
            },
          ),
    ]);
    if (_disposed) return;
    // What no list changed, and no failure changed, redraws nothing.
    changed |= error != failed?.message || retryAt != failed?.retryAt;
    error = failed?.message;
    retryAt = failed?.retryAt;
    _failures = failed == null ? 0 : _failures + 1;
    loaded = true;
    if (!changed) return;
    _version++;
    notifyListeners();
  }

  /// [error] as the person is told it: GitHub's refusals have their words; anything else this app could not read is said as
  /// unreadable, and logged by its type alone.
  static SwarmGitHubError _named(Object error) {
    if (error is SwarmGitHubError) return error;
    appLog.warn('super-tabs', 'GitHub feed not read: ${error.runtimeType}');
    return const SwarmGitHubError(
      'GitHub sent something unreadable. Try again.',
    );
  }

  /// Reads the newest page of [feed]; whether it changed what is held.
  Future<bool> _readFirst(SwarmFeed feed) async {
    final page = await github.rest(
      repository,
      feed.path(1),
      etag: _etags[feed],
    );
    if (page.body == null) return false;
    if (page.etag != null) _etags[feed] = page.etag!;
    final fresh = feed.read(page.body!);
    final held = _rows[feed]!;
    final whole = fresh.length < SwarmFeed.perPage;
    final ids = {for (final row in fresh) row.id};
    // A page joins what is held when it overlaps it, as the issue panel joins comments: a gap is never hidden, so one that
    // starts after everything held stands alone and the older pages are read again when asked for. A row the page should hold
    // and does not was deleted.
    final overlaps = held.any((row) => ids.contains(row.id));
    if (_pages[feed] == 0 || whole || (held.isNotEmpty && !overlaps)) {
      _pages[feed] = 1;
      _full[feed] = !whole;
      held.clear();
    } else {
      final oldest = fresh.last.sortTime;
      held.removeWhere(
        (row) => ids.contains(row.id) || !row.sortTime.isBefore(oldest),
      );
    }
    held
      ..addAll(fresh)
      ..sort((a, b) => b.sortTime.compareTo(a.sortTime));
    return true;
  }

  /// The newest of what the lists hold: it moves when GitHub has something new to show.
  DateTime? get newest {
    DateTime? top;
    for (final rows in _rows.values) {
      if (rows.isNotEmpty &&
          (top == null || rows.first.sortTime.isAfter(top))) {
        top = rows.first.sortTime;
      }
    }
    return top;
  }

  /// Whether older rows may be read: a list whose last page was full and that is under [_pagesMax].
  bool get hasMore =>
      SwarmFeed.values.any((f) => _full[f]! && _pages[f]! < _pagesMax);

  /// Reads the next page of each list that has one, the older rows joining what is held.
  Future<void> more() async {
    if (loadingMore || !hasMore || _disposed) return;
    loadingMore = true;
    moreFailed = false;
    notifyListeners();
    SwarmGitHubError? failed;
    await Future.wait([
      for (final feed in SwarmFeed.values)
        if (_full[feed]! && _pages[feed]! < _pagesMax)
          _readOlder(feed).catchError((Object error) {
            failed ??= _named(error);
          }),
    ]);
    if (_disposed) return;
    loadingMore = false;
    moreFailed = failed != null;
    if (failed != null) error = failed!.message;
    _version++;
    notifyListeners();
  }

  Future<void> _readOlder(SwarmFeed feed) async {
    final page = await github.rest(repository, feed.path(_pages[feed]! + 1));
    final older = feed.read(page.body ?? '');
    final held = _rows[feed]!;
    final ids = {for (final row in held) row.id};
    held
      ..addAll(older.where((row) => !ids.contains(row.id)))
      ..sort((a, b) => b.sortTime.compareTo(a.sortTime));
    _pages[feed] = _pages[feed]! + 1;
    _full[feed] = older.length >= SwarmFeed.perPage;
  }

  /// Where the lists have been read back to: the newest of their oldest rows, over the lists that have older ones. Nothing is
  /// drawn from before it, or a stretch one list has not been read through would read as a quiet one. Null when every list is
  /// whole.
  DateTime? get _horizon {
    DateTime? newest;
    for (final feed in SwarmFeed.values) {
      final held = _rows[feed]!;
      if (!_full[feed]! || held.isEmpty) continue;
      final oldest = held.last.sortTime;
      if (newest == null || oldest.isAfter(newest)) newest = oldest;
    }
    return newest;
  }

  int _built = -1;
  String _builtFor = '';
  List<SuperTabMessage> _extra = const [];

  /// [real], the channel's own rows, with the feed's cards among them by time: the events of the project's [agents], and where
  /// older rows may be read, the marker that reads them as it comes into view. What nobody of the project signed is not here.
  List<SuperTabMessage> mixedInto(
    List<SuperTabMessage> real,
    List<SuperTabAgent> agents,
  ) {
    final key = [
      for (final agent in agents)
        '${agent.id}\u0000${agent.name}\u0000${agent.displayName}',
    ].join('\u0001');
    if (_built != _version || _builtFor != key) {
      _built = _version;
      _builtFor = key;
      _extra = _derive(agents);
    }
    if (_extra.isEmpty) return real;
    final mixed = <SuperTabMessage>[];
    var i = 0, j = 0;
    while (i < real.length || j < _extra.length) {
      final at = i < real.length ? real[i].createdAt : null;
      final other = j < _extra.length ? _extra[j].createdAt! : null;
      // On a tie the channel's own row goes first; a row with no time stays where it was.
      if (j >= _extra.length ||
          (i < real.length && (at == null || !at.isAfter(other!)))) {
        mixed.add(real[i++]);
      } else {
        mixed.add(_extra[j++]);
      }
    }
    return mixed;
  }

  /// The feed's own rows, oldest first: the marker where older rows may be read, then each card.
  List<SuperTabMessage> _derive(List<SuperTabAgent> agents) {
    final floor = _horizon;
    final cards = <(SwarmFeedEvent, SuperTabAgent)>[];
    for (final rows in _rows.values) {
      for (final row in rows) {
        for (final event in row.events) {
          if (floor != null && event.time.isBefore(floor)) continue;
          final agent = _by(event, agents);
          if (agent != null) cards.add((event, agent));
        }
      }
    }
    cards.sort((a, b) {
      final byTime = a.$1.time.compareTo(b.$1.time);
      return byTime != 0 ? byTime : a.$1.id.compareTo(b.$1.id);
    });
    return [
      if (floor != null && hasMore) _earlier(floor),
      for (final (event, agent) in cards) _card(event, agent),
    ];
  }

  /// The agent [event] is by, or null when it is by none of [agents]: a comment signed with its name, a pull request or a task
  /// by its builder label or its branch (`pip/14`).
  static SuperTabAgent? _by(SwarmFeedEvent event, List<SuperTabAgent> agents) {
    for (final agent in agents) {
      final by = event.kind == SwarmFeedKind.comment
          ? {
              agent.name,
              ?agent.displayName,
            }.any((name) => signedBy(event.text, name))
          : event.by == _slug(agent.name);
      if (by) return agent;
    }
    return null;
  }

  /// Whether [body] is [name]'s own post: signed with its name first ("Pip, 14:05: ..."), as the daemon reads it (cli
  /// superTabs/githubMentions.ts `signedBy`).
  static bool signedBy(String body, String name) =>
      RegExp('^\\W*${RegExp.escape(name)}[*_]*\\s*[,:]').hasMatch(body);

  /// An agent's builder label without its prefix: `pip` for Pip, `first-builder` for First builder.
  static String _slug(String name) =>
      name.trim().toLowerCase().replaceAll(RegExp(r'\s+'), '-');

  /// A card as a message of the kind a person's agent is relayed GitHub's words in (backend githubRelay.ts), by the agent, so
  /// the card that draws those draws this.
  SuperTabMessage _card(SwarmFeedEvent event, SuperTabAgent agent) {
    final where =
        '${event.pull ? 'pull request' : 'issue'} $repository#${event.number}';
    final text = switch (event.kind) {
      SwarmFeedKind.comment =>
        'On GitHub, ${event.login} wrote on $where:\n${event.text}\n${event.url}',
      SwarmFeedKind.opened =>
        '${agent.name} opened $where\n${event.text}\n${event.url}',
      SwarmFeedKind.merged =>
        '${agent.name}\'s $where was merged\n${event.text}\n${event.url}',
      SwarmFeedKind.task =>
        'New task for ${agent.name}: $where ${event.text}\n${event.url}',
    };
    return SuperTabMessage.fromJson({
      'id': 'github:${event.id}',
      'conversationId': _conversationId,
      'sequence': 0,
      'text': text,
      'createdAt': event.time.toUtc().toIso8601String(),
      'author': {
        'kind': 'agent',
        'id': agent.id,
        'name': agent.name,
        'displayName': agent.displayName,
      },
      'source': {
        'kind': 'github',
        'event': event.kind.name,
        'on': event.pull ? 'pull' : 'issue',
        'repository': repository,
        'number': event.number,
        'url': event.url,
        'login': event.login,
        'association': event.association,
      },
    });
  }

  /// The row where older GitHub talk may be read: [SwarmFeedEarlier] draws it, and reads it as it comes into view.
  SuperTabMessage _earlier(DateTime at) => SuperTabMessage.fromJson({
    'id': 'github:earlier',
    'conversationId': _conversationId,
    'sequence': 0,
    'text': '',
    'createdAt': at.toUtc().toIso8601String(),
    'author': {'kind': 'agent', 'id': '', 'name': ''},
    'source': {'kind': earlierKind},
  });

  /// What [SuperTabMessage.source] says of the row [_earlier] makes.
  static const earlierKind = 'github-earlier';

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}
