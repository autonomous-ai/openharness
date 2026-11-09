import 'package:flutter/painting.dart';

/// The Swarm v4 panes' spacing, corners and title size (desktop-design-system.md, Swarm v4): the numbers the theme owns,
/// so the Swarm's own files name them instead of repeating them (scripts/check-ui-style.py).
abstract final class SwarmLayout {
  /// A side pane's bar and content inset from its edges: Tasks, an agent's instructions, an agent's chat bar.
  static const double barSide = 20;

  /// An agent's chat bar: its name, machine and engine, and its two buttons.
  static const EdgeInsets barPadding = EdgeInsets.symmetric(
    horizontal: barSide,
    vertical: 6,
  );

  /// The corners of a task card and of the agents-only line.
  static const double cardRadius = 12;

  /// Inside a task card.
  static const EdgeInsets cardPadding = EdgeInsets.fromLTRB(14, 12, 14, 12);

  /// The grey capsule of a task's number: its inside, its corners and the gap below it.
  static const EdgeInsets capsulePadding = EdgeInsets.symmetric(
    horizontal: 8,
    vertical: 2,
  );
  static const double capsuleRadius = 8;
  static const double capsuleGap = 6;

  /// A board column's heading, which sits level with its cards' left edge.
  static const EdgeInsets columnHeadPadding = EdgeInsets.fromLTRB(4, 16, 4, 8);

  /// A label chip as github.com draws it: a pill in the label's own colour.
  static const EdgeInsets chipPadding = EdgeInsets.symmetric(
    horizontal: 8,
    vertical: 1,
  );
  static const double chipRadius = 999;

  /// A task's title, above its text and comments.
  static const double titleSize = 16;

  /// A card in a chat that is nobody's bubble, as GitHub's words to an agent (super_tabs/github_row.dart): the gap above it,
  /// and the gap under its file line.
  static const double chatCardTop = 12;
  static const double chatCardLineGap = 6;

  /// The gap above the quiet line under a post's bubble (super_tabs/channel_talk.dart): "Juno is offline".
  static const double postNoteTop = 6;

  /// The gap between the name and "to Juno" in a post's name line, which reads as one phrase.
  static const double namePhraseGap = 4;

  /// The agents-only line under a project's channel, where a composer would be.
  static const EdgeInsets agentsOnlyMargin = EdgeInsets.fromLTRB(28, 6, 28, 18);

  /// An agent's name in its chat bar, which its person clicks to rename it, and the same name when it cannot be.
  static const EdgeInsets namePadding = EdgeInsets.symmetric(
    horizontal: 4,
    vertical: 2,
  );
  static const EdgeInsets nameInset = EdgeInsets.symmetric(horizontal: 4);
}
