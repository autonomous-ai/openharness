import 'dart:ui' show Brightness;

import 'package:flutter/painting.dart';

/// Coordinated workspace colors. These feed the existing design-system tokens,
/// native tabs/search, and terminal defaults; they do not change agent state.
///
/// A palette carries its own [brightness]: choosing a light one is how the app
/// goes light. There is no separate light/dark switch to disagree with it —
/// `_GridTokenScope` (app_shell.dart) and the native window read it from here.
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
  ),
  // The light palettes mirror the dark ones' layering: the workspace gutter and
  // tab bar sit a step darker than the terminal ground, cards a step lighter.
  // Their accents are deep rather than pale, since an accent is drawn as text,
  // a cursor and a focus ring on the ground.
  paper(
    'Paper',
    'Neutral light',
    brightness: Brightness.light,
    foreground: Color(0xff1f1f1d),
    background: Color(0xfffafaf9),
    panel: Color(0xfff3f3f1),
    card: Color(0xffffffff),
    hover: Color(0xffebebe8),
    workspace: Color(0xffe6e6e3),
    tabBar: Color(0xffeeeeec),
    search: Color(0xffe2e2df),
    accent: Color(0xff3d5a8a),
  ),
  mist(
    'Mist',
    'Cool light',
    brightness: Brightness.light,
    foreground: Color(0xff1b2330),
    background: Color(0xfff7f9fc),
    panel: Color(0xffeef2f7),
    card: Color(0xffffffff),
    hover: Color(0xffe3e9f1),
    workspace: Color(0xffe1e7f0),
    tabBar: Color(0xffe9eef5),
    search: Color(0xffdce4ee),
    accent: Color(0xff2f5bb8),
  ),
  // Task #3006 (Dee, 11-05): four neutral themes modeled on the two most used
  // team chat apps, untinted so the text carries the page. Each brings its own
  // three grays (text, muted for times and names, faint for hints) and one
  // accent for links, the unread dot and buttons; red stays for counts.
  plum(
    'Plum',
    'White with a plum sidebar',
    brightness: Brightness.light,
    foreground: Color(0xff1d1c1d),
    text: Color(0xff1d1c1d),
    muted: Color(0xff616061),
    faint: Color(0xff686768),
    background: Color(0xffffffff),
    panel: Color(0xfff8f8f8),
    card: Color(0xfff8f8f8),
    hover: Color(0xffefefef),
    workspace: Color(0xfff8f8f8),
    tabBar: Color(0xfff4f4f4),
    search: Color(0xffededed),
    accent: Color(0xff1264a3),
    // The one dark surface in a light theme: the Swarm sidebar, with white
    // ink and a blue selected row.
    sidebar: Color(0xff3f0e40),
    sidebarInk: Color(0xffffffff),
    sidebarMuted: Color(0xffcfc3cf),
    sidebarHover: Color(0xff350d36),
    sidebarSelected: Color(0xff1164a3),
    sidebarOnSelected: Color(0xffffffff),
  ),
  night(
    'Night',
    'Near-black, untinted',
    foreground: Color(0xffd1d2d3),
    text: Color(0xffd1d2d3),
    muted: Color(0xffababad),
    faint: Color(0xff9a9b9e),
    background: Color(0xff1a1d21),
    panel: Color(0xff19171d),
    card: Color(0xff222529),
    hover: Color(0xff27292d),
    workspace: Color(0xff19171d),
    tabBar: Color(0xff121016),
    search: Color(0xff222529),
    accent: Color(0xff1d9bd1),
  ),
  cloud(
    'Cloud',
    'White with gray sidebars',
    brightness: Brightness.light,
    foreground: Color(0xff313338),
    text: Color(0xff313338),
    muted: Color(0xff4e5058),
    faint: Color(0xff5c5e66),
    background: Color(0xffffffff),
    panel: Color(0xfff2f3f5),
    card: Color(0xffebedef),
    hover: Color(0xffe3e5e8),
    workspace: Color(0xfff2f3f5),
    tabBar: Color(0xffe3e5e8),
    search: Color(0xffffffff),
    accent: Color(0xff4752c4),
  ),
  storm(
    'Storm',
    'Soft gray with a darker rail',
    foreground: Color(0xffdbdee1),
    text: Color(0xffdbdee1),
    muted: Color(0xffb5bac1),
    faint: Color(0xffa3a9b1),
    background: Color(0xff313338),
    panel: Color(0xff2b2d31),
    card: Color(0xff383a40),
    hover: Color(0xff35373c),
    workspace: Color(0xff2b2d31),
    tabBar: Color(0xff1e1f22),
    search: Color(0xff2b2d31),
    accent: Color(0xff949cf7),
    // The shared dark red (#FF7068) is 4.2:1 on Storm's lighter field.
    errorInk: Color(0xffff8f8a),
  );

  const HarnessPalette(
    this.label,
    this.description, {
    this.brightness = Brightness.dark,
    this.foreground = const Color(0xfff5f5f5),
    required this.background,
    required this.panel,
    required this.card,
    required this.hover,
    required this.workspace,
    required this.tabBar,
    required this.search,
    required this.accent,
    this.text,
    this.muted,
    this.faint,
    this.errorInk,
    Color? sidebar,
    this.sidebarInk,
    this.sidebarMuted,
    Color? sidebarHover,
    Color? sidebarSelected,
    Color? sidebarOnSelected,
  }) : _sidebar = sidebar,
       _sidebarHover = sidebarHover,
       _sidebarSelected = sidebarSelected,
       _sidebarOnSelected = sidebarOnSelected;

  final String label, description;
  final Brightness brightness;
  final Color foreground;
  final Color background, panel, card, hover, workspace, tabBar, search, accent;

  /// The palette's own text, muted and faint inks. Null keeps the app's
  /// shared ramp for this brightness (`AppPalette.textPrimary` and the rest),
  /// which is what every palette before these four uses.
  final Color? text, muted, faint;

  /// Error ink, where the shared one for this brightness is too dim on the
  /// palette's grounds.
  final Color? errorInk;

  final Color? _sidebar, _sidebarHover, _sidebarSelected, _sidebarOnSelected;

  /// The Swarm sidebar's ground: the workspace color unless the palette gives
  /// the sidebar one of its own.
  Color get sidebar => _sidebar ?? workspace;

  /// Ink for a sidebar that is darker than the theme around it (Plum). Null
  /// means the sidebar uses the page's ink.
  final Color? sidebarInk, sidebarMuted;

  /// Whether the Swarm sidebar wears its own ink rather than the page's.
  bool get hasSidebarInk => sidebarInk != null;

  Color get sidebarHover => _sidebarHover ?? hover;
  Color get sidebarSelected => _sidebarSelected ?? hover;
  Color get sidebarOnSelected =>
      _sidebarOnSelected ?? sidebarInk ?? text ?? foreground;
  bool get isDark => brightness == Brightness.dark;

  static HarnessPalette fromId(String? id) =>
      values.where((palette) => palette.name == id).firstOrNull ?? graphite;

  Map<String, int> get nativeColors => {
    'tabBar': tabBar.toARGB32(),
    'workspace': workspace.toARGB32(),
    'search': search.toARGB32(),
    'accent': accent.toARGB32(),
    'foreground': foreground.toARGB32(),
    // AppKit's own surfaces (menus, the About panel, traffic lights) follow
    // `NSApp.appearance`, which the window sets from this.
    'dark': isDark ? 1 : 0,
  };
}
