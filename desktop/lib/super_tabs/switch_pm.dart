import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_select_field.dart';
import '../state/lead_placement.dart';
import '../usage/usage_account_key.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'identity.dart' show superTabMachineName;
import 'machine_status.dart';
import 'model.dart';

/// "2:00 PM" for today, "Nov 3, 2:00 PM" for another day this year, with the
/// year after that, in the reader's time.
String switchPmTime(BuildContext context, DateTime at) {
  final local = at.toLocal(), now = DateTime.now();
  final l10n = MaterialLocalizations.of(context);
  final time = l10n.formatTimeOfDay(TimeOfDay.fromDateTime(local));
  if (local.year == now.year &&
      local.month == now.month &&
      local.day == now.day) {
    return time;
  }
  final day = local.year == now.year
      ? l10n.formatShortMonthDay(local)
      : l10n.formatShortDate(local);
  return '$day, $time';
}

/// Moves [projectId]'s Product Manager to another machine, engine/account, or
/// model. The host starts the replacement and sends the handoff note.
Future<void> showSwitchPm(
  BuildContext context,
  SuperTabController c,
  String projectId,
) {
  final snapshot = c.snapshot;
  final lead = snapshot?.leadOf(projectId);
  var machineId = lead?.machineId;
  ({String engine, String id})? picked;
  String? model;
  var busy = false;
  var catalogRead = false;
  List<Map<String, dynamic>> catalogModels = const [];
  if (!c.hasPendingAction) c.operationError = null;

  return showAppDialog<void>(
    context: context,
    builder: (context) => SuperTabDialogScope(
      controller: c,
      projectId: projectId,
      requireWrite: true,
      child: StatefulBuilder(
        builder: (context, update) => ListenableBuilder(
          listenable: Listenable.merge([c, c.machinesChanged]),
          builder: (context, _) {
            final currentSnapshot = c.snapshot;
            final currentLead = currentSnapshot?.leadOf(projectId);
            if (!catalogRead) {
              catalogRead = true;
              unawaited(() async {
                try {
                  final rawAnswer = await c.request(
                    'GET',
                    '/api/super-tabs/${Uri.encodeComponent(c.tabId)}/routing-policy',
                  );
                  final answer = superTabMap(rawAnswer);
                  final raw = (answer['catalog'] as Map?)?['models'];
                  if (raw is List) {
                    catalogModels = [
                      for (final row in raw)
                        if (row is Map &&
                            row['engine'] is String &&
                            row['model'] is String &&
                            row['offered'] != false)
                          superTabMap(row),
                    ];
                  }
                } catch (_) {
                  // The subscription's default model remains available.
                }
                update(() {});
              }());
            }

            final pools = currentSnapshot?.machines ?? const [];
            final now = DateTime.now().millisecondsSinceEpoch;
            Map<String, dynamic> part(Object? value) =>
                value is Map ? superTabMap(value) : const {};
            bool fresh(Map<String, dynamic>? pool) {
              final received = part(pool?['observation'])['receivedAt'];
              return received is num &&
                  now - received < kSuperTabMachineOfflineAfter.inMilliseconds;
            }

            final sourcePool = currentSnapshot?.pool(
              currentLead?.machineId ?? '',
            );
            String? sourceRefusal;
            if (!fresh(sourcePool)) {
              sourceRefusal = 'Wait for a fresh reading from the PM’s machine.';
            } else {
              final capabilities =
                  part(sourcePool?['observation'])['capabilities'] as List? ??
                  const [];
              if (!capabilities.contains('leadSwitch')) {
                final name = superTabMachineName(
                  sourcePool?['name'] as String? ?? 'the PM’s machine',
                );
                sourceRefusal =
                    'Update Harness on $name to switch this Product Manager.';
              }
            }

            String? unavailable(Map<String, dynamic> pool) {
              final id = pool['machineId'];
              if (id == currentLead?.machineId) return null;
              final name = superTabMachineName(
                pool['name'] as String? ?? 'Mac',
              );
              // The PM machine's owner switches its engine or account there;
              // the backend moves it elsewhere only for the project's owner.
              if (currentSnapshot?.projectById(projectId)?.ownerId !=
                  c.accountId) {
                return 'Only the project’s owner moves its PM to another machine.';
              }
              if (!fresh(pool)) return '$name is offline.';
              final observation = part(pool['observation']);
              final capabilities =
                  observation['capabilities'] as List? ?? const [];
              if (!capabilities.contains('leadSwitch') ||
                  !capabilities.contains('leadStart')) {
                return 'Update Harness on $name to move a Product Manager there.';
              }
              final own = pool['contributorId'] == c.accountId;
              final mayUse =
                  own ||
                  (pool['teamWork'] is Map &&
                      (pool['teamWork'] as Map)['allowed'] == true);
              if (!mayUse) {
                final refusal = (pool['teamWork'] as Map?)?['reason'];
                return refusal is String
                    ? refusal
                    : 'This machine cannot take this project’s work.';
              }
              if (pool['removal'] != null || pool['paused'] == true) {
                return '$name is unavailable in this Swarm.';
              }
              return null;
            }

            final machineRows = [
              for (final pool in pools)
                if (pool['machineId'] is String &&
                    (pool['hostMachineId'] == null ||
                        pool['machineId'] == currentLead?.machineId))
                  pool,
            ];
            final selectedPool = machineRows
                .where((pool) => pool['machineId'] == machineId)
                .firstOrNull;
            if (selectedPool == null &&
                currentLead != null &&
                machineId != currentLead.machineId) {
              machineId = currentLead.machineId;
              picked = null;
              model = null;
            }
            final activePool = machineRows
                .where((pool) => pool['machineId'] == machineId)
                .firstOrNull;
            List<SuperTabProfile> profilesFor(Map<String, dynamic>? pool) {
              final rows = superTabProfilesOf(pool);
              if (rows.isNotEmpty) return rows;
              final offered = (pool?['engines'] as List?)?.whereType<String>();
              return [
                for (final engine in kLeadEngines)
                  if (offered?.contains(engine) ??
                      (pool?['machineId'] == currentLead?.machineId &&
                          engine == currentLead?.engine))
                    (
                      engine: engine,
                      id: 'default',
                      label: 'Default',
                      leftPercent: null,
                      resetsAt: null,
                    ),
              ];
            }

            var profiles = profilesFor(activePool);
            profiles.sort(
              (a, b) =>
                  kLeadEngines.indexOf(a.engine) -
                  kLeadEngines.indexOf(b.engine),
            );
            final profileId =
                currentLead?.profileId ??
                (superTabProfilesOf(activePool).isNotEmpty
                    ? swarmProfileId(
                        currentLead?.machineId ?? '',
                        currentLead?.engine ?? '',
                        'default',
                      )
                    : 'default');
            bool current(SuperTabProfile p) =>
                machineId == currentLead?.machineId &&
                p.engine == currentLead?.engine &&
                p.id == profileId;
            final switching = currentLead?.switchRequest != null;
            final alternatives = profiles
                .where(
                  (p) =>
                      !current(p) &&
                      p.leftPercent != 0 &&
                      unavailable(activePool ?? const {}) == null,
                )
                .toList();
            final otherMachines = machineRows
                .where(
                  (pool) =>
                      pool['machineId'] != currentLead?.machineId &&
                      unavailable(pool) == null,
                )
                .toList();
            final otherMachineHasChoice = otherMachines.any(
              (pool) =>
                  profilesFor(pool).any((profile) => profile.leftPercent != 0),
            );
            final noChoice = alternatives.isEmpty && !otherMachineHasChoice;
            final offeredModels = [
              for (final row in catalogModels)
                if (row['engine'] == (picked?.engine ?? currentLead?.engine))
                  row['model'] as String,
            ];
            if (model != null && !offeredModels.contains(model)) model = null;
            final selectedStillOffered =
                picked == null ||
                profiles.any(
                  (p) =>
                      p.engine == picked!.engine &&
                      p.id == picked!.id &&
                      p.leftPercent != 0,
                );
            final selectedMachineStillAllowed =
                activePool != null && unavailable(activePool) == null;

            return AlertDialog(
              title: const Text('Switch PM'),
              content: SizedBox(
                width: 440,
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const SizedBox(width: 74, child: Text('Machine')),
                          Expanded(
                            child: AppSelectField<String?>(
                              key: const ValueKey('switch-pm-machine'),
                              value: machineId,
                              options: [
                                for (final pool in machineRows)
                                  SelectOption<String?>(
                                    value: pool['machineId'] as String,
                                    enabled: unavailable(pool) == null,
                                    label:
                                        '${superTabMachineName(pool['name'] as String? ?? 'Mac')}${pool['machineId'] == currentLead?.machineId ? ' · Current' : ''}${unavailable(pool) == null ? '' : ' · ${unavailable(pool)}'}',
                                  ),
                              ],
                              onChanged: (value) => update(() {
                                machineId = value;
                                picked = null;
                                model = null;
                              }),
                            ),
                          ),
                        ],
                      ),
                      if (profiles.isEmpty) ...[
                        const SizedBox(height: 12),
                        Text(
                          unavailable(activePool ?? const {}) ?? 'No engine or account is available on this machine.',
                          style: DesktopChrome.metadata(),
                        ),
                      ],
                      // Rows line up under the pickers, past their 74-point label.
                      for (final p in profiles)
                        Row(
                          children: [
                            const SizedBox(width: 74),
                            Expanded(
                              child: ListTile(
                                key: ValueKey('switch-pm-${p.engine}-${p.id}'),
                                dense: true,
                                contentPadding: EdgeInsets.zero,
                                enabled:
                                    !current(p) &&
                                    p.leftPercent != 0 &&
                                    unavailable(activePool ?? const {}) == null,
                                selected:
                                    picked?.engine == p.engine &&
                                    picked?.id == p.id,
                                title: Text(
                                  '${leadEngineLabel(p.engine)} · ${p.label}',
                                ),
                                subtitle: Text(
                                  [
                                    if (current(p)) 'Current',
                                    if (p.leftPercent != null)
                                      '${p.leftPercent}% left',
                                    if (p.resetsAt != null)
                                      'resets ${switchPmTime(context, p.resetsAt!)}',
                                  ].join(' · '),
                                ),
                                onTap: () => update(() {
                                  picked = (engine: p.engine, id: p.id);
                                  model = null;
                                }),
                              ),
                            ),
                          ],
                        ),
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          const SizedBox(width: 74, child: Text('Model')),
                          Expanded(
                            child: AppSelectField<String?>(
                              key: const ValueKey('switch-pm-model'),
                              value: model,
                              options: [
                                const SelectOption<String?>(
                                  value: null,
                                  label: 'Default',
                                ),
                                for (final value in offeredModels.toSet())
                                  SelectOption<String?>(
                                    value: value,
                                    label: value,
                                  ),
                              ],
                              onChanged: (value) => update(() => model = value),
                            ),
                          ),
                        ],
                      ),
                      if (sourceRefusal case final reason?) ...[
                        const SizedBox(height: 12),
                        Text(
                          reason,
                          key: const ValueKey('switch-pm-no-choice'),
                          style: DesktopChrome.metadata(),
                        ),
                      ] else if (noChoice) ...[
                        const SizedBox(height: 12),
                        Text(
                          otherMachines.isEmpty
                              ? 'No other machine or account can run a Product Manager right now.'
                              : 'No engine or account can run a Product Manager right now.',
                          key: const ValueKey('switch-pm-no-choice'),
                          style: DesktopChrome.metadata(),
                        ),
                      ],
                      if (activePool != null &&
                          activePool['contributorId'] != c.accountId) ...[
                        const SizedBox(height: 8),
                        Text(
                          'Only accounts its owner offered are listed.',
                          style: DesktopChrome.metadata(),
                        ),
                      ],
                      const SizedBox(height: 12),
                      Text(
                        'The new session starts fresh and reads a handoff note. Tasks and chat stay.',
                        style: DesktopChrome.text(),
                      ),
                      if (c.operationError != null) ...[
                        const SizedBox(height: 12),
                        Text(c.operationError!),
                      ],
                      if (c.hasPendingAction)
                        TextButton(
                          onPressed: c.saving
                              ? null
                              : () async {
                                  final result = await c.retry();
                                  if (context.mounted && result != null) {
                                    Navigator.pop(context);
                                  }
                                },
                          child: const Text('Check pending action'),
                        ),
                    ],
                  ),
                ),
              ),
              actions: [
                TextButton(
                  onPressed: busy ? null : () => Navigator.pop(context),
                  child: const Text('Cancel'),
                ),
                FilledButton(
                  onPressed:
                      busy ||
                          c.saving ||
                          c.hasPendingAction ||
                          switching ||
                          picked == null ||
                          !selectedMachineStillAllowed ||
                          !selectedStillOffered ||
                          sourceRefusal != null ||
                          noChoice
                      ? null
                      : () async {
                          update(() => busy = true);
                          final command = <String, dynamic>{
                            'type': 'lead.switch',
                            'projectId': projectId,
                            'engine': picked!.engine,
                            'profileId': picked!.id,
                            if (machineId case final selectedMachine?
                                when selectedMachine != currentLead?.machineId)
                              'machineId': selectedMachine,
                          };
                          if (model != null) command['model'] = model;
                          final result = await c.command(command);
                          if (!context.mounted) return;
                          if (result != null) {
                            Navigator.pop(context);
                          } else {
                            update(() => busy = false);
                          }
                        },
                  child: const Text('Switch'),
                ),
              ],
            );
          },
        ),
      ),
    ),
  );
}
