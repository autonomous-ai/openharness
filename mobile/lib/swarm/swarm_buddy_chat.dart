import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_sheet.dart';
import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'model.dart';
import 'swarm_buddy.dart';
import 'swarm_conversation_page.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_row.dart';
import 'swarm_session.dart' show SwarmScope;
import 'swarm_start.dart' show SwarmOwnComputer;
import 'swarm_style.dart';

/// Opens the person's Buddy chat in [projectId] over [context]'s page, on the
/// server first when the read holds none ([openSwarmBuddyChat]). Answers what
/// went wrong as a sentence to show, or null once it is open.
Future<String?> openSwarmBuddy(
  BuildContext context,
  SwarmReader reader,
  String swarmId,
  String projectId,
) async {
  final String? id;
  try {
    id = await openSwarmBuddyChat(reader, projectId);
  } on SuperTabFailure catch (failure) {
    return failure.message;
  } catch (_) {
    return 'Could not open your Buddy chat. Try again.';
  }
  if (id == null) return 'Your Buddy chat is not ready yet. Try again.';
  if (context.mounted) openSwarmConversation(context, swarmId, id);
  return null;
}

/// Under the person's Buddy chat's header (#2090; the desktop's
/// `SuperTabBuddyBar`): who else can see their Buddy's terminal, when someone
/// can, and, while it is down, Start again. With no Buddy, how its start
/// is going, or — with none under way — Start your Buddy, for a person who
/// may write: the chat is there before any Buddy. Under all of it, what went
/// wrong with the last start or removal. Nothing for a viewer with no Buddy,
/// nor while a Buddy runs on the person's own machine: the chat is the
/// screen, and its messages start under the header (Tony, 10-29).
class SwarmBuddyBar extends StatelessWidget {
  const SwarmBuddyBar({super.key, required this.actions});

  final SwarmBuddyActions actions;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([actions.reader, actions]),
      builder: (context, _) {
        final reader = actions.reader;
        final canWrite = swarmCanWrite(reader);
        final error = actions.error;
        final body = switch (swarmBuddy(reader, actions.projectId)) {
          final agent? => _running(reader, agent, canWrite),
          null => _starting(
            reader,
            canWrite,
            SwarmScope.computersOf(context)?.own ?? const [],
          ),
        };
        if (body == null && error == null) return const SizedBox.shrink();
        return DecoratedBox(
          key: const ValueKey('swarm-buddy-bar'),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: AppGlass.hair)),
          ),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.screenInset,
              AppSpace.xs,
              AppSpace.screenInset,
              AppSpace.s,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                ?body,
                if (error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: AppSpace.xs),
                    child: SwarmRow.line(
                      error,
                      key: const ValueKey('swarm-buddy-error'),
                      lines: 3,
                      color: AppColors.danger,
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }

  /// On someone else's machine, "Claude on Dee Studio · dee can see its
  /// terminal" (a Buddy from before the server kept Buddies to their owner's
  /// machines, 10-28); and, while it is down, that it is offline with Start
  /// again. Null on the person's own machine while it runs.
  Widget? _running(SwarmReader reader, SuperTabAgent agent, bool canWrite) {
    final shared = agent.machineOwnerId != reader.accountId;
    if (!shared && agent.downSince == null) return null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (shared)
          SwarmRow.line(
            '${swarmBuddyEngineName(agent.engine)} on '
            '${swarmBuddyMachineName(reader, agent.machineId)} · '
            '${swarmBuddyPersonName(reader, agent.machineOwnerId)} can see '
            'its terminal',
            key: const ValueKey('swarm-buddy-where'),
            lines: 2,
          ),
        if (agent.downSince != null)
          _Line(
            key: const ValueKey('swarm-buddy-offline'),
            text:
                '${swarmBuddyName(reader, actions.projectId)} is offline. '
                'Your chat stays.',
            engine: agent.engine,
            again: canWrite
                ? () => unawaited(
                    actions.start(
                      machineId: agent.machineId,
                      engine: swarmBuddyRestartEngine(agent.engine),
                    ),
                  )
                : null,
            busy: actions.busy,
          ),
      ],
    );
  }

  /// A start under way, or one that failed with Start again; with none,
  /// Start your Buddy. Null for a viewer, who starts none.
  Widget? _starting(
    SwarmReader reader,
    bool canWrite,
    List<SwarmOwnComputer> own,
  ) {
    final start = swarmBuddyStart(reader, actions.projectId);
    final error = start?['error'];
    if (start == null || (error is! String && start['harnessId'] != null)) {
      return canWrite ? _BuddyStart(actions: actions) : null;
    }
    final request = start['request'] as Map;
    final engine = request['engine'] as String? ?? '';
    final machineId = request['machineId'] as String? ?? '';
    if (error is String) {
      return _Line(
        key: const ValueKey('swarm-buddy-failed'),
        text: "Couldn't start: $error",
        engine: engine,
        again: canWrite && machineId.isNotEmpty
            ? () => unawaited(
                actions.start(
                  machineId: machineId,
                  engine: swarmBuddyRestartEngine(engine),
                ),
              )
            : null,
        busy: actions.busy,
      );
    }
    return SwarmRow.line(
      'Starting ${swarmBuddyEngineName(engine)} on '
      '${swarmBuddyMachineName(reader, machineId, computers: own)}…',
      key: const ValueKey('swarm-buddy-starting'),
      lines: 2,
    );
  }
}

/// What happened to the Buddy, in a line, and Start again at its end for a
/// person who may write: "Start with Claude Code" for an [engine] the server
/// refuses.
class _Line extends StatelessWidget {
  const _Line({
    super.key,
    required this.text,
    required this.engine,
    required this.again,
    required this.busy,
  });

  final String text;
  final String engine;
  final VoidCallback? again;
  final bool busy;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Expanded(
        child: Text(text, style: AppType.body(color: AppPalette.textPrimary)),
      ),
      if (again != null)
        SwarmButton(
          key: const ValueKey('swarm-buddy-start-again'),
          label: swarmBuddyRestartLabel(engine),
          style: SwarmButtonStyle.link,
          busy: busy,
          busyLabel: 'Starting…',
          onPressed: again,
        ),
    ],
  );
}

/// A Buddy chat with no Buddy: one tap on Start starts one, on the person's
/// own machine and with Claude unless they pick otherwise (mockup, Tony
/// 10-29). With no machine of theirs in the Swarm, it says to add one.
class _BuddyStart extends StatefulWidget {
  const _BuddyStart({required this.actions});

  final SwarmBuddyActions actions;

  @override
  State<_BuddyStart> createState() => _BuddyStartState();
}

class _BuddyStartState extends State<_BuddyStart> {
  String? _machine;
  String _engine = 'claude';

  /// The machines under their one heading, each by its name; an offline one
  /// says so and cannot be picked (Dee, 10-29: no notes).
  Future<void> _pickMachine(List<SwarmBuddyMachine> machines, String? chosen) =>
      showPhoneSheet(
        context,
        title: 'Machine',
        sections: [
          PhoneSheetSection(
            caption: swarmBuddyOwnMachines,
            actions: [
              for (final m in machines)
                PhoneSheetAction(
                  icon: m.id == chosen ? LucideIcons.check : LucideIcons.laptop,
                  label: m.name,
                  value: m.away ? swarmBuddyMachineOffline : null,
                  enabled: !m.away,
                  onTap: () {
                    if (mounted) setState(() => _machine = m.id);
                  },
                ),
            ],
          ),
        ],
      );

  @override
  Widget build(BuildContext context) {
    final actions = widget.actions;
    final computers = SwarmScope.computersOf(context);
    final machines = swarmBuddyMachines(
      actions.reader,
      computers: computers?.own ?? const [],
    );
    final machine =
        machines.where((m) => m.id == _machine && !m.away).firstOrNull ??
        machines.where((m) => !m.away).firstOrNull;
    final busy = actions.busy;
    return Column(
      key: const ValueKey('swarm-buddy-start'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          'Start your Buddy to brainstorm here',
          style: AppType.body(
            color: AppPalette.textPrimary,
            fontWeight: FontWeight.w600,
          ),
        ),
        if (machine == null)
          Padding(
            padding: const EdgeInsets.only(top: AppSpace.xs),
            child: SwarmRow.line(
              machines.isEmpty ? swarmBuddyNoMachine : swarmBuddyAllOffline,
              key: const ValueKey('swarm-buddy-no-machine'),
              lines: 3,
            ),
          ),
        if (machine == null && machines.isNotEmpty)
          _Field(
            label: 'Machine',
            child: TextButton(
              key: const ValueKey('swarm-buddy-machine'),
              onPressed: () => unawaited(_pickMachine(machines, null)),
              child: const Align(
                alignment: Alignment.centerLeft,
                child: Text('Choose a machine'),
              ),
            ),
          ),
        if (machine != null) ...[
          _Field(
            label: 'Machine',
            child: Semantics(
              button: true,
              label: 'Machine, ${machine.name}',
              excludeSemantics: true,
              child: InkWell(
                key: const ValueKey('swarm-buddy-machine'),
                borderRadius: BorderRadius.circular(AppControl.radius),
                onTap: busy
                    ? null
                    : () => unawaited(_pickMachine(machines, machine.id)),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: minTouchTarget),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          machine.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: AppType.body(color: AppPalette.textPrimary),
                        ),
                      ),
                      Icon(
                        LucideIcons.chevronDown,
                        size: AppIconSize.besideText,
                        color: AppPalette.textSecondary,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          _Field(
            label: 'Agent',
            child: Wrap(
              spacing: AppSpace.s,
              runSpacing: AppSpace.xs,
              children: [
                for (final MapEntry(:key, :value) in swarmBuddyEngines.entries)
                  Semantics(
                    selected: key == _engine,
                    child: SwarmButton(
                      key: ValueKey('swarm-buddy-engine-$key'),
                      label: value,
                      icon: key == _engine ? LucideIcons.check : null,
                      // One the server refuses is offered turned off.
                      onPressed:
                          busy || swarmBuddyEngineRefusals.containsKey(key)
                          ? null
                          : () => setState(() => _engine = key),
                    ),
                  ),
              ],
            ),
          ),
          for (final refusal in swarmBuddyEngineRefusals.values)
            Padding(
              padding: const EdgeInsets.only(
                left: _Field._labelWidth,
                top: AppSpace.xs,
              ),
              child: SwarmRow.line(refusal, lines: 3),
            ),
          const SizedBox(height: AppSpace.s),
          SwarmButton(
            key: const ValueKey('swarm-buddy-start-button'),
            label: 'Start',
            style: SwarmButtonStyle.fill,
            wide: true,
            busy: busy,
            busyLabel: 'Starting…',
            onPressed: () => unawaited(
              actions.start(
                machineId: machine.id,
                engine: _engine,
                machine: machine,
                computers: computers,
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// One choice of Start your Buddy: its name, then what is chosen.
class _Field extends StatelessWidget {
  const _Field({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: AppSpace.xs),
    child: Row(
      children: [
        SizedBox(
          width: _labelWidth,
          child: Text(
            label,
            style: AppType.body(color: AppPalette.textSecondary),
          ),
        ),
        Expanded(child: child),
      ],
    ),
  );

  /// Wide enough for "Machine" at the largest text the chat allows.
  static const _labelWidth = AppSpace.xl * 3;
}

/// At the end of the person's Buddy chat's header, while their Buddy runs
/// and they may write: ⋮, whose one row, Remove Buddy, asks first, then
/// stops it; the chat stays (the desktop's Buddy options). Nothing
/// otherwise.
class SwarmBuddyMenuButton extends StatelessWidget {
  const SwarmBuddyMenuButton({super.key, required this.actions});

  final SwarmBuddyActions actions;

  Future<void> _open(BuildContext context) => showPhoneSheet(
    context,
    title: swarmBuddyName(actions.reader, actions.projectId),
    actions: [
      PhoneSheetAction(
        icon: LucideIcons.userMinus,
        label: 'Remove Buddy',
        destructive: true,
        onTap: () => unawaited(_confirmRemove(context)),
      ),
    ],
  );

  Future<void> _confirmRemove(BuildContext context) async {
    if (!context.mounted) return;
    final remove = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(
          'Remove Buddy?',
          style: AppType.heading(color: AppPalette.textPrimary),
        ),
        content: Text(
          'Its session stops. Your chat stays, and adding a Buddy here again '
          'picks it up.',
          style: AppType.body(color: AppPalette.textSecondary),
        ),
        actions: [
          SwarmButton(
            key: const ValueKey('swarm-buddy-remove-cancel'),
            label: 'Cancel',
            style: SwarmButtonStyle.link,
            onPressed: () => Navigator.of(context).pop(false),
          ),
          SwarmButton(
            key: const ValueKey('swarm-buddy-remove-confirm'),
            label: 'Remove',
            style: SwarmButtonStyle.fill,
            onPressed: () => Navigator.of(context).pop(true),
          ),
        ],
      ),
    );
    if (remove == true) await actions.remove();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([actions.reader, actions]),
      builder: (context, _) {
        final reader = actions.reader;
        if (swarmBuddy(reader, actions.projectId) == null ||
            !swarmCanWrite(reader)) {
          return const SizedBox.shrink();
        }
        final busy = actions.busy;
        final ink = AppPalette.textPrimary;
        return Semantics(
          key: const ValueKey('swarm-buddy-menu'),
          button: true,
          enabled: !busy,
          label: busy ? 'Working on your Buddy…' : 'Buddy options',
          excludeSemantics: true,
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: busy
                ? null
                : () {
                    HapticFeedback.selectionClick();
                    unawaited(_open(context));
                  },
            child: SizedBox.square(
              dimension: minTouchTarget,
              child: Align(
                alignment: AlignmentDirectional.centerEnd,
                child: busy
                    ? SizedBox.square(
                        dimension: AppIconSize.besideText,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: ink,
                          backgroundColor: ink.withValues(alpha: .35),
                        ),
                      )
                    : Icon(
                        LucideIcons.ellipsisVertical300,
                        size: AppIconSize.standalone,
                        color: ink,
                      ),
              ),
            ),
          ),
        );
      },
    );
  }
}
