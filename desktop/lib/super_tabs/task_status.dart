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
import 'until.dart';

/// Whether a task is moving, waiting on purpose and for what, or stuck, and
/// what the PM did about it (#957, the mockup Ken approved): the mark beside
/// its row and the line under it. The server records the state (backend
/// liveness.ts); a working task has none, and its time is its agent's last
/// progress. Null for anything else: finished work, a group without work, or
/// a wait an older backend sent no state for.
({HarnessActivity mark, String line, DateTime since})? superTabTaskStatus(
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
      line: age.inMinutes < 1
          ? 'Working · just now'
          : 'Working · ${superTabAgoShort(age)} ago',
      since: since,
    );
  }
  final since = at(liveness['since']);
  final age = now.difference(since).inMinutes < 1
      ? '<1m'
      : superTabAgoShort(now.difference(since));
  final result = (assignment?['result'] as String?)?.trim();
  final asked = result == null || result.isEmpty ? null : result;
  // What the PM did once the task got here: earlier actions are not handling it.
  final acted = group.leadAction;
  final handling =
      acted != null && (acted['at'] as num) >= (liveness['since'] as num)
      ? switch (acted['kind']) {
          'assign' => 'PM reassigned it',
          'route' || 'start' => 'PM retrying',
          'post' => 'PM posted',
          _ => null,
        }
      : null;
  final personId = liveness['personId'] as String?;
  final (mark, head) = switch ((liveness['state'], liveness['why'])) {
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
    ('quiet', _) => (HarnessActivity.failed, 'Quiet $age'),
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
  return (
    mark: mark,
    // The age before what the PM did: a line the sidebar cuts short still
    // says how long, and its row's tooltip has it whole.
    line: [head, if (liveness['state'] != 'quiet') age, ?handling].join(' · '),
    since: since,
  );
}

/// When the age the line shows next changes: its next minute, hour or day.
DateTime _nextChange(DateTime since, DateTime now) {
  final age = now.difference(since);
  final step = age.inHours < 1
      ? const Duration(minutes: 1)
      : age.inDays < 1
      ? const Duration(hours: 1)
      : const Duration(days: 1);
  return since.add(step * (age.inMicroseconds ~/ step.inMicroseconds + 1));
}

/// The line under a task's row; nothing when it has no status.
class SuperTabTaskLine extends StatelessWidget {
  const SuperTabTaskLine(this.group, {super.key, this.personName});
  final SuperTabConversation group;
  final String? Function(String personId)? personName;

  @override
  Widget build(BuildContext context) {
    final status = superTabTaskStatus(
      group,
      clock.now(),
      personName: personName,
    );
    if (status == null) return const SizedBox.shrink();
    // Built again when its age would read differently, even if nothing else changes.
    return SuperTabUntil(
      until: _nextChange(status.since, clock.now()),
      builder: (context) => Text(
        superTabTaskStatus(group, clock.now(), personName: personName)?.line ??
            status.line,
        key: ValueKey('super-task-line-${group.id}'),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: DesktopChrome.metadata(),
      ),
    );
  }
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
