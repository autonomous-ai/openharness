// The dial's pets as the mockup plays them (PET_ART: per engine and scene, frames and timed steps of layers).
import 'package:flutter/widgets.dart';

import '../model/types.dart';
import 'tokens.dart';

/// Loads the pets' art (assets/pets/pets.json and its frames) before the first frame.
Future<void> preloadPets() async {}

/// Plays one scene of an engine's pet, fitted into [size] (bottom-centred, as the mockup's canvas).
class PetView extends StatelessWidget {
  const PetView({super.key, required this.engine, required this.scene, required this.size, this.animate = true});

  /// "claude", "codex" or "muse" (petEngineOf).
  final String engine;

  /// The scene, as the mockup's sceneFor: work, rest, relax, listen, idle, review, waiting.
  final String scene;
  final Size size;

  /// False holds the first frame (Overview's cells).
  final bool animate;

  @override
  Widget build(BuildContext context) => SizedBox.fromSize(size: size);
}

/// The scene an agent's pet plays, as the mockup's sceneFor (after the dial's focus.c): a working agent its working
/// scene; one at rest with nothing to show relaxes (Codex has no relaxing art, so it stays on its idle loop); otherwise
/// the small pet (Codex: idle, review when done, waiting when it asks). [list]: a small place (a cell, a card).
String petSceneFor(Agent a, {bool list = false}) {
  final engine = petEngineOf(a.engine);
  if (a.state == AgentState.working) return 'work';
  if (!list && a.said.isEmpty && (a.state == AgentState.idle || a.state == AgentState.done) && engine != 'codex') {
    return 'relax';
  }
  if (engine == 'codex') {
    return switch (a.state) { AgentState.done => 'review', AgentState.asking => 'waiting', _ => 'idle' };
  }
  return 'rest';
}
