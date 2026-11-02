import 'package:flutter/material.dart';

import '../shared/widgets/app_dialog.dart';
import '../state/lead_placement.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'model.dart';

/// "2:00 PM" for today, "Nov 3, 2:00 PM" for another day, in the reader's time.
String switchPmTime(BuildContext context, DateTime at) {
  final local = at.toLocal(), now = DateTime.now();
  final l10n = MaterialLocalizations.of(context);
  final time = l10n.formatTimeOfDay(TimeOfDay.fromDateTime(local));
  return local.year == now.year &&
          local.month == now.month &&
          local.day == now.day
      ? time
      : '${l10n.formatShortDate(local)}, $time';
}

/// Moves [projectId]'s Product Manager to another engine or account on the
/// machine it runs on (spec 2026-11-02-pm-switch-engine-account-design.md). The
/// machine's host does the switch; this sends `lead.switch` and shows a refusal.
Future<void> showSwitchPm(
  BuildContext context,
  SuperTabController c,
  String projectId,
) {
  ({String engine, String id})? picked;
  var busy = false;
  return showAppDialog<void>(
    context: context,
    builder: (context) => SuperTabDialogScope(
      controller: c,
      projectId: projectId,
      requireWrite: true,
      child: StatefulBuilder(
        builder: (context, update) => ListenableBuilder(
          listenable: c,
          builder: (context, _) {
            final snapshot = c.snapshot;
            final lead = snapshot?.leadOf(projectId);
            final pool = snapshot?.pool(lead?.machineId ?? '');
            var profiles = superTabProfilesOf(pool);
            if (profiles.isEmpty && lead != null) {
              // A machine that reports no accounts: its default account, per
              // engine it offers.
              final offered = (pool?['engines'] as List?)?.whereType<String>();
              profiles = [
                for (final engine in kLeadEngines)
                  if (offered?.contains(engine) ?? engine == lead.engine)
                    (
                      engine: engine,
                      id: 'default',
                      label: 'Default',
                      leftPercent: null,
                      resetsAt: null,
                    ),
              ];
            }
            profiles.sort(
              (a, b) =>
                  kLeadEngines.indexOf(a.engine) -
                  kLeadEngines.indexOf(b.engine),
            );
            bool current(SuperTabProfile p) =>
                p.engine == lead?.engine && p.id == lead?.profileId;
            final switching = lead?.switchRequest != null;
            return AlertDialog(
              title: const Text('Switch PM'),
              content: SizedBox(
                width: 400,
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (final p in profiles)
                        ListTile(
                          key: ValueKey('switch-pm-${p.engine}-${p.id}'),
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          enabled: !current(p) && p.leftPercent != 0,
                          selected:
                              picked?.engine == p.engine && picked?.id == p.id,
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
                          onTap: () => update(
                            () => picked = (engine: p.engine, id: p.id),
                          ),
                        ),
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
                          onPressed: c.saving ? null : c.retry,
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
                          picked == null
                      ? null
                      : () async {
                          update(() => busy = true);
                          final result = await c.command({
                            'type': 'lead.switch',
                            'projectId': projectId,
                            'engine': picked!.engine,
                            'profileId': picked!.id,
                          });
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
