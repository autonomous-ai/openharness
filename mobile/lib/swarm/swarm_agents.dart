import 'package:flutter/widgets.dart';

import 'swarm_session.dart';

/// The harnesses on the person's computers, for Swarm's way into Harness:
/// the switcher's Agents row (Tony, 2026-11-03).
///
/// Tells only when how many work changes: not at every frame a terminal
/// sends.
abstract interface class SwarmAgents implements Listenable {
  /// How many work now; null until the computers have answered.
  int? get working;

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
