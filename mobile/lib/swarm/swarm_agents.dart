import 'package:flutter/widgets.dart';

import 'swarm_session.dart';

/// What a harness on one of the person's computers is doing, as that
/// computer says it (Desktop's `harnessActivity`): a turn running, or a
/// question on its screen waiting on its person.
enum SwarmHarnessActivity { working, needsInput }

/// The harnesses on the person's computers, for Swarm's way into Harness:
/// the switcher's Agents row (Tony, 2026-11-03), and what each of the
/// person's agents is doing on Your Team (swarm_agent_state.dart).
///
/// Tells only when how many work, or what one of them does, changes: not at
/// every frame a terminal sends.
abstract interface class SwarmAgents implements Listenable {
  /// How many work now; null until the computers have answered.
  int? get working;

  /// What harness [harnessId] on computer [machineId] is doing; null when it
  /// is doing neither, or its computer has not answered this phone.
  SwarmHarnessActivity? activityOf(String machineId, String harnessId);

  /// Opens every agent, by computer.
  void openList(BuildContext context);
}

/// What also has the person's harnesses: the app's computers do
/// ([SwarmScope.computersOf]); a test's may not, and Swarm then shows no way
/// into them. None once the computers are disposed.
abstract interface class SwarmAgentsSource {
  SwarmAgents? get agents;
}

/// The person's harnesses under [context]'s Swarm, or null with none.
SwarmAgents? swarmAgentsOf(BuildContext context) =>
    switch (SwarmScope.computersOf(context)) {
      final SwarmAgentsSource source => source.agents,
      _ => null,
    };
