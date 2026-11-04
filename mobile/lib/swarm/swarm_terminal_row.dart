import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/phone_sheet.dart';

import 'model.dart';
import 'swarm_start.dart' show SwarmComputers, SwarmOwnComputer;
import 'swarm_terminal_resume.dart';

/// Why this phone cannot open [agent]'s terminal now, in the word its Open
/// terminal row says; null when it can (Tony, 11-01). Team's rule: the
/// agent's machine linked to this phone and not reported offline
/// ([canOpen], `PhoneShellScope.canOpenMachine`). "Stopped" with no agent
/// running or one being stopped, or a session its machine lists as stopped
/// ([stopped], `PhoneShellScope.agentStopped`; the desktop pane's word,
/// whether or not a resume can bring it back, [swarmTerminalResumes]); "Not
/// linked" for a machine this phone does not have among the person's own
/// [own] and cannot open (not linked here, or a Harness Team account's);
/// "Offline" for one it has but that is reported offline, or an agent the
/// Swarm says is down.
String? swarmTerminalBlock(
  SuperTabAgent? agent, {
  required bool Function(String machineId)? canOpen,
  required List<SwarmOwnComputer> own,
  bool? Function(String machineId, String harnessId)? stopped,
}) {
  if (agent == null ||
      agent.workDecision == 'stop' ||
      agent.harnessId.isEmpty ||
      agent.machineId.isEmpty) {
    return 'Stopped';
  }
  final opens = canOpen?.call(agent.machineId) == true;
  if (!opens && !own.any((m) => m.id == agent.machineId)) return 'Not linked';
  if (!opens) return 'Offline';
  // Its machine answers, and says the session is stopped: the Swarm then
  // reads it as down too, which is no machine offline.
  if (stopped?.call(agent.machineId, agent.harnessId) != null) return 'Stopped';
  if (agent.downSince != null) return 'Offline';
  return null;
}

/// Whether [agent]'s Open terminal row resumes it first: the Swarm has not
/// stopped it, and its machine — one this phone opens ([canOpen]) — lists its
/// session as stopped work a resume can bring back ([stopped] true). The
/// desktop's Resume on a Swarm agent's stopped pane, which its own machines
/// alone offer; the caller has checked the person may write.
bool swarmTerminalResumes(
  SuperTabAgent? agent, {
  required bool Function(String machineId)? canOpen,
  required bool? Function(String machineId, String harnessId)? stopped,
}) =>
    agent != null &&
    agent.workDecision != 'stop' &&
    agent.harnessId.isNotEmpty &&
    agent.machineId.isNotEmpty &&
    canOpen?.call(agent.machineId) == true &&
    stopped?.call(agent.machineId, agent.harnessId) == true;

/// A sheet's Open terminal row for the agent [agent] reads now: it opens that
/// agent's terminal on this phone ([PhoneShellScope.onOpenAgent]), or is
/// dimmed with [swarmTerminalBlock]'s word. Stopped work its own machine can
/// bring back says "Stopped" and is not dimmed: the tap asks first, over
/// [context], then resumes it and opens it ([confirmSwarmResume]; the question
/// goes once [allowed] no longer holds, or the agent is replaced or stopped by
/// the Swarm, checked as [until] changes). Checked
/// again at the tap: still [allowed], still the same agent, its machine still
/// one the phone opens, and a resume asked for only if it is still stopped.
/// The caller rebuilds it as the Swarm and [computers] change.
PhoneSheetAction swarmTerminalAction({
  required BuildContext context,
  required SuperTabAgent? Function() agent,
  required bool Function() allowed,
  required PhoneShellScope? shell,
  required SwarmComputers? computers,
  Listenable? until,
}) {
  String? block(SuperTabAgent? a) => swarmTerminalBlock(
    a,
    canOpen: shell?.canOpenMachine,
    own: computers?.own ?? const [],
    stopped: shell?.agentStopped,
  );
  bool resumes(SuperTabAgent? a) =>
      shell?.onResumeAgent != null &&
      swarmTerminalResumes(
        a,
        canOpen: shell?.canOpenMachine,
        stopped: shell?.agentStopped,
      );
  final shown = agent();
  final why = block(shown);
  return PhoneSheetAction(
    icon: LucideIcons.squareTerminal,
    label: 'Open terminal',
    value: why,
    enabled: why == null || resumes(shown),
    onTap: () {
      final now = agent();
      if (shell == null || now == null || now.id != shown?.id || !allowed()) {
        return;
      }
      if (resumes(now)) {
        final machine = computers?.own
            .where((m) => m.id == now.machineId)
            .firstOrNull
            ?.name;
        unawaited(
          confirmSwarmResume(
            context,
            agent: now,
            machineName: machine,
            shell: shell,
            // Still the person's to write, still the agent asked about, and
            // not stopped by the Swarm meanwhile (its Buddy removed).
            allowed: () => switch (agent()) {
              final a? =>
                allowed() && a.id == now.id && a.workDecision != 'stop',
              null => false,
            },
            until: until,
          ),
        );
        return;
      }
      if (block(now) != null) return;
      shell.onOpenAgent(now.machineId, now.harnessId);
    },
  );
}
