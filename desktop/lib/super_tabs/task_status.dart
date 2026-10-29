import 'dart:async';
import 'dart:math' as math;

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../state/harness_activity.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/harness_activity_mark.dart';
import 'machine_status.dart';
import 'model.dart';

/// A task's status: its mark, and its line in three parts, so a row too
/// narrow for all of it cuts the [reason] and never the [age]: ages are what
/// tell a stuck task from a new one. [pm] is what the PM did once the task
/// got here, and when.
typedef SuperTabTaskStatus = ({
  HarnessActivity mark,
  String reason,
  String age,
  String? pm,
  DateTime since,
  DateTime? pmAt,
});

/// The line as one string, for a tooltip.
String superTabTaskStatusText(SuperTabTaskStatus status) =>
    '${status.reason}${status.age}${status.pm == null ? '' : ' · ${status.pm}'}';

String _span(Duration age) => age.inMinutes < 1 ? '<1m' : superTabAgoShort(age);

String _ago(Duration age) =>
    age.inMinutes < 1 ? 'just now' : '${superTabAgoShort(age)} ago';

/// Whether a task is moving, waiting on purpose and for what, or stuck, and
/// what the PM did about it (#957, the mockup Ken approved). The server
/// records the state (backend liveness.ts); a working task has none, and its
/// time is its agent's last progress. Null for anything else: finished work,
/// a group without work, or a wait an older backend sent no state for.
SuperTabTaskStatus? superTabTaskStatus(
  SuperTabConversation group,
  DateTime now, {
  String? Function(String personId)? personName,
}) {
  final assignment = group.assignment;
  final liveness = group.liveness;
  DateTime at(Object? ms) =>
      DateTime.fromMillisecondsSinceEpoch((ms as num).toInt(), isUtc: true);
  if (liveness == null) {
    final progress = assignment?['progressAt'];
    if (!const {'working', 'planned'}.contains(assignment?['status']) ||
        progress is! num) {
      return null;
    }
    final since = at(progress);
    final age = now.difference(since);
    return (
      mark: HarnessActivity.working,
      reason: 'Working',
      age: ' · ${_ago(age)}',
      pm: null,
      since: since,
      pmAt: null,
    );
  }
  final since = at(liveness['since']);
  final result = (assignment?['result'] as String?)?.trim();
  final asked = result == null || result.isEmpty ? null : result;
  // What the PM did once the task got here: earlier actions are not handling it.
  final acted = group.leadAction;
  final pmAt =
      acted != null && (acted['at'] as num) >= (liveness['since'] as num)
      ? at(acted['at'])
      : null;
  final pmDid = pmAt == null
      ? null
      : switch (acted!['kind']) {
          'assign' => 'PM reassigned it',
          'route' || 'start' => 'PM retrying',
          'post' => 'PM posted',
          _ => null,
        };
  final personId = liveness['personId'] as String?;
  final (mark, reason) = switch ((liveness['state'], liveness['why'])) {
    ('waiting', 'person') => (
      HarnessActivity.needsInput,
      [
        'Waiting on ${(personId == null ? null : personName?.call(personId)) ?? 'a person'}',
        ?asked,
      ].join(' · '),
    ),
    ('waiting', 'review') => (HarnessActivity.needsInput, 'Waiting for review'),
    ('waiting', 'revision') => (
      HarnessActivity.needsInput,
      'Waiting for the new revision',
    ),
    ('waiting', 'blocked') => (
      HarnessActivity.needsInput,
      ['Blocked', ?asked].join(' · '),
    ),
    ('waiting', 'queued') => (
      HarnessActivity.unknown,
      'Queued: no free machine',
    ),
    ('waiting', 'starting') => (HarnessActivity.starting, 'Starting its agent'),
    ('quiet', _) => (HarnessActivity.failed, 'Quiet'),
    ('orphaned', 'removed') => (
      HarnessActivity.failed,
      'Stuck: its agent was removed',
    ),
    ('orphaned', 'lost') => (
      HarnessActivity.failed,
      'Stuck: its agent stopped',
    ),
    ('orphaned', 'start-failed') => (
      HarnessActivity.failed,
      'Stuck: its agent could not start',
    ),
    ('orphaned', _) => (
      HarnessActivity.failed,
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

/// Builds [builder] with [group]'s status, and again whenever one of its ages
/// would read differently, even when nothing else changes on the page: each
/// row keeps one timer, cancelled with it.
class SuperTabTaskClock extends StatefulWidget {
  const SuperTabTaskClock({
    super.key,
    required this.group,
    this.personName,
    required this.builder,
  });
  final SuperTabConversation group;
  final String? Function(String personId)? personName;
  final Widget Function(BuildContext context, SuperTabTaskStatus? status)
  builder;

  @override
  State<SuperTabTaskClock> createState() => _SuperTabTaskClockState();
}

class _SuperTabTaskClockState extends State<SuperTabTaskClock> {
  Timer? _timer;

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final now = clock.now();
    final status = superTabTaskStatus(
      widget.group,
      now,
      personName: widget.personName,
    );
    _timer?.cancel();
    _timer = null;
    if (status != null) {
      final next = [
        _nextChange(status.since, now),
        if (status.pmAt case final pmAt?) _nextChange(pmAt, now),
      ].reduce((a, b) => a.isBefore(b) ? a : b);
      _timer = Timer(
        next.difference(now) + const Duration(milliseconds: 1),
        () {
          if (mounted) setState(() {});
        },
      );
    }
    return widget.builder(context, status);
  }
}

/// A task's line, drawn from its [status]: the reason cut first, the age
/// always whole, and what the PM did in the room left.
class SuperTabTaskLineView extends StatelessWidget {
  const SuperTabTaskLineView(this.status, {super.key});
  final SuperTabTaskStatus status;

  @override
  Widget build(BuildContext context) {
    final style = DesktopChrome.metadata();
    Text part(String text) =>
        Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: style);
    return Row(
      children: [
        Flexible(child: part(status.reason)),
        Text(status.age, maxLines: 1, softWrap: false, style: style),
        if (status.pm case final pm?) Flexible(child: part(' · $pm')),
      ],
    );
  }
}

/// The line under a task's row, kept current by its own clock; nothing when
/// it has no status.
class SuperTabTaskLine extends StatelessWidget {
  const SuperTabTaskLine(this.group, {super.key, this.personName});
  final SuperTabConversation group;
  final String? Function(String personId)? personName;

  @override
  Widget build(BuildContext context) => SuperTabTaskClock(
    group: group,
    personName: personName,
    builder: (context, status) => status == null
        ? const SizedBox.shrink()
        : SuperTabTaskLineView(
            status,
            key: ValueKey('super-task-line-${group.id}'),
          ),
  );
}

/// The activity mark beside a task's row; the line under it says the same in
/// words, so screen readers hear the line and colour is never the only signal.
class SuperTabTaskMark extends StatelessWidget {
  const SuperTabTaskMark(this.group, {super.key});
  final SuperTabConversation group;

  @override
  Widget build(BuildContext context) {
    final status = superTabTaskStatus(group, clock.now());
    if (status == null) return const SizedBox.shrink();
    final theme = terminalThemeFor(
      grid.AppTheme.surfacePalette,
      terminalThemeStore.value,
    );
    return ExcludeSemantics(
      child: ActivityMark(
        key: ValueKey('super-task-mark-${group.id}'),
        activity: status.mark,
        tooltip: false,
        color: activityColor(
          status.mark,
          theme,
          color: appearancePrefsStore.value.prompt.color,
        ),
      ),
    );
  }
}
