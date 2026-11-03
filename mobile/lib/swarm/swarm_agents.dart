import 'package:flutter/widgets.dart';

import 'swarm_session.dart';

/// One harness on the person's computers, as Swarm's Search lists it.
typedef SwarmAgentRef = ({
  String machineId,
  String agentId,
  String name,
  String machine,
  String? engine,
  bool working,
  bool waiting,
});

/// The harnesses on the person's computers, for Swarm's way into Harness:
/// Home's Agents tile and Search (Tony, 2026-11-03). Swarm had none before,
/// only Open terminal in four menus.
///
/// Tells only when how many work or wait, or which agents there are,
/// changes: not at every frame a terminal sends.
abstract interface class SwarmAgents implements Listenable {
  /// How many work now; null until the computers have answered.
  int? get working;

  /// Every agent the person can open, waiting ones first.
  List<SwarmAgentRef> get agents;

  /// Opens every agent, by computer.
  void openList(BuildContext context);

  /// Opens [agent]'s terminal, as it opens anywhere else in the app.
  void open(BuildContext context, SwarmAgentRef agent);
}

/// What also has the person's harnesses: the app's computers do
/// ([SwarmScope.computersOf]); a test's may not, and Swarm then shows no way
/// into them.
abstract interface class SwarmAgentsSource {
  SwarmAgents get agents;
}

/// The person's harnesses under [context]'s Swarm, or null with none.
SwarmAgents? swarmAgentsOf(BuildContext context) =>
    switch (SwarmScope.computersOf(context)) {
      final SwarmAgentsSource source => source.agents,
      _ => null,
    };
