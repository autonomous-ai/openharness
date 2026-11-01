import 'dart:async';

import 'package:flutter/foundation.dart';

import '../notify/system_notices.dart';
import 'swarm_inbox.dart';

/// The notice that tells the person about [need]: who asks, and in which
/// project.
///
/// A notice can be read on a locked phone, and neither platform lets this app
/// hide one part of it there for sure: so what is asked, and the conversation
/// it is in, are read in the app only (Lead, 2026-10-27). The one place to
/// change if notices may say more.
SwarmNoticeMessage swarmNotice(SwarmNeed need) {
  final (title, project, body) = switch (need) {
    SwarmDecisionNeed(:final decision) => (
      '${decision.askerName} asks you',
      decision.projectName,
      'Open Harness to answer.',
    ),
    SwarmMentionNeed(:final mention) => (
      '${mention.leadName} tagged you',
      mention.projectName,
      'Open Harness to read it.',
    ),
    SwarmWorkNeed(:final work) when work.status == 'blocked' => (
      '${work.agentName} is stuck',
      work.project.name,
      'Open Harness to see why.',
    ),
    SwarmWorkNeed(:final work) => (
      '${work.agentName} needs you',
      work.project.name,
      'Open Harness to answer.',
    ),
  };
  return (
    key: need.key,
    title: title,
    subtitle: project,
    body: body,
    target: (
      swarmId: need.swarmId,
      conversationId: need.conversationId,
      messageId: need is SwarmMentionNeed ? need.mention.messageId : null,
      decisionId: need is SwarmDecisionNeed ? need.decision.id : null,
    ),
  );
}

/// Posts a notice for each need that arrives ([SwarmInbox.onArrived]) unless
/// the person is already looking at it ([quiet]), and takes it down once the
/// need is gone: answered on the desktop, done, or no longer waiting — missing
/// from two reads of its Swarm in a row ([swarmRead]), as one read may miss
/// it and the next have it again. One whose Swarm can no longer be read goes
/// at once ([settle]).
///
/// The app icon counts the needs, as the drawer's waiting badge does, on each
/// read and whether or not a notice was posted; it is set only when the count
/// changes, and the first read sets it even at zero, over what an earlier run
/// left there.
class SwarmAnnouncer {
  SwarmAnnouncer(this.notices, {required this.quiet, SwarmTold? told})
    : told = told ?? SwarmTold();

  final SwarmNotices notices;

  /// The person sees [need] where they are: no notice.
  final bool Function(SwarmNeed need) quiet;

  /// What this phone has told the account already: never told again.
  final SwarmTold told;

  /// The notices posted and not yet taken down: each key's Swarm.
  final _posted = <String, String>{};

  /// Posted notices whose need the last reads of its Swarm missed: how many
  /// in a row.
  final _missed = <String, int>{};

  /// The count on the app icon; null before the first read.
  int? _badge;

  /// Posts [need]'s notice, once: a need that left a read and came back
  /// (another way of reading answered without it, or the session was made
  /// again) is not news (Dee's iPhone, 2026-11-01: one notice every 5
  /// seconds).
  void announce(SwarmNeed need) {
    if (quiet(need)) return;
    if (!told.add(need.key)) return;
    final notice = swarmNotice(need);
    _posted[notice.key] = need.swarmId;
    _missed.remove(notice.key);
    unawaited(notices.showSwarm(notice));
  }

  /// The needs as they are now ([needs]), counted on the app icon. A notice
  /// whose need is back is no longer missed; one whose Swarm is not among
  /// [readable] (off the account's list, or its access gone) is taken down at
  /// once. [readable] null: the list is not read yet, and nothing goes.
  void settle(List<SwarmNeed> needs, {Set<String>? readable}) {
    final open = {for (final need in needs) need.key};
    for (final MapEntry(key: key, value: swarm) in _posted.entries.toList()) {
      if (open.contains(key)) {
        _missed.remove(key);
      } else if (readable != null && !readable.contains(swarm)) {
        _takeDown(key);
      }
    }
    if (needs.length != _badge) {
      _badge = needs.length;
      unawaited(notices.setSwarmBadge(needs.length));
    }
  }

  /// Swarm [swarmId] was read, and [needs] are what waits now: a notice of
  /// its whose need this read missed, as the one before did, is taken down.
  void swarmRead(String swarmId, List<SwarmNeed> needs) {
    final open = {for (final need in needs) need.key};
    for (final MapEntry(key: key, value: swarm) in _posted.entries.toList()) {
      if (swarm != swarmId) continue;
      if (open.contains(key)) {
        _missed.remove(key);
        continue;
      }
      final missed = (_missed[key] ?? 0) + 1;
      if (missed >= 2) {
        _takeDown(key);
      } else {
        _missed[key] = missed;
      }
    }
  }

  void _takeDown(String key) {
    _posted.remove(key);
    _missed.remove(key);
    unawaited(notices.cancelSwarm(key));
  }

  /// Takes every notice and the icon's count down: the account that saw them
  /// signed out, or Swarm was turned off.
  void clear() {
    for (final key in _posted.keys.toList()) {
      _takeDown(key);
    }
    settle(const []);
  }
}

/// The notices this phone has posted for one account, by their keys
/// ([SwarmNeed.key]: the decision's or tag's id, or the work's assignment and
/// status): what [SwarmAnnouncer] never posts twice, however often its need
/// leaves the reads and comes back. [SwarmHost] keeps one for the life of the
/// app, so a session made again for the same account remembers too.
///
/// In memory only, ids only, at most [limit] keys, the oldest let go first.
/// Another account starts it over ([account]).
class SwarmTold {
  SwarmTold({this.limit = 500});

  final int limit;

  /// Kept in the order told: a set literal is a [LinkedHashSet].
  final _keys = <String>{};
  String? _account;

  /// Records [key]; false when it was told already.
  bool add(String key) {
    if (!_keys.add(key)) return false;
    while (_keys.length > limit) {
      _keys.remove(_keys.first);
    }
    return true;
  }

  /// Whose notices these are: another account, or none (Swarm turned off),
  /// forgets every key.
  set account(String? id) {
    if (id == _account) return;
    _account = id;
    _keys.clear();
  }

  @visibleForTesting
  int get length => _keys.length;
}

/// Takes the app icon's count off each time [app] finds nobody signed in
/// ([signedOut]), and at once if it already knows. A launch that starts
/// signed out never makes a Swarm session, whose end ([SwarmAnnouncer.clear])
/// would have taken the last account's count off. Lives as long as [app].
void swarmBadgeOffWhileSignedOut(
  Listenable app, {
  required bool Function() signedOut,
  required SwarmNotices notices,
}) {
  var off = false;
  void check() {
    final now = signedOut();
    if (now && !off) unawaited(notices.setSwarmBadge(0));
    off = now;
  }

  app.addListener(check);
  check();
}
