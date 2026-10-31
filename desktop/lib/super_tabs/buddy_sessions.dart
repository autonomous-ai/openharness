import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../state/app_state.dart';
import '../state/harness_activity.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/harness_activity_mark.dart';
import 'controller.dart';
import 'message_row.dart' show SuperTabLink;
import 'model.dart';

// Buddy thread sessions (spec docs/superpowers/specs/2026-10-30-buddy-thread-
// sessions-design.md): a thread of the reader's own Buddy chat may have its own
// Buddy session, answering there while the Buddy keeps answering the chat. What
// shows here is only what changes: which session answers a thread, whether it
// is working, and a quiet way to end it. Status uses the one activity
// vocabulary (HarnessActivity), never a mark of its own.

/// What a session is doing, as the activity vocabulary says it.
typedef SuperTabSessionActivity = HarnessActivity Function(
  SuperTabBuddySession session,
);

/// A session's activity as this computer reads it: starting until its agent
/// joins, offline while its machine reports it gone, else what this computer
/// sees of its terminal, or "Status unavailable" when it sees nothing.
HarnessActivity superTabSessionActivity(
  SuperTabController c,
  AppNotifier? app,
  SuperTabBuddySession session,
) {
  final agent = c.sessionAgent(session);
  if (agent == null) return HarnessActivity.starting;
  if (agent.downSince != null) return HarnessActivity.offline;
  if (app == null) return HarnessActivity.unknown;
  return harnessActivity(app, agent.machineId, agent.harnessId) ??
      HarnessActivity.unknown;
}

/// The words beside a session's mark; offline names its machine ([machine],
/// as people read it) when known.
String superTabSessionWords(HarnessActivity activity, {String? machine}) =>
    switch (activity) {
      HarnessActivity.starting => 'Starting…',
      HarnessActivity.offline =>
        machine != null ? '$machine is offline' : 'Its computer is offline',
      HarnessActivity.idle => 'Idle',
      _ => activity.label,
    };

/// Why a session ended, as its thread says it.
String superTabSessionEndedWords(String? reason) => switch (reason) {
  'idle' => 'Session ended: idle for 30 minutes',
  'ended' => 'Session ended: you ended it',
  'stopped' => 'Session ended: it stopped unexpectedly',
  'failed' => 'Session ended: it couldn\'t start',
  'removed' => 'Session ended: its Buddy was removed or replaced',
  'maintenance' => 'Session ended: Harness was updated',
  _ => 'Session ended',
};

Widget _mark(HarnessActivity activity) => ActivityMark(
  activity: activity,
  tooltip: false,
  showIdle: true,
  color: activityColor(
    activity,
    terminalThemeFor(grid.AppTheme.surfacePalette, terminalThemeStore.value),
    color: appearancePrefsStore.value.prompt.color,
  ),
);

/// The line under the thread pane's header: which session answers the
/// thread and what it is doing, with End session as a quiet text action; or
/// why its last session ended. Nothing for a thread with neither.
class SuperTabThreadSessionLine extends StatefulWidget {
  const SuperTabThreadSessionLine({
    super.key,
    required this.controller,
    required this.root,
    required this.activityOf,
  });

  final SuperTabController controller;
  final String root;
  final SuperTabSessionActivity activityOf;

  @override
  State<SuperTabThreadSessionLine> createState() =>
      _SuperTabThreadSessionLineState();
}

class _SuperTabThreadSessionLineState extends State<SuperTabThreadSessionLine> {
  // The thread an End session is under way for: its answer changes nothing
  // once another thread is shown.
  String? _ending;

  Future<void> _end() async {
    final root = widget.root;
    if (_ending == root) return;
    setState(() => _ending = root);
    await widget.controller.endThreadSession(root);
    if (!mounted || _ending != root) return;
    setState(() => _ending = null);
  }

  @override
  void didUpdateWidget(SuperTabThreadSessionLine old) {
    super.didUpdateWidget(old);
    if (old.root != widget.root) _ending = null;
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final c = widget.controller;
    final session = c.threadSession(widget.root);
    final Widget line;
    if (session != null) {
      final activity = widget.activityOf(session);
      final machineId = c.sessionAgent(session)?.machineId;
      final machine = machineId == null
          ? null
          : c.sessionMachineName(machineId);
      final words =
          'Own session · ${superTabSessionWords(activity, machine: machine)}';
      line = Row(
        children: [
          _mark(activity),
          const SizedBox(width: grid.AppDesktop.controlGap),
          Expanded(
            child: Text(
              words,
              key: const ValueKey('super-thread-session-state'),
              style: DesktopChrome.control(),
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (c.canWrite)
            SuperTabLink(
              key: const ValueKey('super-thread-session-end'),
              label: _ending == widget.root ? 'Ending session' : 'End session',
              // Disabled while its end is on its way: pointer, keyboard and
              // screen readers alike.
              onTap: _ending == widget.root ? null : () => unawaited(_end()),
              child: Text(
                _ending == widget.root ? 'Ending…' : 'End session',
                style: DesktopChrome.control(color: DesktopChrome.muted),
              ),
            ),
        ],
      );
    } else if (c.threadSessionEnded(widget.root) case final ended?) {
      line = Text(
        superTabSessionEndedWords(ended.sessionEndReason),
        key: const ValueKey('super-thread-session-ended'),
        style: DesktopChrome.control(color: DesktopChrome.muted),
      );
    } else {
      return const SizedBox.shrink();
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: grid.AppDesktop.groupGap,
            vertical: grid.AppDesktop.controlGap,
          ),
          child: line,
        ),
        Divider(height: 1, thickness: 1, color: DesktopChrome.rim),
      ],
    );
  }
}

/// " · ⠋ Own session" at the end of a thread's line in the chat, while the
/// thread has a session of its own; "⠋ Own session · Starting…" as the whole
/// line ([alone]) while its thread has no reply yet.
class SuperTabThreadSessionMark extends StatelessWidget {
  const SuperTabThreadSessionMark({
    super.key,
    required this.activity,
    this.alone = false,
  });

  final HarnessActivity activity;
  final bool alone;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Semantics(
      label: 'Own session, ${superTabSessionWords(activity)}',
      excludeSemantics: true,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (!alone) Text(' · ', style: DesktopChrome.metadata()),
          _mark(activity),
          const SizedBox(width: grid.AppDesktop.menuInset),
          Text(
            alone
                ? 'Own session · ${superTabSessionWords(activity)}'
                : 'Own session',
            style: DesktopChrome.metadata(),
          ),
        ],
      ),
    );
  }
}
