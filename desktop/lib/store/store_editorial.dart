import '../core/dsh_catalog.dart';
import '../core/harness_catalog.dart';
import 'store_categories.g.dart';
import 'store_project_examples.dart';
export 'store_categories.g.dart';

String storeCategoryFor(DshEntry entry) {
  if (entry.isEngine) return 'Coding';
  // Legacy Grid/Ollama packages used Compute before Local AI existed.
  if (const {
    'autonomous/autonomous-grid',
    'autonomous/ollama',
    'autonomous/mlx-lm',
    'autonomous/vllm',
  }.contains(canonicalHarnessId(entry.id))) {
    return 'Local AI';
  }
  // Published Home Assistant packages also use the older Automation domain.
  final domain = switch (entry.category?.trim().toLowerCase()) {
    'automation' => 'home automation',
    final domain => domain,
  };
  for (final category in storeCategoryDomains.entries) {
    if (category.key.toLowerCase() == domain ||
        category.value.any((value) => value.toLowerCase() == domain)) {
      return category.key;
    }
  }
  // A community package in a new domain stays browsable without adding an
  // ever-growing list of individual domains to the sidebar.
  return 'Other';
}

/// Editorial copy is separate from registry identity and installation facts.
/// A feature only appears when its package is in the machine's live catalog.
class StoreStory {
  const StoreStory({
    required this.benefit,
    required this.prompts,
    this.headline,
    this.description,
    this.asset,
    this.caption,
  });

  final String benefit;
  final List<String> prompts;
  final String? headline;
  final String? description;
  final String? asset;
  final String? caption;
}

const _pcb = StoreStory(
  benefit: 'Turn an idea into a circuit board.',
  headline: 'That board in your head?\nMake it real.',
  description: 'Design circuits, lay out a board, and inspect it in 3D.',
  asset: 'assets/store/copper-board.png',
  caption: 'Terminal keyboard · Autonomous Circuit example board',
  prompts: [
    'Design a six-key USB macropad. Start with the schematic.',
    'Walk me through the components on this board and what they do.',
  ],
);

const storeStories = <String, StoreStory>{
  'autonomous/autonomous-grid': StoreStory(
    benefit: 'Your machines. Your models. One conversation.',
    headline: 'Meet your\npersonal AI fleet.',
    description: 'Deploy open-weight models by talking to Grid.\nWatch your machines, models, and performance live.',
    asset: 'assets/store/grid-fleet.png',
    caption: 'Grid Viewer · Illustrative telemetry',
    prompts: [
      'Discover my machines and deploy an open-weight model that fits.',
      'Find the best placement for a coding model and a fast chat model across my fleet.',
    ],
  ),
  'autonomous/blender': StoreStory(
    benefit: 'Your imagination, in three dimensions.',
    headline: 'You can\ndesign in 3D.',
    description: 'Describe a scene. Shape every detail.\nMake something you never thought you could.',
    asset: 'assets/store/blender-studio.png',
    caption: 'A scene made with Blender · Original Harness artwork',
    prompts: [
      'Create a sculptural scene with an orange arch, a chrome sphere, and soft studio lighting.',
      'Design a ceramic mug with a rounded handle. Show me a turntable view.',
    ],
  ),
  'autonomous/autonomous-circuit': _pcb,
  'autonomous/text-to-cad': StoreStory(
    benefit: 'Describe a part. Make it yours.',
    prompts: [
      'Design a phone stand with an adjustable viewing angle.',
      'Make a small enclosure for my circuit board, with mounting holes.',
    ],
  ),
  'autonomous/autonomous-workshop': StoreStory(
    benefit: 'Create parts you can hold in your hand.',
    prompts: ['Design a desk cable organizer with three channels.'],
  ),
  'autonomous/phaser': StoreStory(
    benefit: 'Make the game you want to play.',
    headline: 'Your rules.\nYour game.',
    description: 'Build a world, invent the rules, and press play.',
    asset: 'assets/store/phaser-bricks.png',
    caption: 'Bricks · The playable Phaser starter',
    prompts: [
      'Build a colorful brick-breaker game with power-ups and a high score.',
      'Make a tiny platformer where a robot collects stars.',
    ],
  ),
  'autonomous/strudel': StoreStory(
    benefit: 'Find your sound. Make it play.',
    prompts: ['Make a warm lo-fi beat with soft keys and a rolling bassline.'],
  ),
  'autonomous/mujoco': StoreStory(
    benefit: 'Give your robot a world to explore.',
    prompts: ['Build a pendulum simulation and show its energy over time.'],
  ),
  'autonomous/manim': StoreStory(
    benefit: 'Make a hard idea suddenly click.',
    prompts: [
      'Animate why the area of a circle is pi times its radius squared.',
    ],
  ),
  'autonomous/marp': StoreStory(
    benefit: 'Turn your story into a beautiful deck.',
    prompts: ['Create a five-slide pitch for a neighborhood repair café.'],
  ),
  'autonomous/remotion': StoreStory(
    benefit: 'Turn a story into a moving picture.',
    prompts: [
      'Make a 15-second product launch video with animated typography.',
    ],
  ),
  'autonomous/excalidraw': StoreStory(
    benefit: 'Give your thinking a clear picture.',
    prompts: ['Draw a simple architecture diagram for a multiplayer game.'],
  ),
  'autonomous/marimo': StoreStory(
    benefit: 'Find the story hiding in your data.',
    prompts: [
      'Explore this CSV with interactive charts and explain the patterns.',
    ],
  ),
  'autonomous/typst': StoreStory(
    benefit: 'Make documents worth reading.',
    prompts: ['Create a clean, beautifully typeset two-page project proposal.'],
  ),
  'autonomous/circuitjs': StoreStory(
    benefit: 'See how your circuit really works.',
    prompts: ['Build a 555 timer circuit and show me why the LED blinks.'],
  ),
  'autonomous/rdkit': StoreStory(
    benefit: 'Explore the world of molecules.',
    prompts: [
      'Compare the structures and properties of caffeine and theobromine.',
    ],
  ),
  'autonomous/yosys': StoreStory(
    benefit: 'Build logic. See it become a chip.',
    prompts: ['Design a four-bit counter and show its simulated waveform.'],
  ),
  'autonomous/openmontage': StoreStory(
    benefit: 'Take a film from the first idea to the final cut.',
    prompts: ['Make a short launch film for a product I am building.'],
  ),
  'autonomous/music-studio': StoreStory(
    benefit: 'Compose a piece, shape every part, and make it yours.',
    prompts: ['Compose a warm instrumental theme for a short product film.'],
  ),
  'autonomous/data-studio': StoreStory(
    benefit: 'Turn a dataset into evidence you can inspect.',
    prompts: [
      'Explore this dataset and show which patterns are worth investigating.',
    ],
  ),
  'autonomous/roundtable': StoreStory(
    benefit: 'Explore a decision from more than one point of view.',
    prompts: [
      'Compare two approaches to my project. Research the tradeoffs and preserve the disagreements.',
    ],
  ),
  'autonomous/jev-sheets': StoreStory(
    benefit: 'Ask a question of every row in your spreadsheet.',
    prompts: [
      'Group these customer reviews by theme and show the uncertain answers.',
    ],
  ),
  'autonomous/ollama': StoreStory(
    benefit: 'Find a model that fits your machine and put it to work.',
    prompts: ['Show which local models fit this machine and help me try one.'],
  ),
  'autonomous/machine-monitor': StoreStory(
    benefit: 'See every computer you own, and say what should change.',
    prompts: [
      'Show my machines and link the one that is waiting.',
      'I am setting up a new computer. Walk me through bringing it in.',
    ],
  ),
};

/// Brief captions for icon lists. Full technical descriptions stay on each
/// harness page and in package metadata; community tools retain their own copy.
const _browseBenefits = <String, String>{
  'autonomous/ableton-ai': 'Turn a small loop into a whole mood.',
  'autonomous/autoresearch-mlx': 'Train, compare, and follow the evidence.',
  'autonomous/bonsai-mcp': 'Shape a building. Explore its spaces.',
  'autonomous/comfy-mcp': 'Explore images. Keep the recipe.',
  'autonomous/creative-direction': 'Give your next idea an identity.',
  'autonomous/dimos': 'Send a rover on a new adventure.',
  'autonomous/drone-pilot': 'Plan a flight. See the bigger picture.',
  'autonomous/foam-agent': 'Change a shape. Follow the flow.',
  'autonomous/freecad': 'Make a custom part that fits your idea.',
  'autonomous/game-master': 'Invent a game. Play with the rules.',
  'autonomous/generative-art': 'Draw with code. Explore the variations.',
  'autonomous/godogen': 'Build a world you can play.',
  'autonomous/home-assistant': 'Make your home work your way.',
  'autonomous/jev-browser': 'Turn web pages into answers you can use.',
  'autonomous/juce-agent-toolkit': 'Shape a synth. Find your sound.',
  'autonomous/kicad': 'Design a board. Explore every connection.',
  'autonomous/lab-bench': 'Turn a good question into an experiment.',
  'autonomous/mlx-lm': 'Explore language models on your Mac.',
  'autonomous/openscad': 'Code a shape. Make it your own.',
  'autonomous/orca-slicer': 'Prepare your next 3D print.',
  'autonomous/score': 'Put the music in your head on the page.',
  'autonomous/simskill': 'Change the lights. Make a city flow.',
  'autonomous/vllm': 'Put your own models to work.',
  'autonomous/voxel-worlds': 'Build a place you can step inside.',
};

String storeBrowseBenefit(DshEntry entry) =>
    _browseBenefits[entry.id] ?? storeBenefit(entry);

String storeBenefit(DshEntry entry) =>
    storeStories[entry.id]?.benefit ??
    entry.description ??
    entry.category ??
    '';

bool storeMatches(DshEntry entry, String query) {
  final terms = query.trim().toLowerCase().split(RegExp(r'\s+'));
  final text = [
    entry.name,
    entry.id,
    // Old names remain searchable, but lead to the one current product page.
    for (final alias in retiredHarnessIds.entries)
      if (alias.value == canonicalHarnessId(entry.id)) alias.key,
    entry.author,
    entry.category,
    storeCategoryFor(entry),
    entry.description,
    entry.tagline,
    storeBenefit(entry),
    storeBrowseBenefit(entry),
    ...?storeStories[entry.id]?.prompts,
    storeProjectExamples[entry.id]?.prompt,
    storeProjectExamples[entry.id]?.title,
    ...entry.examples.map((example) => example.prompt),
  ].join(' ').toLowerCase();
  return terms.every(text.contains);
}

/// A named tool comes before incidental mentions in another tool's prompts.
List<DshEntry> storeSearch(Iterable<DshEntry> entries, String query) {
  final needle = query.trim().toLowerCase();
  int relevance(DshEntry entry) {
    final name = entry.name.toLowerCase();
    if (name == needle) return 0;
    if (name.startsWith(needle)) return 1;
    if (name.contains(needle)) return 2;
    return 3;
  }

  return entries.where((entry) => storeMatches(entry, query)).toList()
    ..sort((a, b) {
      final order = relevance(a).compareTo(relevance(b));
      return order != 0
          ? order
          : a.name.toLowerCase().compareTo(b.name.toLowerCase());
    });
}
