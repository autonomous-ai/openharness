import 'dart:async';

import 'package:flutter/foundation.dart';

import 'model.dart';
import 'swarm_asks.dart';
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
    this.pollInterval = const Duration(seconds: 15),
  });

  final String accountId;
  final SwarmRequest request;
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

  /// The person's invitations; none from a server without the list, or
  /// when it cannot be read — "No Swarm yet" stays true either way.
  Future<List<SwarmInvitation>> _invitations() async {
    try {
      final answer = await request('GET', '/api/super-tabs/invitations');
      if (answer is! List) return const [];
      return [
        for (final raw in answer)
          if (raw
              case {
                'tabId': final String tabId,
                'name': final String name,
                'inviteId': final String inviteId,
              }
              when !_putOff.contains(inviteId))
            (
              tabId: tabId,
              name: name,
              inviteId: inviteId,
              role: raw['role'] as String? ?? '',
            ),
      ];
    } catch (_) {
      return const [];
    }
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

  /// While no computer can be asked, the next read comes this soon — 2 seconds, doubling up to
  /// [pollInterval] — so Swarm is back within seconds of one coming up, not at the next poll.
  /// Null once a read gets through.
  Duration? _away;

  /// [id]'s reader, while it is listed.
  SwarmReader? reader(String id) => _readers[id];

  /// [id]'s decisions and tags, while it is listed.
  SwarmAsks? asks(String id) => _asks[id];

  bool get shown => _shown;

  /// On screen (or wanted for notices): reads at once and every
  /// [pollInterval] after. Otherwise reads nothing.
  set shown(bool value) {
    if (_shown == value) return;
    _shown = value;
    _poll?.cancel();
    _poll = null;
    if (value) unawaited(_tick());
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

  Future<void> _read() async {
    try {
      final listed = await _list();
      final invited = listed.isEmpty
          ? await _invitations()
          : const <SwarmInvitation>[];
      if (_disposed) return;
      swarms = listed;
      invitations = invited;
      loaded = true;
      error = null;
      _away = null;
      final ids = {for (final swarm in listed) swarm.id};
      for (final id in _readers.keys.toList()) {
        if (!ids.contains(id)) _drop(id);
      }
      for (final swarm in listed) {
        _readers.putIfAbsent(swarm.id, () => _open(swarm.id));
      }
      await Future.wait([for (final r in _readers.values) r.refresh()]);
    } on SuperTabFailure catch (failure) {
      if (_disposed) return;
      error = failure.message;
      final next = _away == null ? const Duration(seconds: 2) : _away! * 2;
      _away = failure.code != 'MACHINE_UNAVAILABLE'
          ? null
          : next < pollInterval
          ? next
          : pollInterval;
    } catch (_) {
      if (_disposed) return;
      error = 'Could not load your Swarms. Try again.';
      _away = null;
    }
    _rebuild();
  }

  /// Every page of the list before any is applied: a failed page cannot drop
  /// Swarms (the desktop's `refreshTabs`).
  Future<List<SwarmListing>> _list() async {
    final listed = <String, SwarmListing>{};
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
      }
      after = page['next'] as String?;
      if (after != null && !cursors.add(after)) {
        throw const FormatException('Repeated tab cursor');
      }
    } while (after != null);
    return listed.values.toList();
  }

  SwarmReader _open(String id) {
    final reader = SwarmReader(
      tabId: id,
      accountId: accountId,
      request: request,
    )..addListener(_rebuild);
    _asks[id] = SwarmAsks(reader)
      ..onArrived = ((ask) => onArrived?.call(switch (ask) {
        final SuperTabDecision decision => SwarmDecisionNeed(id, decision),
        final SuperTabMention mention => SwarmMentionNeed(id, mention),
        _ => throw StateError('Unknown ask $ask'),
      }))
      ..addListener(_rebuild);
    return reader;
  }

  /// A Swarm off the list: what a screen still holds of it is taken back
  /// ([SwarmReader.revoke]) before it is dropped.
  void _drop(String id) {
    _asks.remove(id)?.dispose();
    _readers.remove(id)
      ?..removeListener(_rebuild)
      ..revoke()
      ..dispose();
    _workSeen.remove(id);
  }

  void _rebuild() {
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
      _workSeen[id] = {for (final need in waiting) need.key};
      work.addAll(waiting);
    }
    int newest(SwarmNeed a, SwarmNeed b) =>
        (_at(b) ?? DateTime(0)).compareTo(_at(a) ?? DateTime(0));
    needs = List.unmodifiable([
      ...decisions..sort(newest),
      ...mentions..sort(newest),
      ...work,
    ]);
    notifyListeners();
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
