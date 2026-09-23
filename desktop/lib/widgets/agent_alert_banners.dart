library;

import 'package:flutter/material.dart';

import '../notify/agent_alerts.dart';
import '../notify/alert_sounds.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/app_type.dart';
import '../state/app_state.dart';
import '../theme/app_theme.dart';
import 'engine_identity.dart';

/// The banners an agent's news appears in, stacked in the window's top-right.
///
/// Top-right and not centred: the middle of the window is where the work is,
/// and a notice that covers it is worse than no notice. Right is also where the
/// eye already goes for a pane's own controls.
///
/// Non-blocking by construction — the stack is only ever as wide and as tall as
/// the banners in it, so there is no invisible area over the pane behind it.
///
/// ⚠️ NOT an `IgnorePointer` around the column with the banners opting back in.
/// That does not work and it looks like it should: `ignoring: false` on a child
/// cannot undo an ancestor's `ignoring: true`, because the ancestor refuses the
/// hit test for the whole subtree before the child is ever asked. Written that
/// way first, the banners were dead to the mouse.
class AgentAlertBanners extends StatelessWidget {
  const AgentAlertBanners({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Positioned(
      top: 12,
      right: 12,
      child: ListenableBuilder(
        listenable: notifier.agentAlerts,
        builder: (context, _) {
          final alerts = notifier.agentAlerts.alerts;
          if (alerts.isEmpty) return const SizedBox.shrink();
          return Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              for (final alert in alerts)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: _Banner(alert: alert, notifier: notifier),
                ),
            ],
          );
        },
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({required this.alert, required this.notifier});

  final AgentAlert alert;
  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) {
    final machine = notifier.machineStates[alert.machineId];
    final agent = machine?.agents
        .where((a) => a.id == alert.agentId)
        .firstOrNull;
    final waiting = alert.kind == AlertKind.needsYou;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: () =>
            notifier.revealAgentFromAlert(alert.machineId, alert.agentId),
        child: Container(
          key: const Key('agent-alert-banner'),
          width: 288,
          padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
          decoration: BoxDecoration(
            color: AppColors.surface,
            borderRadius: BorderRadius.circular(11),
            border: Border.all(
              // The one that is BLOCKED gets the accent edge. Both are news;
              // only one of them is work that has stopped.
              color: waiting
                  ? AppColors.accent.withValues(alpha: 0.55)
                  : AppColors.border,
            ),
            boxShadow: [
              BoxShadow(
                color: const Color(0x40000000),
                blurRadius: 14,
                offset: const Offset(0, 4),
              ),
            ],
          ),
          child: Row(
            children: [
              EngineMark(engine: agent?.engine, size: 15),
              const SizedBox(width: 9),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      alert.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppType.body(color: AppColors.text)
                          .copyWith(fontWeight: FontWeight.w600, fontSize: 13),
                    ),
                    const SizedBox(height: 1),
                    Text(
                      alert.sentence,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppType.body(
                        color: waiting
                            ? AppColors.accent
                            : AppColors.mutedStrong,
                      ).copyWith(fontSize: 12),
                    ),
                  ],
                ),
              ),
              // Dismiss without going anywhere. A banner that could only be
              // answered by following it would make every stray notice a
              // navigation.
              IconButton(
                key: const Key('agent-alert-dismiss'),
                icon: const Icon(Icons.close, size: 14),
                color: AppColors.mutedStrong,
                splashRadius: 14,
                visualDensity: VisualDensity.compact,
                tooltip: 'Dismiss',
                onPressed: () => notifier.agentAlerts.dismiss(alert),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
