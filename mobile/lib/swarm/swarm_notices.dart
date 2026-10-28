import 'dart:async';

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
    target: (swarmId: need.swarmId, conversationId: need.conversationId),
  );
}

/// Posts a notice for each need that arrives ([SwarmInbox.onArrived]) unless
/// the person is already looking at it ([quiet]), and takes it down once the
/// need is gone ([settle]): answered on the desktop, done, or no longer
/// waiting.
///
/// The app icon counts the needs, as the drawer's waiting badge does, on each
/// read and whether or not a notice was posted; it is set only when the count
/// changes, and the first read sets it even at zero, over what an earlier run
/// left there.
class SwarmAnnouncer {
  SwarmAnnouncer(this.notices, {required this.quiet});

  final SwarmNotices notices;

  /// The person sees [need] where they are: no notice.
  final bool Function(SwarmNeed need) quiet;

  /// Keys of the notices posted and not yet taken down.
  final _posted = <String>{};

  /// The count on the app icon; null before the first read.
  int? _badge;

  void announce(SwarmNeed need) {
    if (quiet(need)) return;
    final notice = swarmNotice(need);
    _posted.add(notice.key);
    unawaited(notices.showSwarm(notice));
  }

  /// Takes down the notices of needs not in [needs], and counts [needs] on
  /// the app icon.
  void settle(List<SwarmNeed> needs) {
    final open = {for (final need in needs) need.key};
    for (final key in _posted.where((key) => !open.contains(key)).toList()) {
      _posted.remove(key);
      unawaited(notices.cancelSwarm(key));
    }
    if (needs.length != _badge) {
      _badge = needs.length;
      unawaited(notices.setSwarmBadge(needs.length));
    }
  }

  /// Takes every notice and the icon's count down: the account that saw them
  /// signed out, or Swarm was turned off.
  void clear() => settle(const []);
}
