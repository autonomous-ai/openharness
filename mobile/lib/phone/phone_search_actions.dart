import 'package:flutter/widgets.dart';

import 'package:harness_mobile/state/app_state.dart';

import 'agent_index.dart';
import 'agents_list_page.dart';
import 'agents_page.dart' show openNewAgent;
import 'phone_navigation.dart';
import 'phone_search_commands.dart';
import 'phone_status.dart';
import 'settings_page.dart';

/// What `>` offers on the phone, and so what `?` lists under its three modes.
///
/// The desktop's `_searchModes` builds its half of this off a keymap and drops
/// any command the workspace cannot currently run. Same rule here, without the
/// keymap: a command is offered only while it would do something — there is no
/// "New agent" while no machine is ready to take one.
///
/// ⚠️ **Re-read on every filter, never cached.** Which commands are available
/// follows the fleet, and a list built once at open would keep offering a
/// machine that has since dropped.
List<PhoneCommand> phoneSearchCommands(
  BuildContext context,
  AppNotifier notifier,
) {
  final ready = [
    for (final machine in filterableMachines(notifier))
      if (phoneMachineStatusOf(machine) == PhoneMachineStatus.ready) machine,
  ];
  return [
    if (ready.isNotEmpty)
      PhoneCommand(
        id: 'agent.new',
        title: 'New agent',
        detail: ready.length == 1
            ? 'On ${ready.first.machine.displayName}'
            : 'Choose a machine, then an engine',
        run: () =>
            openNewAgent(context, notifier, ready.first.machine.machineId),
      ),
    PhoneCommand(
      id: 'navigation.agents',
      title: 'All agents',
      detail: 'Every agent on the account, by machine',
      run: () => Navigator.of(
        context,
      ).push(phoneRoute((_) => AgentsListPage(notifier: notifier))),
    ),
    PhoneCommand(
      id: 'app.settings',
      title: 'Settings',
      detail: 'Appearance · terminal · account',
      run: () => Navigator.of(context).push(
        phoneRoute((_) => SettingsPage(notifier: notifier, large: false)),
      ),
    ),
  ];
}
