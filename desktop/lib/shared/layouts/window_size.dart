import 'package:flutter/widgets.dart';

/// The width bands the shell branches on.
///
/// One definition, in one place, so "narrow" means the same number to every
/// piece of chrome rather than each one inventing its own threshold.
///
/// These are WINDOW widths, not device classes. A desktop window dragged down
/// to 500pt is [compact] for the same reason a phone is, and is laid out the
/// same way — there is no separate mobile build to branch on, and a rule that
/// asked "is this a phone?" would leave the narrow desktop window broken.
///
/// The lower edge is Material's 600. The upper one is this app's own: the pane
/// grid's floor for a usable terminal tile is about 336pt (`_MinTile` in
/// `widgets/pane_grid.dart`, 40 columns at the default font), and [expanded]
/// is meant to mean "two of those side by side, with the chrome around them" —
/// which 840 does not buy and 1024 does.
enum WindowSizeClass {
  /// One thing at a time. Chrome that cannot earn its width collapses.
  compact,

  /// Everything is present, with less room around it.
  medium,

  /// The size the app is drawn for.
  expanded;

  /// First width that is no longer [compact].
  static const double compactMax = 600;

  /// First width that is [expanded].
  static const double mediumMax = 1024;

  static WindowSizeClass fromWidth(double width) => switch (width) {
    < compactMax => WindowSizeClass.compact,
    < mediumMax => WindowSizeClass.medium,
    _ => WindowSizeClass.expanded,
  };

  /// The class of the WINDOW.
  ///
  /// Prefer [fromWidth] with a `LayoutBuilder`'s own constraint for anything
  /// laid out narrower than the window: a strip inside a split should answer
  /// for the box it was given, not for the screen it happens to sit on.
  static WindowSizeClass of(BuildContext context) =>
      fromWidth(MediaQuery.sizeOf(context).width);

  bool get isCompact => this == WindowSizeClass.compact;
}
