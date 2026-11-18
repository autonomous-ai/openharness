// The dial's pets as the mockup plays them (PET_ART: per engine and scene, frames and timed steps of layers).
import 'package:flutter/widgets.dart';

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
