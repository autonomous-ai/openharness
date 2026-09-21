import 'package:flutter/material.dart';

import '../core/dsh_catalog.dart';
import 'store_editorial.dart';
import 'store_project_examples.dart';

/// Editorial direction for browsing. Product-page copy and package metadata
/// remain in their existing sources; these introductions invite an experiment.
class StoreDiscipline {
  const StoreDiscipline({
    required this.name,
    required this.headline,
    required this.description,
    required this.invitation,
    required this.color,
    this.featured = const [],
  });

  final String name;
  final String headline;
  final String description;
  final String invitation;
  // These colors belong to editorial artwork, not the app's chrome palette.
  final Color color;
  final List<String> featured;

  DshEntry? example(List<DshEntry> entries) {
    for (final id in featured) {
      for (final entry in entries) {
        if (entry.id == id) return entry;
      }
    }
    return entries.where((e) => !e.isViewerPackage).firstOrNull;
  }
}

const storeDisciplines = <String, StoreDiscipline>{
  'Coding': StoreDiscipline(
    name: 'Coding',
    headline: 'Start with what\nyou know.',
    description:
        'Build the feature. Try the idea. Follow a promising detour. '
        'Your coding agents are right here, ready for the next thing.',
    invitation: 'Your familiar tools. Room for bigger ideas.',
    color: Color(0xffcfedac),
    featured: ['codex', 'claude', 'cursor'],
  ),
  'Design': StoreDiscipline(
    name: 'Design',
    headline: 'Give an idea\na shape.',
    description:
        'A part that fits just right. A room that only exists in your head. '
        'Use code to explore form, change a detail, and see it come to life.',
    invitation: 'Make a first shape. Then make it yours.',
    color: Color(0xffdacdf7),
    featured: [
      'autonomous/blender',
      'autonomous/text-to-cad',
      'autonomous/freecad',
    ],
  ),
  'Engineering': StoreDiscipline(
    name: 'Engineering',
    headline: 'Bring your ideas\noff screen.',
    description:
        'Follow a signal. Design a circuit. Prepare a part for printing. '
        'Get closer to how things work by making something of your own.',
    invitation: 'Start with one circuit. See where it takes you.',
    color: Color(0xffffcf9e),
    featured: [
      'autonomous/kicad',
      'autonomous/autonomous-circuit',
      'autonomous/copper',
      'autonomous/circuitjs',
    ],
  ),
  'Media': StoreDiscipline(
    name: 'Media',
    headline: 'Make the story\nyou can see.',
    description:
        'Turn an idea into images, animation, or a film. '
        'Try a different rhythm, change the light, and find the version that feels right.',
    invitation: 'One scene is a good place to begin.',
    color: Color(0xffffbfb5),
    featured: [
      'autonomous/remotion',
      'autonomous/openmontage',
      'autonomous/manim',
    ],
  ),
  'Music': StoreDiscipline(
    name: 'Music',
    headline: 'Find a sound.\nMake it yours.',
    description:
        'A few notes can become a whole new direction. '
        'Compose, listen, change a pattern, and hear what happens next.',
    invitation: 'Start with a rhythm you cannot get out of your head.',
    color: Color(0xffe6c6f3),
    featured: [
      'autonomous/music-studio',
      'autonomous/score',
      'autonomous/strudel',
    ],
  ),
  'Productivity': StoreDiscipline(
    name: 'Productivity',
    headline: 'Give your thinking\na little room.',
    description:
        'Make a deck that tells the story, a document worth keeping, '
        'or a spreadsheet that answers a question. Shape the work around your idea.',
    invitation: 'Turn a rough thought into something you can share.',
    color: Color(0xfff2e3a6),
    featured: ['autonomous/marp', 'autonomous/typst', 'autonomous/jev-sheets'],
  ),
  'Science & Data': StoreDiscipline(
    name: 'Science & Data',
    headline: 'Follow the\ninteresting question.',
    description:
        'Explore a dataset, test a hunch, or look at a molecule in a new way. '
        'Make the experiment visible and follow the evidence wherever it leads.',
    invitation: 'A good question is enough to get started.',
    color: Color(0xffbce1f5),
    featured: [
      'autonomous/marimo',
      'autonomous/data-studio',
      'autonomous/rdkit',
    ],
  ),
  'Simulation': StoreDiscipline(
    name: 'Simulation',
    headline: 'Build a world.\nSee what happens.',
    description:
        'Give a robot a task. Change a force. Try a different control loop. '
        'Use a simulation to explore the ideas you want to understand.',
    invitation: 'Change one thing. Watch the world respond.',
    color: Color(0xffb6e5d3),
    featured: [
      'autonomous/mujoco',
      'autonomous/drone-pilot',
      'autonomous/dimos',
    ],
  ),
  'Games': StoreDiscipline(
    name: 'Games',
    headline: 'Your world.\nYour rules.',
    description:
        'Invent a tiny game, build a place to explore, or make a new reason '
        'to say “one more try.” Play with what you make. Then change the rules.',
    invitation: 'The first version only needs to be fun enough to try.',
    color: Color(0xffcec9ff),
    featured: [
      'autonomous/godogen',
      'autonomous/phaser',
      'autonomous/game-master',
      'autonomous/voxel-worlds',
    ],
  ),
  'Research': StoreDiscipline(
    name: 'Research',
    headline: 'Let one question\nlead to another.',
    description:
        'Look for evidence, compare perspectives, and keep the disagreements '
        'that matter. Give your curiosity somewhere to go deeper.',
    invitation: 'Bring a question you have been meaning to explore.',
    color: Color(0xffbce6cf),
    featured: ['autonomous/roundtable', 'autonomous/jev-browser'],
  ),
  'Local AI': StoreDiscipline(
    name: 'Local AI',
    headline: 'Make AI\nyour own.',
    description:
        'Run a model on your machine, compare what it can do, and find '
        'a setup that fits your work. The next experiment can happen right at your desk.',
    invitation: 'Get to know what your own machines can do.',
    color: Color(0xffc8def5),
    featured: [
      'autonomous/autonomous-grid',
      'autonomous/ollama',
      'local/ollama',
      'autonomous/mlx-lm',
    ],
  ),
};

StoreDiscipline storeDiscipline(String name) =>
    storeDisciplines[name] ??
    StoreDiscipline(
      name: name,
      headline: 'A new craft\nis waiting.',
      description:
          'Explore a tool, try a small idea, and see what you can make. '
          'There is always another direction to follow.',
      invitation: 'Bring your curiosity. Start with one small project.',
      color: const Color(0xffd6e6bc),
    );

/// Bundled, unaltered outputs from store/showcase. Only shown for a matching
/// entry in this machine's catalog. The source paths are recorded with the assets.
const storeProjectAssets = <String, String>{
  'autonomous/blender': 'assets/store/projects/blender.jpg',
  'autonomous/text-to-cad': 'assets/store/projects/cad.jpg',
  'autonomous/autonomous-circuit': 'assets/store/projects/circuit.jpg',
  'autonomous/copper': 'assets/store/copper-board.png',
  'autonomous/mujoco': 'assets/store/projects/robot.jpg',
  'autonomous/godogen': 'assets/store/projects/game.jpg',
  'autonomous/phaser': 'assets/store/phaser-bricks.png',
  'autonomous/score': 'assets/store/projects/music.jpg',
  'autonomous/marimo': 'assets/store/projects/data.jpg',
  'autonomous/remotion': 'assets/store/projects/film.jpg',
  'autonomous/roundtable': 'assets/store/projects/research.jpg',
  'autonomous/marp': 'assets/store/projects/slides.jpg',
  'autonomous/circuitjs': 'assets/store/projects/circuitjs.jpg',
  'autonomous/yosys': 'assets/store/projects/yosys.jpg',
  'autonomous/orca-slicer': 'assets/store/projects/orca-slicer.jpg',
  'autonomous/autonomous-grid': 'assets/store/grid-fleet.png',
};

String? storeProjectAsset(DshEntry entry) =>
    storeProjectAssets[entry.id] ?? storeStories[entry.id]?.asset;

String? storeProjectPrompt(DshEntry entry) =>
    storeProjectExamples[entry.id]?.prompt ??
    entry.examples.firstOrNull?.prompt ??
    storeStories[entry.id]?.prompts.firstOrNull;

String? storeProjectTitle(DshEntry entry) =>
    storeProjectExamples[entry.id]?.title ??
    entry.examples.firstOrNull?.caption;

const storeRelatedDisciplines = <String, List<String>>{
  'Coding': ['Design', 'Games', 'Science & Data'],
  'Design': ['Engineering', 'Media', 'Games'],
  'Engineering': ['Design', 'Simulation', 'Coding'],
  'Media': ['Music', 'Design', 'Productivity'],
  'Music': ['Media', 'Games', 'Coding'],
  'Productivity': ['Research', 'Science & Data', 'Media'],
  'Science & Data': ['Research', 'Simulation', 'Productivity'],
  'Simulation': ['Engineering', 'Science & Data', 'Games'],
  'Games': ['Design', 'Music', 'Simulation'],
  'Research': ['Science & Data', 'Productivity', 'Coding'],
  'Local AI': ['Coding', 'Research', 'Science & Data'],
};
