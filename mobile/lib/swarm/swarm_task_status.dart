import 'dart:async';
import 'dart:math' as math;

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'model.dart';

/// A task's mark, named as the desktop's activity marks are
/// (`desktop/lib/super_tabs/task_status.dart`), drawn on the phone as a
/// dot in its colour ([swarmTaskMarkColor]).
enum SwarmTaskMark { working, needsInput, starting, failed, unknown }

/// The colour of a task's dot, from the phone's tokens: working green,
/// waiting or starting yellow, stuck red, queued faint — as an agent's state
/// is drawn ([swarmStateColor]).
Color swarmTaskMarkColor(SwarmTaskMark mark) => switch (mark) {
  SwarmTaskMark.working => AppColors.success,
  SwarmTaskMark.needsInput || SwarmTaskMark.starting => AppColors.warning,
  SwarmTaskMark.failed => AppColors.danger,
  SwarmTaskMark.unknown => AppPalette.textFaint,
};

/// A task's status: its mark, and its line in three parts, so a row too
/// narrow for all of it cuts the [reason] and never the [age]: ages are what
/// tell a stuck task from a new one. [pm] is what the PM did once the task
/// got here, and when. The desktop's `SuperTabTaskStatus`.
typedef SwarmTaskStatus = ({
  SwarmTaskMark mark,
  String reason,
  String age,
  String? pm,
  DateTime since,
  DateTime? pmAt,
});

/// The line as one string.
String swarmTaskStatusText(SwarmTaskStatus status) =>
    '${status.reason}${status.age}${status.pm == null ? '' : ' · ${status.pm}'}';

/// "12s", "4m", "3h", "2d", as the desktop's `superTabAgoShort`.
String _short(Duration age) {
  if (age.inSeconds < 60) return '${math.max(0, age.inSeconds)}s';
  if (age.inMinutes < 60) return '${age.inMinutes}m';
  if (age.inHours < 24) return '${age.inHours}h';
  return '${age.inDays}d';
}

String _span(Duration age) => age.inMinutes < 1 ? '<1m' : _short(age);

String _ago(Duration age) =>
    age.inMinutes < 1 ? 'just now' : '${_short(age)} ago';

DateTime _at(num ms) =>
    DateTime.fromMillisecondsSinceEpoch(ms.toInt(), isUtc: true);

/// Whether a task is moving, waiting on purpose and for what, or stuck, and
/// what the PM did about it: the desktop's `superTabTaskStatus`, word for
/// word (desktop parity in swarm_task_status_test). The server records the
/// state (backend liveness.ts); a working task has none, and its time is its
/// agent's last progress. Null for anything else: finished work, a group
/// without work, a wait an older backend sent no state for — and, where the
/// desktop would throw, a state whose time or kind is not what the server
/// sends: the phone draws nothing rather than a guess.
///
/// It reads [group] alone. A person waited on is named by [personName],
/// which looks only in the read [group] came with; anyone it does not name
/// is "a person".
SwarmTaskStatus? swarmTaskStatus(
  SuperTabConversation group,
  DateTime now, {
  String? Function(String personId)? personName,
}) {
  final assignment = group.assignment;
  final liveness = group.liveness;
  if (liveness == null) {
    final progress = assignment?['progressAt'];
    if (!const {'working', 'planned'}.contains(assignment?['status']) ||
        progress is! num) {
      return null;
    }
    final since = _at(progress);
    return (
      mark: SwarmTaskMark.working,
      reason: 'Working',
      age: ' · ${_ago(now.difference(since))}',
      pm: null,
      since: since,
      pmAt: null,
    );
  }
  final sinceMs = liveness['since'];
  if (sinceMs is! num) return null;
  final since = _at(sinceMs);
  final result = switch (assignment?['result']) {
    final String text when text.trim().isNotEmpty => text.trim(),
    _ => null,
  };
  // What the PM did once the task got here: earlier actions are not handling
  // it.
  final acted = group.leadAction;
  final pmAt = switch (acted?['at']) {
    final num at when at >= sinceMs => _at(at),
    _ => null,
  };
  final pmDid = pmAt == null
      ? null
      : switch (acted!['kind']) {
          'assign' => 'PM reassigned it',
          'route' || 'start' => 'PM retrying',
          'post' => 'PM posted',
          _ => null,
        };
  final personId = switch (liveness['personId']) {
    final String id => id,
    _ => null,
  };
  final (mark, reason) = switch ((liveness['state'], liveness['why'])) {
    ('waiting', 'person') => (
      SwarmTaskMark.needsInput,
      [
        'Waiting on ${(personId == null ? null : personName?.call(personId)) ?? 'a person'}',
        ?result,
      ].join(' · '),
    ),
    ('waiting', 'review') => (SwarmTaskMark.needsInput, 'Waiting for review'),
    ('waiting', 'revision') => (
      SwarmTaskMark.needsInput,
      'Waiting for the new revision',
    ),
    ('waiting', 'blocked') => (
      SwarmTaskMark.needsInput,
      ['Blocked', ?result].join(' · '),
    ),
    ('waiting', 'queued') => (SwarmTaskMark.unknown, 'Queued: no free machine'),
    ('waiting', 'starting') => (SwarmTaskMark.starting, 'Starting its agent'),
    ('quiet', _) => (SwarmTaskMark.failed, 'Quiet'),
    ('orphaned', 'removed') => (
      SwarmTaskMark.failed,
      'Stuck: its agent was removed',
    ),
    ('orphaned', 'lost') => (SwarmTaskMark.failed, 'Stuck: its agent stopped'),
    ('orphaned', 'start-failed') => (
      SwarmTaskMark.failed,
      'Stuck: its agent could not start',
    ),
    ('orphaned', _) => (
      SwarmTaskMark.failed,
      'Stuck: its agent has not started',
    ),
    _ => (null, ''),
  };
  if (mark == null) return null;
  final span = _span(now.difference(since));
  return (
    mark: mark,
    reason: reason,
    // As the mockup reads: "Quiet 34m", every other state "… · 12m".
    age: liveness['state'] == 'quiet' ? ' $span' : ' · $span',
    pm: pmDid == null ? null : '$pmDid ${_ago(now.difference(pmAt!))}',
    since: since,
    pmAt: pmDid == null ? null : pmAt,
  );
}

/// When an age [from] shows next reads differently: its next minute, hour or
/// day.
DateTime _nextChange(DateTime from, DateTime now) {
  final age = now.difference(from);
  final step = age.inHours < 1
      ? const Duration(minutes: 1)
      : age.inDays < 1
      ? const Duration(hours: 1)
      : const Duration(days: 1);
  return from.add(
    step * (math.max(0, age.inMicroseconds) ~/ step.inMicroseconds + 1),
  );
}

/// The line under a task's row: its dot, then its words — the reason cut
/// first, the age always whole, what the PM did in the room left — kept
/// current by one timer of its own, cancelled with the row, that wakes when
/// one of its ages would read differently. [lead] goes before the reason and
/// gives way with it, as a project's work row names its agent. Nothing when
/// the task has no status ([swarmTaskStatus]).
class SwarmTaskLine extends StatefulWidget {
  const SwarmTaskLine(this.group, {super.key, this.personName, this.lead});

  final SuperTabConversation group;
  final String? Function(String personId)? personName;
  final String? lead;

  @override
  State<SwarmTaskLine> createState() => _SwarmTaskLineState();
}

class _SwarmTaskLineState extends State<SwarmTaskLine> {
  Timer? _timer;

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final now = clock.now();
    final status = swarmTaskStatus(
      widget.group,
      now,
      personName: widget.personName,
    );
    _timer?.cancel();
    _timer = null;
    if (status == null) return const SizedBox.shrink();
    final next = [
      _nextChange(status.since, now),
      if (status.pmAt case final pmAt?) _nextChange(pmAt, now),
    ].reduce((a, b) => a.isBefore(b) ? a : b);
    _timer = Timer(next.difference(now) + const Duration(milliseconds: 1), () {
      if (mounted) setState(() {});
    });
    final style = AppType.caption(
      color: AppPalette.textSecondary,
      height: 1.35,
    );
    Text part(String text) =>
        Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: style);
    final id = widget.group.id;
    return Row(
      key: ValueKey('swarm-task-line-$id'),
      children: [
        // The words say what the dot shows: colour is never the only signal.
        ExcludeSemantics(
          child: Text(
            '● ',
            key: ValueKey('swarm-task-mark-$id'),
            style: style.copyWith(color: swarmTaskMarkColor(status.mark)),
          ),
        ),
        Flexible(
          child: part(
            widget.lead == null
                ? status.reason
                : '${widget.lead} · ${status.reason}',
          ),
        ),
        Text(status.age, maxLines: 1, softWrap: false, style: style),
        if (status.pm case final pm?) Flexible(child: part(' · $pm')),
      ],
    );
  }
}
