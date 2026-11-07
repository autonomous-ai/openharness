import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_menu.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
import '../widgets/finger_target.dart';
import 'buddy_model.dart' show buddyModelBusy;
import 'controller.dart';
import 'model.dart';

/// An engine as a Swarm bar names it: the CLI's own name.
String buddyEngineLabel(String engine) => switch (engine) {
  'claude' => 'Claude Code',
  'codex' => 'Codex',
  _ => engineIdentity(engine).label,
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

/// The engine rows of a Swarm Buddy's menus: each engine its machine is signed in to in a fresh reading, checked
/// while the Buddy runs on it with its own sign-in. With [backFromShared] (the top bar's one menu, task #4465) the
/// engine it runs on is always listed and takes it back from a shared model to its own sign-in, as Your subscription
/// did. Only observations change the offers; nothing probes a login.
List<Widget> buddyEngineMenuRows({
  required SuperTabController controller,
  required SuperTabAgent agent,
  required MenuController menu,
  required bool phone,
  bool backFromShared = false,
}) {
  final c = controller;
  final snapshot = c.snapshot!;
  final chat = _buddyChatOf(c, agent);
  final busy = _buddyEngineBusy(c, agent);
  final offers = buddyEngineOffers(snapshot, agent, now: DateTime.now());
  final engines = [
    if (backFromShared && !offers.contains(agent.engine)) agent.engine,
    ...offers,
  ];
  final shared = agent.gridModel != null;
  return [
    for (final engine in engines)
      fingerTarget(
        enabled: phone,
        AppMenuItem(
          label: buddyEngineLabel(engine),
          icon: engine == agent.engine && !shared ? AppIcons.check : null,
          onPressed: backFromShared && engine == agent.engine
              ? (buddyModelBusy(c, agent)
                    ? null
                    : () {
                        menu.close();
                        if (shared) unawaited(c.switchBuddyModel(null));
                      })
              : busy
              ? null
              : () {
                  menu.close();
                  if (engine == agent.engine && !shared) return;
                  unawaited(
                    c.switchBuddyEngine(engine, conversationId: chat?.id),
                  );
                },
        ),
      ),
    if (engines.isEmpty)
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
  ];
}

/// With several Buddies, the chat of [agent] that an engine switch names; null with one Buddy.
SuperTabConversation? _buddyChatOf(SuperTabController c, SuperTabAgent agent) =>
    c.snapshot!.buddyCap == null
    ? null
    : c.snapshot!.conversations
          .where(
            (chat) =>
                chat.isSwarmBuddyChat &&
                chat.buddyOwnerId == c.accountId &&
                chat.agentIds.contains(agent.id),
          )
          .firstOrNull;

/// Whether a Buddy's engine choices wait: as its model choices, and also while it is down or, with several Buddies,
/// before its chat is known.
bool _buddyEngineBusy(SuperTabController c, SuperTabAgent agent) =>
    buddyModelBusy(c, agent) ||
    agent.modelRequest != null ||
    (c.snapshot!.buddyCap != null && _buddyChatOf(c, agent) == null) ||
    agent.downSince != null;

/// The compact bar control and the limit notice share the same menu and
/// request.
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
    final busy = _buddyEngineBusy(c, agent);
    return AppDropdown(
      controller: _menu,
      children: buddyEngineMenuRows(
        controller: c,
        agent: agent,
        menu: _menu,
        phone: phone,
      ),
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
