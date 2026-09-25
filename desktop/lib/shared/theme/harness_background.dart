/// Built-in backgrounds for empty Harness pages. Wallpaper never covers agents.
enum HarnessBackground {
  plain('Blank'),
  renaissance('Renaissance notebook', 'renaissance-notebook.jpg'),
  connections('Atlas of connections', 'atlas-of-connections.jpg'),
  terminalWorkshop('Terminal workshop', 'terminal-workshop.jpg'),
  terminalStars('Terminal star atlas', 'terminal-star-atlas.jpg'),
  aurora('Aurora'),
  lake('Lake', 'swarm-welcome-dusk.jpg'),
  silk('Silk', 'swarm-welcome-abstract.jpg'),
  threads('Threads', 'swarm-welcome-associative-memory.jpg'),
  constellation('Constellation', 'swarm-welcome-ai.jpg');

  const HarnessBackground(this.label, [this.fileName]);
  final String label;
  final String? fileName;
  String? get asset =>
      fileName == null ? null : 'assets/swarm-wallpapers/$fileName';

  /// Curated wallpapers leave the welcome text's center clear. Older choices
  /// remain readable so existing preferences still restore without migration.
  static const gallery = [
    plain,
    renaissance,
    connections,
    terminalWorkshop,
    terminalStars,
  ];

  static HarnessBackground fromId(String? id) =>
      values.where((value) => value.name == id).firstOrNull ?? plain;
}
