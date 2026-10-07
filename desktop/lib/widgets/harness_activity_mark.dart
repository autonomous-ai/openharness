import 'dart:async';

import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart' show TerminalTheme;

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/theme/workspace_bar_style.dart';
import '../state/app_state.dart';
import '../state/harness_activity.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';

Color activityColor(
  HarnessActivity state,
  TerminalTheme theme, {
  bool color = true,
}) {
  if (!color) return theme.foreground;
  return switch (state) {
    HarnessActivity.needsInput || HarnessActivity.starting => theme.yellow,
    HarnessActivity.failed => theme.red,
    HarnessActivity.done => theme.green,
    HarnessActivity.working => theme.cyan,
    _ => theme.foreground.withValues(alpha: .55),
  };
}

/// One clock for visible Flutter marks, aligned with hn and AppKit's Unix-time
/// frames. No listeners means no timer; background apps do not keep ticking.
class ActivityClock extends ChangeNotifier with WidgetsBindingObserver {
  ActivityClock({DateTime Function()? now}) : now = now ?? DateTime.now;
  final DateTime Function() now;
  Timer? _timer;
  int? _lastFrame;
  bool _observing = false;
  int get frame => activityFrameAt(now());
  bool get running => _timer != null;

  @override
  void addListener(VoidCallback listener) {
    super.addListener(listener);
    if (!_observing) {
      WidgetsBinding.instance.addObserver(this);
      _observing = true;
    }
    _schedule();
  }

  @override
  void removeListener(VoidCallback listener) {
    super.removeListener(listener);
    if (!hasListeners) {
      _timer?.cancel();
      _timer = null;
      _lastFrame = null;
      WidgetsBinding.instance.removeObserver(this);
      _observing = false;
    }
  }

  void _schedule() {
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    if (!hasListeners ||
        (lifecycle != null && lifecycle != AppLifecycleState.resumed)) {
      _timer?.cancel();
      _timer = null;
      return;
    }
    if (_timer != null) return;
    _lastFrame ??= frame;
    final interval = activityFrameInterval.inMilliseconds;
    _timer = Timer(
      Duration(
        milliseconds: interval - now().millisecondsSinceEpoch % interval,
      ),
      () {
        _timer = null;
        final next = frame;
        if (next != _lastFrame) {
          _lastFrame = next;
          notifyListeners();
        }
        _schedule();
      },
    );
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) => _schedule();

  @override
  void dispose() {
    _timer?.cancel();
    _timer = null;
    if (_observing) WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
}

final _activityClock = ActivityClock();

/// One status cell, with a stable semantic label outside the animated subtree.
/// Only this repaint boundary changes on a tick, never the terminal or tab.
class ActivityMark extends StatefulWidget {
  const ActivityMark({
    super.key,
    required this.activity,
    required this.color,
    this.visible = true,
    this.emphasized = false,
    this.tooltip = true,
    this.clock,
  });
  final HarnessActivity activity;
  final Color color;
  final bool visible, emphasized, tooltip;
  final ActivityClock? clock;

  @override
  State<ActivityMark> createState() => _ActivityMarkState();
}

class _ActivityMarkState extends State<ActivityMark> {
  ActivityClock get clock => widget.clock ?? _activityClock;
  bool _listening = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(ActivityMark oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.clock != widget.clock && _listening) {
      (oldWidget.clock ?? _activityClock).removeListener(_tick);
      _listening = false;
    }
    _sync();
  }

  void _sync() {
    final listen =
        widget.activity == HarnessActivity.working &&
        widget.visible &&
        TickerMode.valuesOf(context).enabled &&
        !MediaQuery.disableAnimationsOf(context);
    if (listen == _listening) return;
    _listening = listen;
    if (listen) {
      clock.addListener(_tick);
    } else {
      clock.removeListener(_tick);
    }
  }

  void _tick() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    if (_listening) clock.removeListener(_tick);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final mark = _listening
        ? activitySpinnerFrames[clock.frame]
        : widget.activity.mark;
    final cell = workspaceBarCellSizeOf(context);
    final style =
        workspaceBarTextStyle(
          color: widget.color,
          emphasized: widget.emphasized,
        ).copyWith(
          fontFamilyFallback: [
            ...?workspaceBarTextStyle().fontFamilyFallback,
            // SF Mono and Menlo lack Braille; the fixed cell still uses
            // workspace metrics while the OS symbol font supplies dots.
            'Apple Symbols',
            'DejaVu Sans',
          ],
        );
    final child = Semantics(
      label: widget.activity.label,
      child: ExcludeSemantics(
        child: RepaintBoundary(
          child: SizedBox(
            width: cell.width,
            child: Text(
              mark,
              textAlign: TextAlign.center,
              maxLines: 1,
              overflow: TextOverflow.clip,
              style: style,
            ),
          ),
        ),
      ),
    );
    return widget.tooltip
        ? Tooltip(message: widget.activity.label, child: child)
        : child;
  }
}

/// Pane headers listen to activity and acknowledgement independently of their
/// cached title/controls, so a turn or unread change never rebuilds a terminal.
class HarnessActivityMark extends StatelessWidget {
  const HarnessActivityMark({
    super.key,
    required this.app,
    required this.machineId,
    required this.agentId,
    this.visible = true,
  });
  final AppNotifier app;
  final String machineId, agentId;
  final bool visible;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([
        app,
        app.agentUnread,
        terminalThemeStore,
        appearancePrefsStore,
      ]),
      builder: (context, _) {
        final state = harnessActivity(app, machineId, agentId);
        if (state == null) return const SizedBox.shrink();
        final theme = terminalThemeFor(
          grid.AppTheme.palette.value,
          terminalThemeStore.value,
        );
        return Padding(
          padding: EdgeInsets.only(left: workspaceBarCellSizeOf(context).width),
          child: ActivityMark(
            activity: state,
            color: activityColor(
              state,
              theme,
              color: appearancePrefsStore.value.prompt.color,
            ),
            visible:
                visible &&
                !app.activeSwarm.isStore &&
                !app.activeSwarm.isOrchestrator,
          ),
        );
      },
    );
  }
}
