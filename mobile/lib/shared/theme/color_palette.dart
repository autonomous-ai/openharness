import 'package:flutter/painting.dart';

/// Coordinated workspace colors. These feed the existing design-system tokens,
/// native tabs/search, and terminal defaults; they do not change agent state.
enum HarnessPalette {
  graphite(
    'Graphite',
    'Neutral charcoal',
    background: Color(0xff181818),
    panel: Color(0xff141414),
    card: Color(0xff1e1e1e),
    hover: Color(0xff252525),
    workspace: Color(0xff282828),
    tabBar: Color(0xff1c1c1c),
    search: Color(0xff2c2c2c),
    accent: Color(0xffbdcbdc),
  ),
  dusk(
    'Dusk',
    'Soft plum',
    background: Color(0xff181818),
    panel: Color(0xff141414),
    card: Color(0xff1e1e1e),
    hover: Color(0xff252525),
    workspace: Color(0xff463746),
    tabBar: Color(0xff332936),
    search: Color(0xff3d333f),
    accent: Color(0xffd8cce1),
  ),
  midnight(
    'Midnight',
    'Deep indigo',
    background: Color(0xff171b29),
    panel: Color(0xff141722),
    card: Color(0xff202638),
    hover: Color(0xff2a3348),
    workspace: Color(0xff252d43),
    tabBar: Color(0xff1b2030),
    search: Color(0xff262f46),
    accent: Color(0xffb1c7f5),
  ),
  slate(
    'Slate',
    'Cool blue gray',
    background: Color(0xff222a35),
    panel: Color(0xff1b222c),
    card: Color(0xff2c3543),
    hover: Color(0xff374457),
    workspace: Color(0xff354153),
    tabBar: Color(0xff273140),
    search: Color(0xff344154),
    accent: Color(0xffbdd3e7),
  ),
  forest(
    'Forest',
    'Quiet evergreen',
    background: Color(0xff18231e),
    panel: Color(0xff141c18),
    card: Color(0xff202c25),
    hover: Color(0xff2a3a31),
    workspace: Color(0xff2b3b31),
    tabBar: Color(0xff1b2720),
    search: Color(0xff293a31),
    accent: Color(0xffb4d8be),
  ),
  ember(
    'Ember',
    'Warm earth',
    background: Color(0xff26201c),
    panel: Color(0xff1e1a17),
    card: Color(0xff312923),
    hover: Color(0xff3d342c),
    workspace: Color(0xff3d322a),
    tabBar: Color(0xff2b221d),
    search: Color(0xff3c3129),
    accent: Color(0xffe6c39e),
  );

  const HarnessPalette(
    this.label,
    this.description, {
    required this.background,
    required this.panel,
    required this.card,
    required this.hover,
    required this.workspace,
    required this.tabBar,
    required this.search,
    required this.accent,
  });

  final String label, description;
  final Color background, panel, card, hover, workspace, tabBar, search, accent;
  Color get foreground => const Color(0xfff5f5f5);

  static HarnessPalette fromId(String? id) =>
      values.where((palette) => palette.name == id).firstOrNull ?? graphite;

  Map<String, int> get nativeColors => {
    'tabBar': tabBar.toARGB32(),
    'workspace': workspace.toARGB32(),
    'search': search.toARGB32(),
    'accent': accent.toARGB32(),
  };
}
