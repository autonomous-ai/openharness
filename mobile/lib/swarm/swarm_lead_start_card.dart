import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_sheet.dart';
import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';

import 'swarm_lead_start.dart';
import 'swarm_new_project_sheet.dart' show swarmLeadEngineLabel;
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_row.dart';
import 'swarm_style.dart';

/// A Personal project chat with no Lead, empty: Desktop's Start card (#2815)
/// on the phone (task #2941, Huy 11-04). The person picks one of their
/// computers and an engine signed in there, and the computer starts the Lead
/// in the project's folder ([SwarmLeadStarter]); the phone runs nothing. Laid
/// out as Start your Buddy is on the phone (swarm_buddy_chat.dart).
class SwarmLeadStartCard extends StatefulWidget {
  const SwarmLeadStartCard({
    super.key = const ValueKey('swarm-lead-start'),
    required this.reader,
    required this.computers,
    required this.chatId,
  });

  final SwarmReader reader;
  final SwarmLeadComputers computers;
  final String chatId;

  @override
  State<SwarmLeadStartCard> createState() => _SwarmLeadStartCardState();
}

class _SwarmLeadStartCardState extends State<SwarmLeadStartCard> {
  /// What the person picked; null keeps the plan's own choice.
  String? _machine, _engine;

  SwarmLeadStarter get _starter => SwarmLeadStarter.of(widget.reader);

  Future<void> _pickMachine(String chosen) => showPhoneSheet(
    context,
    title: 'Computer',
    actions: [
      for (final c in widget.computers.leadComputers)
        PhoneSheetAction(
          icon: c.id == chosen ? LucideIcons.check : LucideIcons.laptop,
          label: c.name,
          onTap: () {
            if (mounted) setState(() => _machine = c.id);
          },
        ),
    ],
  );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([_starter, widget.computers]),
    builder: (context, _) {
      AppTheme.watch(context);
      final status = _starter.statusOf(widget.chatId);
      final starting = status != null && !status.failed;
      // A Lead started there whose join did not go through: Start again
      // joins it, so its computer and engine are the only ones.
      final kept = _starter.kept(widget.chatId);
      final picked = kept?.machineId ?? _machine;
      SwarmLeadPlan? plan;
      String? unavailable;
      try {
        plan = swarmLeadPlan(
          widget.reader,
          widget.computers,
          widget.chatId,
          machineId: widget.computers.leadComputers.any((c) => c.id == picked)
              ? picked
              : null,
          engine: kept?.engine ?? _engine,
        );
      } on SuperTabFailure catch (failure) {
        unavailable = failure.message;
      }
      // The plan's computer; with no plan, the one picked, so another can be.
      final shownId = plan?.machineId ?? picked;
      final machine = widget.computers.leadComputers
          .where((c) => c.id == shownId)
          .firstOrNull;
      return DecoratedBox(
        decoration: BoxDecoration(
          color: AppCard.base,
          borderRadius: BorderRadius.circular(AppCard.radius),
          border: Border.all(color: AppCard.hair),
        ),
        child: Padding(
          padding: const EdgeInsets.all(AppSpace.m),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'This project has no Lead yet',
                style: AppType.body(
                  color: AppPalette.textPrimary,
                  fontWeight: FontWeight.w600,
                ),
              ),
              if (machine != null)
                _Field(
                  label: 'Computer',
                  child: Semantics(
                    button: true,
                    label: 'Computer, ${machine.name}',
                    excludeSemantics: true,
                    child: InkWell(
                      key: const ValueKey('swarm-lead-start-machine'),
                      borderRadius: BorderRadius.circular(AppControl.radius),
                      onTap: starting || kept != null
                          ? null
                          : () => unawaited(_pickMachine(machine.id)),
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(
                          minHeight: minTouchTarget,
                        ),
                        child: Row(
                          children: [
                            Expanded(
                              child: Text(
                                machine.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: AppType.body(
                                  color: AppPalette.textPrimary,
                                ),
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
              if (plan case final plan? when machine != null) ...[
                _Field(
                  label: 'Agent',
                  child: Wrap(
                    spacing: AppSpace.s,
                    runSpacing: AppSpace.xs,
                    children: [
                      for (final engine in machine.engines)
                        Semantics(
                          selected: engine == plan.engine,
                          child: SwarmButton(
                            key: ValueKey('swarm-lead-start-engine-$engine'),
                            label: swarmLeadEngineLabel(engine),
                            icon: engine == plan.engine
                                ? LucideIcons.check
                                : null,
                            onPressed: starting || kept != null
                                ? null
                                : () => setState(() => _engine = engine),
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: AppSpace.xs),
                SwarmRow.line(
                  switch (plan.folder) {
                    final folder? => 'Folder: $folder',
                    null => 'A new folder in your Harness projects folder',
                  },
                  key: const ValueKey('swarm-lead-start-folder'),
                  lines: 2,
                ),
                const SizedBox(height: AppSpace.m),
                SwarmButton(
                  key: const ValueKey('swarm-lead-start-button'),
                  label: 'Start Lead',
                  style: SwarmButtonStyle.fill,
                  wide: true,
                  busy: starting,
                  busyLabel: 'Starting…',
                  onPressed: () => unawaited(
                    _starter.start(
                      widget.reader,
                      widget.computers,
                      widget.chatId,
                      machineId: plan.machineId,
                      engine: plan.engine,
                    ),
                  ),
                ),
              ] else ...[
                const SizedBox(height: AppSpace.xs),
                Text(
                  'Can’t start a Lead: $unavailable',
                  key: const ValueKey('swarm-lead-start-unavailable'),
                  style: AppType.body(color: AppPalette.textPrimary),
                ),
              ],
              if (status?.reason case final reason?) ...[
                const SizedBox(height: AppSpace.s),
                Text(
                  'Couldn’t start a Lead: $reason',
                  key: const ValueKey('swarm-lead-start-error'),
                  style: AppType.body(color: AppPalette.textPrimary),
                ),
              ],
              const SizedBox(height: AppSpace.s),
              SwarmRow.line(
                'Or send a message below: the Lead reads it when it starts.',
                lines: 2,
              ),
            ],
          ),
        ),
      );
    },
  );
}

/// One choice of the card: its name, then what is chosen (Start your Buddy's
/// `_Field`).
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

  /// Wide enough for "Computer" at the largest text the chat allows.
  static const _labelWidth = AppSpace.xl * 3 + AppSpace.l;
}
