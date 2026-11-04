import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_select_field.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'personal_lead.dart';

/// The engines a Lead starts with, in the Naming System's words.
const _leadEngines = {'claude': 'Claude Code', 'codex': 'Codex'};

/// A Personal project chat with no Lead, empty: one click starts its Lead,
/// on the person's own computer, with Claude Code and in the repo's folder
/// unless they pick otherwise (Huy 11-04, task #2815). It is #2633's start
/// (personal_lead.dart), which a first message also runs, laid out as a
/// Buddy chat's start card is (buddies.dart).
class PersonalLeadStartCard extends StatefulWidget {
  const PersonalLeadStartCard({
    super.key = const ValueKey('super-lead-start'),
    required this.controller,
    required this.conversationId,
    required this.app,
  });

  final SuperTabController controller;
  final String conversationId;
  final AppNotifier app;

  @override
  State<PersonalLeadStartCard> createState() => _PersonalLeadStartCardState();
}

class _PersonalLeadStartCardState extends State<PersonalLeadStartCard> {
  SuperTabController get c => widget.controller;
  PersonalLeadStarter get starter => PersonalLeadStarter.of(widget.app);

  /// What the person picked; null keeps the starter's own choice.
  String? _machine, _engine;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: starter,
    builder: (context, _) {
      final status = starter.statusOf(c, widget.conversationId);
      final starting = status != null && !status.failed;
      PersonalLeadPlan? plan;
      String? unavailable;
      try {
        plan = starter.planFor(
          c,
          widget.conversationId,
          machineId: _machine,
          engine: _engine,
        );
      } on SuperTabFailure catch (failure) {
        unavailable = failure.message;
      }
      final machines = starter.machinesFor(c);
      final busy = starting || c.saving;
      return DecoratedBox(
        decoration: BoxDecoration(
          color: DesktopChrome.surface,
          borderRadius: BorderRadius.circular(grid.AppCard.radius),
          border: Border.all(color: DesktopChrome.rim),
        ),
        child: Padding(
          padding: const EdgeInsets.all(grid.AppDesktop.groupGap),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'This project has no Lead yet',
                style: DesktopChrome.control(medium: true),
              ),
              const SizedBox(height: grid.AppDesktop.controlGap),
              if (plan case final plan?) ...[
                Row(
                  children: [
                    Expanded(
                      flex: 3,
                      child: AppSelectField<String>(
                        key: const ValueKey('super-lead-start-machine'),
                        value: plan.machineId,
                        semanticLabel: 'Computer',
                        textStyle: DesktopChrome.control(),
                        options: [
                          for (final m in machines)
                            SelectOption(
                              value: m.machine.machineId,
                              label: m.machine.displayName,
                            ),
                        ],
                        onChanged: (value) {
                          if (!busy) setState(() => _machine = value);
                        },
                      ),
                    ),
                    const SizedBox(width: grid.AppDesktop.controlGap),
                    Expanded(
                      flex: 2,
                      child: AppSelectField<String>(
                        key: const ValueKey('super-lead-start-engine'),
                        value: plan.engine,
                        semanticLabel: 'Agent',
                        textStyle: DesktopChrome.control(),
                        options: [
                          for (final MapEntry(:key, :value)
                              in _leadEngines.entries)
                            SelectOption(value: key, label: value),
                        ],
                        onChanged: (value) {
                          if (!busy) setState(() => _engine = value);
                        },
                      ),
                    ),
                    const SizedBox(width: grid.AppDesktop.controlGap),
                    FilledButton(
                      onPressed: busy
                          ? null
                          : () => unawaited(
                              starter.start(
                                c,
                                widget.conversationId,
                                machineId: plan.machineId,
                                engine: plan.engine,
                              ),
                            ),
                      child: Text(starting ? 'Starting…' : 'Start Lead'),
                    ),
                  ],
                ),
                const SizedBox(height: grid.AppDesktop.controlGap),
                Text(
                  switch (plan.folder) {
                    final folder? => 'Folder: $folder',
                    null => 'A new folder in your Harness projects folder',
                  },
                  key: const ValueKey('super-lead-start-folder'),
                  style: DesktopChrome.metadata(),
                ),
              ] else
                Text(
                  'Can’t start a Lead: $unavailable',
                  key: const ValueKey('super-lead-start-unavailable'),
                  style: DesktopChrome.control(),
                ),
              if (status?.reason case final reason?) ...[
                const SizedBox(height: grid.AppDesktop.controlGap),
                Text(
                  'Couldn’t start a Lead: $reason',
                  key: const ValueKey('super-lead-start-error'),
                  style: DesktopChrome.control(),
                ),
              ],
              const SizedBox(height: grid.AppDesktop.controlGap),
              Text(
                'Or send a message below: that starts the Lead too.',
                style: DesktopChrome.metadata(),
              ),
            ],
          ),
        ),
      );
    },
  );
}
