import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_menu.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/finger_target.dart';
import 'controller.dart';
import 'model.dart';

String buddyEngineLabel(String engine) => switch (engine) {
  'claude' => 'Claude Code',
  'codex' => 'Codex',
  _ => engine,
};

/// Match backend buddyEngine.ts: the owning computer must implement the
/// handoff. A Team subscription is never the person's Buddy account.
bool buddyEngineCapable(SuperTabSnapshot snapshot, SuperTabAgent agent) {
  final pool = snapshot.pool(agent.machineId);
  final observation = pool?['observation'];
  return pool != null &&
      pool['removal'] == null &&
      pool['hostMachineId'] == null &&
      pool['contributorId'] == agent.buddyOf &&
      agent.machineOwnerId == agent.buddyOf &&
      observation is Map &&
      observation['sessionKind'] != 'team' &&
      observation['capabilities'] is List &&
      (observation['capabilities'] as List).contains('buddyEngine');
}

/// Sign-in is useful only in the machine's current reading. No fallback to
/// installed engines or the contributor's other machines and accounts.
List<String> buddyEngineOffers(
  SuperTabSnapshot snapshot,
  SuperTabAgent agent, {
  required DateTime now,
}) {
  if (!buddyEngineCapable(snapshot, agent)) return const [];
  final observation = superTabMap(
    snapshot.pool(agent.machineId)?['observation'],
  );
  final at = observation['receivedAt'];
  if (at is! num || now.millisecondsSinceEpoch - at > 45000) return const [];
  final readiness = superTabMap(observation['readiness']);
  final rows = readiness['engines'];
  if (rows is! List) return const [];
  return [
    for (final engine in ['claude', 'codex'])
      if (rows.any(
        (r) =>
            r is Map &&
            r['engine'] == engine &&
            r['installed'] == true &&
            r['signedIn'] == true,
      ))
        engine,
  ];
}

/// The compact header control and the limit notice share the same menu and
/// request. Only observations change its offers; it never probes a login.
class BuddyEnginePicker extends StatefulWidget {
  const BuddyEnginePicker({
    super.key,
    required this.controller,
    required this.agent,
    this.limitAction = false,
  });

  final SuperTabController controller;
  final SuperTabAgent agent;
  final bool limitAction;

  @override
  State<BuddyEnginePicker> createState() => _BuddyEnginePickerState();
}

class _BuddyEnginePickerState extends State<BuddyEnginePicker> {
  final _menu = MenuController();

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    final agent = widget.agent;
    final request = agent.switchRequest;
    if (request != null && !widget.limitAction) {
      return Text(
        'Switching to ${buddyEngineLabel(request['engine'] as String? ?? '')}…',
        style: DesktopChrome.metadata(),
      );
    }
    final phone = workspaceIsCompact(context);
    final busy =
        !c.canWrite ||
        c.saving ||
        c.hasPendingAction ||
        request != null ||
        agent.modelRequest != null ||
        agent.downSince != null;
    final offers = buddyEngineOffers(c.snapshot!, agent, now: DateTime.now());
    return AppDropdown(
      controller: _menu,
      children: [
        for (final engine in offers)
          fingerTarget(
            enabled: phone,
            AppMenuItem(
              label: buddyEngineLabel(engine),
              icon: engine == agent.engine && agent.gridModel == null
                  ? AppIcons.check
                  : null,
              onPressed: busy
                  ? null
                  : () {
                      _menu.close();
                      if (engine == agent.engine && agent.gridModel == null) {
                        return;
                      }
                      unawaited(c.switchBuddyEngine(engine));
                    },
            ),
          ),
        if (offers.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: grid.AppDesktop.groupGap,
              vertical: grid.AppDesktop.menuInset,
            ),
            child: Text(
              'No signed-in engine in a fresh machine reading.',
              style: DesktopChrome.metadata(),
            ),
          ),
      ],
      builder: (context, menu, _) => fingerTarget(
        enabled: phone,
        InkWell(
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          onTap: busy ? null : () => menu.isOpen ? menu.close() : menu.open(),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(
                child: Text(
                  widget.limitAction
                      ? 'Switch engine'
                      : buddyEngineLabel(agent.engine),
                  style: DesktopChrome.metadata(
                    color: DesktopChrome.foreground,
                  ),
                ),
              ),
              Icon(
                AppIcons.chevronDown,
                size: AppIcons.inlineSize,
                color: DesktopChrome.muted,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
