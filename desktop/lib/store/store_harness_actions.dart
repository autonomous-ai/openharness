import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:harness/terminal/terminal_text.dart';

import '../core/models.dart';
import '../core/harness_catalog.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_menu.dart';
import '../state/app_state.dart';
import '../state/swarm_navigation.dart';

/// A running harness, not a package installation. The machine is part of its
/// identity: two daemons can legitimately use the same agent id.
class StoreResumeTarget {
  const StoreResumeTarget(this.machine, this.agent);

  final MachineState machine;
  final Agent agent;
  String get machineId => machine.machine.machineId;
  String get destinationId => agentDestinationId(machineId, agent.id);
  String get title => agent.name;
  String get detail => [
    machine.machine.displayName,
    if (agent.project case final project?) project.name,
  ].join(' · ');
  String get tooltip => [
    title,
    machine.machine.displayName,
    if (agent.project case final project?) project.cwd,
  ].join('\n');
}

List<StoreResumeTarget> storeResumeTargets(
  AppNotifier app,
  String harnessId, {
  List<String> recent = const [],
}) {
  final open = {
    for (final pane in app.allPanes)
      if (pane.agentId != null)
        agentDestinationId(pane.machineId, pane.agentId!),
  };
  final targets = <String, StoreResumeTarget>{};
  for (final machine in app.machineStates.values) {
    for (final agent in machine.agents) {
      // A Blender harness running Codex belongs under Blender, not Codex.
      if (canonicalHarnessId(agent.identityEngine ?? '') !=
          canonicalHarnessId(harnessId)) {
        continue;
      }
      final target = StoreResumeTarget(machine, agent);
      // Existing views can still be visited while their machine reconnects.
      // Discovered entries without a terminal or a view cannot be resumed.
      if (!agent.terminalAvailable && !open.contains(target.destinationId)) {
        continue;
      }
      targets[target.destinationId] = target;
    }
  }
  final rank = {for (var i = 0; i < recent.length; i++) recent[i]: i};
  return targets.values.toList()..sort((a, b) {
    final recency = (rank[a.destinationId] ?? recent.length).compareTo(
      rank[b.destinationId] ?? recent.length,
    );
    if (recency != 0) return recency;
    final inView = (open.contains(b.destinationId) ? 1 : 0).compareTo(
      open.contains(a.destinationId) ? 1 : 0,
    );
    if (inView != 0) return inView;
    final name = a.title.toLowerCase().compareTo(b.title.toLowerCase());
    return name != 0 ? name : a.destinationId.compareTo(b.destinationId);
  });
}

/// Recheck a menu choice immediately before navigating. A stopped/deleted
/// harness must never turn a stale Resume click into a new harness.
Future<bool> resumeStoreHarness(
  AppNotifier app,
  String harnessId,
  StoreResumeTarget target,
) async {
  if (!storeResumeTargets(
    app,
    harnessId,
  ).any((current) => current.destinationId == target.destinationId)) {
    return false;
  }
  // This path reveals an existing tab first, or attaches a new view to the
  // existing agent. It never calls agent_create or opens the creation dialog.
  await app.openAgentFromDial(target.machineId, target.agent.id);
  return true;
}

/// Launch actions on a harness page. Resume appears only with an existing
/// target: one resumes directly, and multiple targets ask which one.
class StoreHarnessActions extends StatefulWidget {
  const StoreHarnessActions({
    super.key,
    required this.notifier,
    required this.harnessId,
    required this.onNew,
    this.recent = const [],
    this.prominent = false,
    this.newButtonKey,
  });

  final AppNotifier notifier;
  final String harnessId;
  final Future<void> Function()? onNew;
  final List<String> recent;
  final bool prominent;
  final Key? newButtonKey;

  @override
  State<StoreHarnessActions> createState() => _StoreHarnessActionsState();
}

class _StoreHarnessActionsState extends State<StoreHarnessActions> {
  final _menu = MenuController();
  final _buttonFocus = FocusNode();
  final _firstChoiceFocus = FocusNode();
  bool _busy = false;

  @override
  void dispose() {
    _buttonFocus.dispose();
    _firstChoiceFocus.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    final messenger = ScaffoldMessenger.maybeOf(context);
    setState(() => _busy = true);
    try {
      await action();
    } catch (_) {
      messenger?.showSnackBar(
        const SnackBar(
          content: Text('Could not open this harness. Try again.'),
        ),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _resume(StoreResumeTarget target) {
    _menu.close();
    final messenger = ScaffoldMessenger.maybeOf(context);
    unawaited(
      _run(() async {
        final resumed = await resumeStoreHarness(
          widget.notifier,
          widget.harnessId,
          target,
        );
        if (!resumed) {
          messenger?.showSnackBar(
            const SnackBar(
              content: Text('That harness is no longer available.'),
            ),
          );
        }
      }),
    );
  }

  void _openMenu() {
    _menu.open();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _menu.isOpen) _firstChoiceFocus.requestFocus();
    });
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.notifier,
    builder: (context, _) {
      grid.AppTheme.watch(context);
      final targets = storeResumeTargets(
        widget.notifier,
        widget.harnessId,
        recent: widget.recent,
      );
      final multiple = targets.length > 1;
      final height = widget.prominent ? 46.0 : 34.0;
      final padding = EdgeInsets.symmetric(
        horizontal: widget.prominent ? 20 : 12,
        vertical: 8,
      );
      final textStyle = terminalTextStyle(fontWeight: FontWeight.w600);
      final tooltip = multiple
          ? 'Choose a harness to resume'
          : targets.firstOrNull?.tooltip ?? '';
      final menuWidth = math.min(420.0, MediaQuery.sizeOf(context).width - 40);
      // Measure the longer label at the user's text size. Matching fixed widths
      // keep the pair balanced, while Wrap stacks them on narrow pages.
      final label = TextPainter(
        text: TextSpan(text: 'Resume Harness', style: textStyle),
        textDirection: Directionality.of(context),
        textScaler: MediaQuery.textScalerOf(context),
      )..layout();
      final preferredWidth = math.max(
        widget.prominent ? 190.0 : 145.0,
        label.width.ceilToDouble() + padding.horizontal + (multiple ? 20 : 0),
      );
      label.dispose();
      return LayoutBuilder(
        builder: (context, constraints) {
          final buttonWidth = math.min(preferredWidth, constraints.maxWidth);
          return Wrap(
            spacing: 8,
            runSpacing: 8,
            alignment: widget.prominent
                ? WrapAlignment.center
                : WrapAlignment.start,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              if (targets.isNotEmpty)
                MenuAnchor(
                  controller: _menu,
                  childFocusNode: _buttonFocus,
                  consumeOutsideTap: true,
                  alignmentOffset: const Offset(0, grid.AppControl.menuGap),
                  style: grid.AppMenu.style(maxHeight: 360),
                  menuChildren: [
                    SizedBox(
                      width: menuWidth,
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(18, 12, 18, 8),
                        child: Text(
                          'Recent harnesses',
                          style: terminalTextStyle(
                            fontWeight: FontWeight.w600,
                            color: grid.AppPalette.textSecondary,
                          ),
                        ),
                      ),
                    ),
                    for (var i = 0; i < targets.length; i++)
                      SizedBox(
                        width: menuWidth,
                        child: Tooltip(
                          message: targets[i].tooltip,
                          child: AppMenuItem(
                            key: ValueKey(
                              'store-resume-choice:${targets[i].destinationId}',
                            ),
                            focusNode: i == 0 ? _firstChoiceFocus : null,
                            metrics: AppMenuRowMetrics.roomy,
                            icon: LucideIcons.history300,
                            label: targets[i].title,
                            detail: targets[i].detail,
                            trailing: targets[i].machine.nodeOnline == false
                                ? Tooltip(
                                    message: 'Machine offline',
                                    child: Icon(
                                      LucideIcons.cloudOff300,
                                      size: 14,
                                      color: grid.AppPalette.textFaint,
                                    ),
                                  )
                                : null,
                            onPressed: () => _resume(targets[i]),
                          ),
                        ),
                      ),
                  ],
                  builder: (context, controller, _) => Focus(
                    onKeyEvent: (_, event) {
                      if (event is KeyDownEvent &&
                          event.logicalKey == LogicalKeyboardKey.arrowDown &&
                          multiple &&
                          !_busy) {
                        _openMenu();
                        return KeyEventResult.handled;
                      }
                      return KeyEventResult.ignored;
                    },
                    child: Tooltip(
                      message: tooltip,
                      child: OutlinedButton(
                        key: ValueKey('store-resume:${widget.harnessId}'),
                        focusNode: _buttonFocus,
                        onPressed: _busy || targets.isEmpty
                            ? null
                            : () {
                                if (multiple) {
                                  if (controller.isOpen) {
                                    controller.close();
                                  } else {
                                    _openMenu();
                                  }
                                } else {
                                  _resume(targets.single);
                                }
                              },
                        style: OutlinedButton.styleFrom(
                          minimumSize: Size(buttonWidth, height),
                          maximumSize: Size(buttonWidth, double.infinity),
                          padding: padding,
                          foregroundColor: targets.isEmpty
                              ? grid.AppPalette.textPrimary
                              : grid.AppPalette.windowBg,
                          backgroundColor: targets.isEmpty
                              ? Colors.transparent
                              : grid.AppPalette.textPrimary,
                          side: BorderSide(color: grid.AppPalette.divider),
                          textStyle: textStyle,
                          shape: const StadiumBorder(),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Flexible(child: Text('Resume Harness')),
                            if (multiple) ...[
                              const SizedBox(width: 6),
                              Icon(
                                LucideIcons.chevronDown300,
                                key: ValueKey(
                                  'store-resume-chevron:${widget.harnessId}',
                                ),
                                size: 14,
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              FilledButton(
                key:
                    widget.newButtonKey ??
                    ValueKey('store-new:${widget.harnessId}'),
                onPressed: _busy || widget.onNew == null
                    ? null
                    : () {
                        _menu.close();
                        unawaited(_run(widget.onNew!));
                      },
                style: FilledButton.styleFrom(
                  minimumSize: Size(buttonWidth, height),
                  maximumSize: Size(buttonWidth, double.infinity),
                  padding: padding,
                  foregroundColor: targets.isEmpty
                      ? grid.AppPalette.windowBg
                      : grid.AppPalette.textPrimary,
                  backgroundColor: targets.isEmpty
                      ? grid.AppPalette.textPrimary
                      : grid.AppSurface.selectedFill,
                  textStyle: textStyle,
                  shape: const StadiumBorder(),
                ),
                child: const Text('New Harness'),
              ),
            ],
          );
        },
      );
    },
  );
}
