import 'package:flutter/widgets.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'swarm_style.dart';
import 'team_glance.dart';

/// A team in one line, as the approved prototype draws it: each count after
/// a small dot of its state ([swarmStateColor]) — working green, waiting
/// yellow, down red, its words red too — a space apart, or wider apart on
/// its own card ([spread]). Nothing counted reads "All idle" or "No agents
/// yet". Too long for its row (the drawer's), it wraps between its parts,
/// never inside one, so no part — down least of all — is cut off.
class SwarmTeamLine extends StatelessWidget {
  const SwarmTeamLine(
    this.glance, {
    super.key,
    this.size = 13.5,
    this.spread = false,
  });

  final SwarmTeamGlance glance;

  /// The words' size: 13.5 under a row's title, 13 in the drawer, 14 alone.
  final double size;

  /// Its parts wider apart: the project's team card.
  final bool spread;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final style = TextStyle(
      color: AppPalette.textSecondary,
      fontSize: size,
      height: 1.35,
    );
    final parts = glance.parts;
    if (parts.isEmpty) {
      return Text(
        glance.line,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: style,
      );
    }
    return Text.rich(
      TextSpan(
        style: style,
        children: [
          for (final (i, part) in parts.indexed) ...[
            if (i > 0) TextSpan(text: spread ? '  ' : ' '),
            // The dot is a glyph, not a widget: a line may break around a
            // widget, while no-break spaces hold the dot and its words as one.
            // A smaller face draws it about 8 points across, as the prototype.
            TextSpan(
              text: '●',
              style: TextStyle(
                color: swarmStateColor(part.state),
                fontSize: size * .8,
              ),
            ),
            TextSpan(
              text: '\u00A0${part.text.replaceAll(' ', '\u00A0')}',
              style: part.state == SwarmAgentState.down
                  ? TextStyle(color: swarmStateColor(part.state))
                  : null,
            ),
          ],
        ],
      ),
      semanticsLabel: glance.line,
    );
  }
}
