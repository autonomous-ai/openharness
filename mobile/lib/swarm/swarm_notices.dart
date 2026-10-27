import 'dart:async';

import '../notify/system_notices.dart';
import 'swarm_inbox.dart';

/// The notice that tells the person about [need]: who asks, where, and what —
/// the desktop's tag notice in the phone's three lines.
SwarmNoticeMessage swarmNotice(SwarmNeed need) {
  final target = (swarmId: need.swarmId, conversationId: need.conversationId);
  return switch (need) {
    SwarmDecisionNeed(:final decision) => (
      key: need.key,
      title: '${decision.askerName} asks you',
      subtitle: _where(decision.projectName, decision.conversationTitle),
      body: decision.question,
      target: target,
    ),
    SwarmMentionNeed(:final mention) => (
      key: need.key,
      title: '${mention.leadName} tagged you',
      subtitle: _where(mention.projectName, mention.conversationTitle),
      body: mention.text,
      target: target,
    ),
    SwarmWorkNeed(:final work) => (
      key: need.key,
      title: work.status == 'blocked'
          ? '${work.agentName} is stuck'
          : '${work.agentName} needs you',
      subtitle: _where(work.project.name, work.conversation.label),
      body:
          work.question ??
          (work.status == 'blocked'
              ? 'Open it to see why.'
              : 'Open it to answer.'),
      target: target,
    ),
  };
}

String _where(String project, String conversation) =>
    [project, conversation].where((part) => part.isNotEmpty).join(' · ');

/// Posts a notice for each need that arrives ([SwarmInbox.onArrived]) unless
/// the person is already looking at it ([quiet]), and takes it down once the
/// need is gone ([settle]): answered on the desktop, done, or no longer
/// waiting.
class SwarmAnnouncer {
  SwarmAnnouncer(this.notices, {required this.quiet});

  final SwarmNotices notices;

  /// The person sees [need] where they are: no notice.
  final bool Function(SwarmNeed need) quiet;

  /// Keys of the notices posted and not yet taken down.
  final _posted = <String>{};

  void announce(SwarmNeed need) {
    if (quiet(need)) return;
    final notice = swarmNotice(need);
    _posted.add(notice.key);
    unawaited(notices.showSwarm(notice));
  }

  /// Takes down the notices of needs not in [needs].
  void settle(Iterable<SwarmNeed> needs) {
    final open = {for (final need in needs) need.key};
    for (final key in _posted.where((key) => !open.contains(key)).toList()) {
      _posted.remove(key);
      unawaited(notices.cancelSwarm(key));
    }
  }

  /// Takes every notice down: the account that saw them signed out.
  void clear() => settle(const []);
}
