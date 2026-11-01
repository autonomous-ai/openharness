import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/phone_sheet.dart';

import 'model.dart';
import 'swarm_start.dart' show SwarmComputers, SwarmOwnComputer;

/// Why this phone cannot open [agent]'s terminal now, in the word its Open
/// terminal row says; null when it can (Tony, 11-01). Team's rule: the
/// agent's machine linked to this phone and not reported offline
/// ([canOpen], `PhoneShellScope.canOpenMachine`). "Stopped" with no agent
/// running or one being stopped; "Not linked" for a machine this phone does
/// not have among the person's own [own] and cannot open (not linked here,
/// or a Harness Team account's); "Offline" for one it has but that is
/// reported offline, or an agent the Swarm says is down.
String? swarmTerminalBlock(
  SuperTabAgent? agent, {
  required bool Function(String machineId)? canOpen,
  required List<SwarmOwnComputer> own,
}) {
  if (agent == null ||
      agent.workDecision == 'stop' ||
      agent.harnessId.isEmpty ||
      agent.machineId.isEmpty) {
    return 'Stopped';
  }
  final opens = canOpen?.call(agent.machineId) == true;
  if (!opens && !own.any((m) => m.id == agent.machineId)) return 'Not linked';
  if (!opens || agent.downSince != null) return 'Offline';
  return null;
}

/// A sheet's Open terminal row for the agent [agent] reads now: it opens that
/// agent's terminal on this phone ([PhoneShellScope.onOpenAgent]), or is
/// dimmed with [swarmTerminalBlock]'s word. Checked again at the tap: still
/// [allowed], still the same agent, its machine still one the phone opens.
/// The caller rebuilds it as the Swarm and [computers] change.
PhoneSheetAction swarmTerminalAction({
  required SuperTabAgent? Function() agent,
  required bool Function() allowed,
  required PhoneShellScope? shell,
  required SwarmComputers? computers,
}) {
  String? block(SuperTabAgent? a) => swarmTerminalBlock(
    a,
    canOpen: shell?.canOpenMachine,
    own: computers?.own ?? const [],
  );
  final shown = agent();
  final why = block(shown);
  return PhoneSheetAction(
    icon: LucideIcons.squareTerminal,
    label: 'Open terminal',
    value: why,
    enabled: why == null,
    onTap: () {
      final now = agent();
      if (shell == null ||
          now == null ||
          now.id != shown?.id ||
          !allowed() ||
          block(now) != null) {
        return;
      }
      shell.onOpenAgent(now.machineId, now.harnessId);
    },
  );
}
