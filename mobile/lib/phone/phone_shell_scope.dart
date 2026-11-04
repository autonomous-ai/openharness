import 'package:flutter/widgets.dart';

/// What a page deep inside one tab can ask of the shell around all three.
///
/// The pages live in per-tab navigators, so none of them can switch tabs or push onto another tab's
/// stack by itself. A password form finishing is the one moment that has to: the form is on the
/// Machines tab, and what the person came for is the agent, on the Agents tab.
class PhoneShellScope extends InheritedWidget {
  const PhoneShellScope({
    super.key,
    required this.onMachineLinked,
    required this.onOpenAgent,
    this.onShowSwarm,
    this.canOpenMachine,
    this.agentStopped,
    this.onResumeAgent,
    required super.child,
  });

  /// Called once a machine's password has been accepted — the shell takes the person to that
  /// machine's first agent as soon as the machine answers.
  final void Function(String machineId) onMachineLinked;

  /// Puts [agentId] on the home screen — the terminal at the ROOT of the Agents tab — instead of
  /// pushing a terminal over whatever page asked. See `openAgent` in `phone_navigation.dart`.
  final void Function(String machineId, String agentId) onOpenAgent;

  /// This phone has [machineId] linked and can open its terminals
  /// ([onOpenAgent]). Null where nothing can be opened.
  final bool Function(String machineId)? canOpenMachine;

  /// Whether [agentId] on [machineId] is stopped there, as this phone's list
  /// of the account's own machines says: null while it runs or is not listed;
  /// true for stopped work [onResumeAgent] can bring back, false for stopped
  /// work it cannot. Null where nothing can be resumed.
  final bool? Function(String machineId, String agentId)? agentStopped;

  /// Brings [agentId]'s stopped work on [machineId] back and waits for its
  /// terminal: null once it can be opened ([onOpenAgent]), or what to say.
  /// Null where nothing can be resumed.
  final Future<String?> Function(String machineId, String agentId)?
  onResumeAgent;

  /// Swarm Home at the root, every page over it closed: Swarm asked for from
  /// the terminal (its mark, Find). Null where the shell has no Swarm Home to
  /// go back to, and a Swarm page is pushed instead (`openSwarmHome`).
  final VoidCallback? onShowSwarm;

  /// Null outside the shell — a page pumped on its own in a test simply has nowhere to go.
  static PhoneShellScope? maybeOf(BuildContext context) =>
      context.getInheritedWidgetOfExactType<PhoneShellScope>();

  @override
  bool updateShouldNotify(PhoneShellScope oldWidget) => false;
}
