import 'dart:async';

import 'package:flutter/foundation.dart';

import 'model.dart';
import 'swarm_asks.dart';
import 'swarm_buddy.dart';
import 'swarm_home_cache.dart';
import 'swarm_home_keeper.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'waiting_work.dart';

/// One of the account's Swarms, as the list names it.
typedef SwarmListing = ({String id, String name});

/// What the Swarm page says when the account's server has no Swarm list:
/// one from before Swarm v1, whose one-Swarm route reads "list" as a Swarm's
/// id and answers that it is unavailable (the owner's iPhone, 2026-10-27).
const swarmServerTooOld =
    'Your Harness server does not support Swarm on the phone yet.';

/// An invitation to a Swarm, as the person's invitations list it: the
/// Swarm's name and the role offered, nothing read of the Swarm itself.
typedef SwarmInvitation = ({
  String tabId,
  String name,
  String inviteId,
  String role,
});

/// Something a Swarm asks of the person, with the Swarm it is in.
sealed class SwarmNeed {
  SwarmNeed(this.swarmId);
  final String swarmId;

  /// The conversation it is about, to open from it.
  String get conversationId;

  /// Stable across reads: what a notice is keyed by.
  String get key;
}

/// A decision asked of the person, answered with one tap.
class SwarmDecisionNeed extends SwarmNeed {
  SwarmDecisionNeed(super.swarmId, this.decision);
  final SuperTabDecision decision;
  @override
  String get conversationId => decision.conversationId;
  @override
  String get key => 'decision:${decision.id}';
}

/// A Lead's tag of the person.
class SwarmMentionNeed extends SwarmNeed {
  SwarmMentionNeed(super.swarmId, this.mention);
  final SuperTabMention mention;
  @override
  String get conversationId => mention.conversationId;
  @override
  String get key => 'mention:${mention.id}';
}

/// Work waiting on the person ([swarmWaitingWork]).
class SwarmWorkNeed extends SwarmNeed {
  SwarmWorkNeed(super.swarmId, this.work);
  final SwarmWaitingWork work;
  @override
  String get conversationId => work.conversation.id;
  @override
  String get key =>
      'work:$swarmId:${work.conversation.id}:'
      '${work.conversation.assignment?['id']}:${work.status}';
}

/// The account's Swarms on this phone, and everything they ask of the person
/// in one list ([needs]): open decisions first, then Lead tags, then work
/// waiting on them.
///
/// Each read is the list, then one change read per Swarm (whose `derived`
/// counts say whether there are decisions or tags to read). It reads only
/// while [shown], as a [SwarmReader] does. One per account: a Swarm that
/// leaves the list is dropped with everything read of it.
class SwarmInbox extends ChangeNotifier {
  SwarmInbox({
    required this.accountId,
    required this.request,
    this.upload = refuseSwarmUpload,
    this.pollInterval = const Duration(seconds: 15),
    SwarmHomeCache? homeCache,
    Duration homeWait = const Duration(seconds: 30),
  }) : _home = homeCache == null
           ? null
           : SwarmHomeKeeper(homeCache, accountId, wait: homeWait) {
    if (_home != null) unawaited(_restore());
  }

  /// Keeps the last Home ([SwarmHomeCache]), so a cold start draws it at once.
  final SwarmHomeKeeper? _home;

  /// Draws the Home kept until the list is read: each Swarm's reader holds
  /// the view kept, which its first read replaces. One that does not read
  /// back is not drawn.
  Future<void> _restore() async {
    final kept = await _home!.restore();
    if (kept == null || _disposed || loaded || swarms.isNotEmpty) return;
    final shown = <SwarmListing>[];
    for (final swarm in kept) {
      final SuperTabSnapshot snapshot;
      try {
        snapshot = SuperTabSnapshot.fromJson(swarm.view.state);
      } on FormatException {
        continue;
      }
      _readers.putIfAbsent(swarm.id, () => _open(swarm.id))
        ..snapshot = snapshot
        ..partners = swarm.view.partners
        ..buddies = SwarmBuddies.read(swarm.view.state, accountId);
      shown.add((id: swarm.id, name: swarm.name));
    }
    swarms = List.unmodifiable(shown);
    _rebuild(told: true);
  }

  final String accountId;
  final SwarmRequest request;

  /// Handed to each Swarm's reader, for its chats' files.
  final SwarmUpload upload;
  final Duration pollInterval;

  /// The account's Swarms, in the list's order.
  List<SwarmListing> swarms = const [];

  /// What the Swarms ask of the person, across all of them.
  List<SwarmNeed> needs = const [];

  /// What the last read of the list could not do; null once one succeeds.
  String? error;

  /// True once the list has been read.
  bool loaded = false;

  /// Invitations waiting for the person, read only while they have no Swarm.
  List<SwarmInvitation> invitations = const [];

  /// The last read of the invitations failed, while there is no Swarm: not "no invitation".
  /// Those read before stay meanwhile.
  bool invitationsFailed = false;

  /// Invitations being accepted.
  final Set<String> joining = {};

  /// What the last [join] could not do; null once one succeeds.
  String? joinError;

  /// Invitations put off with Not now: not offered again this session, and
  /// left as they are on the server.
  final _putOff = <String>{};

  /// The last read of the list failed for want of a computer to ask.
  bool get noComputer => _away != null;

  /// Accepts [invitation] (the desktop's Tab invites), under one receipt per
  /// invitation so a retry is the same accept, then reads the list.
  Future<bool> join(SwarmInvitation invitation) async {
    if (_disposed || !joining.add(invitation.inviteId)) return false;
    joinError = null;
    notifyListeners();
    try {
      await request(
        'POST',
        '/api/super-tabs/${Uri.encodeComponent(invitation.tabId)}/commands',
        body: {
          'operationId': 'accept-${invitation.inviteId}',
          'command': {'type': 'invite.accept', 'inviteId': invitation.inviteId},
        },
      );
    } on SuperTabFailure catch (failure) {
      joinError = failure.message;
      return false;
    } catch (_) {
      joinError = 'Could not join. Try again.';
      return false;
    } finally {
      joining.remove(invitation.inviteId);
      if (!_disposed) notifyListeners();
    }
    await refresh();
    return true;
  }

  /// Leaves [invitation] for now: it stays on the server, and the start
  /// screen goes on to what else there is.
  void notNow(SwarmInvitation invitation) {
    if (!_putOff.add(invitation.inviteId)) return;
    invitations = List.unmodifiable(
      invitations.where((other) => other.inviteId != invitation.inviteId),
    );
    joinError = null;
    notifyListeners();
  }

  /// The person's invitations; none from a server without the list, which
  /// reads "invitations" as a Swarm's id and answers that it is not found. A
  /// read that fails, or answers anything but the list, throws: it is not "no
  /// invitation" (#1802's review).
  Future<List<SwarmInvitation>> _invitations() async {
    final Object? answer;
    try {
      answer = await request('GET', '/api/super-tabs/invitations');
    } on SuperTabFailure catch (failure) {
      // A server with the invitations never answers them "not found".
      if (failure.statusCode == 404) return const [];
      rethrow;
    }
    if (answer is! List) throw const FormatException('Missing invitations');
    final invitations = <SwarmInvitation>[];
    for (final raw in answer) {
      if (raw
          case {
            'tabId': final String tabId,
            'name': final String name,
            'inviteId': final String inviteId,
          }
          when raw['role'] is String?) {
        if (_putOff.contains(inviteId)) continue;
        invitations.add((
          tabId: tabId,
          name: name,
          inviteId: inviteId,
          role: raw['role'] as String? ?? '',
        ));
      } else {
        throw const FormatException('Invalid invitation');
      }
    }
    return invitations;
  }

  /// An ask or waiting work that arrived after its Swarm's first read: what a
  /// phone notice tells.
  void Function(SwarmNeed need)? onArrived;

  final _readers = <String, SwarmReader>{};
  final _asks = <String, SwarmAsks>{};

  /// Each Swarm's waiting work as last seen: null until its first read, whose
  /// waiting work is not news.
  final _workSeen = <String, Set<String>>{};
  Future<void>? _refreshing;
  Timer? _poll;
  bool _shown = false, _disposed = false;

  /// A read of the list is under way: what its Swarms tell meanwhile is
  /// told once, at its end.
  bool _polling = false;

  /// A Swarm's reader or asks told of a change since the last notify.
  bool _below = false;

  /// While no computer can be asked, the next read comes this soon — 2 seconds, doubling up to
  /// [pollInterval] — so Swarm is back within seconds of one coming up, not at the next poll.
  /// Null once a read gets through.
  Duration? _away;

  /// [id]'s reader, while it is listed.
  SwarmReader? reader(String id) => _readers[id];

  /// [id]'s decisions and tags, while it is listed.
  SwarmAsks? asks(String id) => _asks[id];

  bool get shown => _shown;

  /// One of the account's computers came up: while none could be asked, the
  /// list is read now, not at the next quick try ([_away]) — at a cold start
  /// the socket comes up after the first read failed, and that try was 2 to
  /// 8 seconds off. A read under way is read again once it ends.
  void computerUp() {
    if (_disposed || !_shown || !noComputer) return;
    if (_refreshing case final reading?) {
      unawaited(reading.whenComplete(computerUp));
      return;
    }
    _poll?.cancel();
    _poll = null;
    unawaited(_tick());
  }

  /// On screen (or wanted for notices): reads at once and every
  /// [pollInterval] after. Otherwise reads nothing.
  set shown(bool value) {
    if (_shown == value) return;
    _shown = value;
    _poll?.cancel();
    _poll = null;
    if (value) {
      unawaited(_tick());
    } else {
      _home?.flush(_readers, swarms);
    }
  }

  Future<void> _tick() async {
    await refresh();
    if (_disposed || !_shown) return;
    _poll?.cancel();
    _poll = Timer(_away ?? pollInterval, () => unawaited(_tick()));
  }

  /// One read now, joining one under way.
  Future<void> refresh() {
    if (_disposed) return Future.value();
    return _refreshing ??= _read().whenComplete(() => _refreshing = null);
  }

  /// What a screen draws of the inbox itself: a read that leaves it as it
  /// was tells nobody.
  Object get _face =>
      (swarms, error, loaded, invitations, invitationsFailed, noComputer);

  Future<void> _read() async {
    final before = _face;
    _polling = true;
    try {
      final (:listed, :changedAt) = await _list();
      List<SwarmInvitation>? invited = const [];
      Object? unread;
      if (listed.isEmpty) {
        try {
          invited = await _invitations();
        } catch (failure) {
          (invited, unread) = (null, failure);
        }
      }
      if (_disposed) return;
      if (!listEquals(listed, swarms)) swarms = listed;
      // What was read of them stays while they cannot be read again.
      if (invited != null && !listEquals(invited, invitations)) {
        invitations = invited;
      }
      invitationsFailed = unread != null;
      loaded = true;
      error = null;
      _away = unread is SuperTabFailure && unread.code == 'MACHINE_UNAVAILABLE'
          ? _sooner()
          : null;
      final ids = {for (final swarm in listed) swarm.id};
      for (final id in _readers.keys.toList()) {
        if (!ids.contains(id)) _drop(id);
      }
      for (final swarm in listed) {
        _readers.putIfAbsent(swarm.id, () => _open(swarm.id));
      }
      await Future.wait([
        for (final swarm in listed)
          if (_due(swarm.id, changedAt[swarm.id] ?? 0))
            _readers[swarm.id]!.refresh(),
      ]);
    } on SuperTabFailure catch (failure) {
      if (_disposed) return;
      error = failure.message;
      _away = failure.code == 'MACHINE_UNAVAILABLE' ? _sooner() : null;
    } catch (_) {
      if (_disposed) return;
      error = 'Could not load your Swarms. Try again.';
      _away = null;
    } finally {
      _polling = false;
    }
    _rebuild(told: _face != before);
  }

  /// The next quick read while no computer can be asked ([_away]).
  Duration _sooner() {
    final next = _away == null ? const Duration(seconds: 2) : _away! * 2;
    return next < pollInterval ? next : pollInterval;
  }

  /// Whether a poll reads Swarm [id] again, listed as last changed at
  /// [listedAt]: only when there may be something new. Its last change
  /// moved; it holds no Swarm yet, or its last read failed; or an ask waits
  /// in it, or its asks could not be read — decisions and tags are not
  /// parts, and one answered or done on another device moves no last-change
  /// time.
  bool _due(String id, int listedAt) {
    final reader = _readers[id]!, asks = _asks[id]!;
    final snapshot = reader.snapshot;
    return snapshot == null ||
        reader.error != null ||
        reader.lastChangedAt != listedAt ||
        snapshot.decisionsWaiting > 0 ||
        snapshot.mentionsWaiting > 0 ||
        asks.decisions.isNotEmpty ||
        asks.mentions.isNotEmpty ||
        asks.error != null;
  }

  /// Every page of the list before any is applied: a failed page cannot drop
  /// Swarms (the desktop's `refreshTabs`). With each Swarm's last change, 0
  /// for one never changed.
  Future<({List<SwarmListing> listed, Map<String, int> changedAt})>
  _list() async {
    final listed = <String, SwarmListing>{};
    final changedAt = <String, int>{};
    final cursors = <String>{};
    String? after;
    do {
      final Object? answer;
      try {
        answer = await request(
          'GET',
          '/api/super-tabs/list'
              '${after == null ? '' : '?after=${Uri.encodeQueryComponent(after)}'}',
        );
      } on SuperTabFailure catch (failure) {
        // A server with the list never answers it "not found".
        if (failure.statusCode != 404) rethrow;
        throw SuperTabFailure(
          'SWARM_UNSUPPORTED',
          swarmServerTooOld,
          statusCode: failure.statusCode,
        );
      }
      final page = superTabMap(answer);
      if (page['tabs'] is! List) throw const FormatException('Missing tabs');
      for (final raw in page['tabs'] as List) {
        final row = superTabMap(raw);
        if (row['id'] is! String || row['name'] is! String) {
          throw const FormatException('Invalid tab');
        }
        final id = row['id'] as String;
        listed[id] = (id: id, name: row['name'] as String);
        changedAt[id] = (row['lastChangedAt'] as num?)?.toInt() ?? 0;
      }
      after = page['next'] as String?;
      if (after != null && !cursors.add(after)) {
        throw const FormatException('Repeated tab cursor');
      }
    } while (after != null);
    return (listed: listed.values.toList(), changedAt: changedAt);
  }

  SwarmReader _open(String id) {
    final reader = SwarmReader(
      tabId: id,
      accountId: accountId,
      request: request,
      upload: upload,
    )..addListener(_relay);
    _asks[id] = SwarmAsks(reader)
      ..onArrived = ((ask) => onArrived?.call(switch (ask) {
        final SuperTabDecision decision => SwarmDecisionNeed(id, decision),
        final SuperTabMention mention => SwarmMentionNeed(id, mention),
        _ => throw StateError('Unknown ask $ask'),
      }))
      ..addListener(_asked);
    return reader;
  }

  /// A Swarm off the list: what a screen still holds of it is taken back
  /// ([SwarmReader.revoke]) before it is dropped.
  void _drop(String id) {
    _asks.remove(id)?.dispose();
    _readers.remove(id)
      ?..removeListener(_relay)
      ..revoke()
      ..dispose();
    _workSeen.remove(id);
  }

  /// A Swarm's reader told of a change: what it holds is drawn through the
  /// inbox (Home's projects, the work waiting), so it is told on, once per
  /// list read at most.
  void _relay() {
    _below = true;
    if (!_polling) _rebuild();
  }

  /// A Swarm's asks told of a change: shown at once, poll or not. A Done or
  /// an answer is the person's own tap, and a slow read of another Swarm
  /// must not hold it back.
  void _asked() {
    _below = true;
    _rebuild();
  }

  /// Works out [needs] again; notifies when they, the inbox itself ([told])
  /// or a Swarm below it changed.
  void _rebuild({bool told = false}) {
    if (_disposed) return;
    final decisions = <SwarmNeed>[], mentions = <SwarmNeed>[];
    final work = <SwarmNeed>[];
    for (final MapEntry(key: id, value: reader) in _readers.entries) {
      final snapshot = reader.snapshot;
      if (snapshot == null) continue;
      final asks = _asks[id]!;
      decisions.addAll([
        for (final d in asks.decisions) SwarmDecisionNeed(id, d),
      ]);
      mentions.addAll([for (final m in asks.mentions) SwarmMentionNeed(id, m)]);
      final waiting = [
        for (final w in swarmWaitingWork(
          snapshot,
          accountId,
          partners: reader.partners,
        ))
          SwarmWorkNeed(id, w),
      ];
      final seen = _workSeen[id];
      if (seen != null) {
        for (final need in waiting) {
          if (!seen.contains(need.key)) onArrived?.call(need);
        }
      }
      // The Home kept is not a read: what it shows waiting is not seen.
      if (reader.generation > 0) {
        _workSeen[id] = {for (final need in waiting) need.key};
      }
      work.addAll(waiting);
    }
    int newest(SwarmNeed a, SwarmNeed b) =>
        (_at(b) ?? DateTime(0)).compareTo(_at(a) ?? DateTime(0));
    final next = [
      ...decisions..sort(newest),
      ...mentions..sort(newest),
      ...work,
    ];
    final same = _sameNeeds(next, needs);
    if (!same) needs = List.unmodifiable(next);
    final tell = told || !same || _below;
    _below = false;
    if (!tell) return;
    notifyListeners();
    _home?.keep(_readers, swarms);
  }

  /// The same asks of the same reads, in the same order: decisions and tags
  /// as their [SwarmAsks] keeps them, work of the same snapshot.
  static bool _sameNeeds(List<SwarmNeed> a, List<SwarmNeed> b) {
    if (a.length != b.length) return false;
    for (var n = 0; n < a.length; n++) {
      final same = switch ((a[n], b[n])) {
        (
          SwarmDecisionNeed(decision: final x),
          SwarmDecisionNeed(decision: final y),
        ) =>
          identical(x, y),
        (
          SwarmMentionNeed(mention: final x),
          SwarmMentionNeed(mention: final y),
        ) =>
          identical(x, y),
        (final SwarmWorkNeed x, final SwarmWorkNeed y) =>
          x.key == y.key && identical(x.work.snapshot, y.work.snapshot),
        _ => false,
      };
      if (!same || a[n].swarmId != b[n].swarmId) return false;
    }
    return true;
  }

  static DateTime? _at(SwarmNeed need) => switch (need) {
    SwarmDecisionNeed(:final decision) => decision.createdAt,
    SwarmMentionNeed(:final mention) => mention.createdAt,
    SwarmWorkNeed() => null,
  };

  @override
  void dispose() {
    _disposed = true;
    _poll?.cancel();
    for (final id in _readers.keys.toList()) {
      _drop(id);
    }
    super.dispose();
  }
}
