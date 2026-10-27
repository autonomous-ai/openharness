import 'package:flutter/widgets.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'team_glance.dart';

/// A team in one line, as the approved prototype draws it: each count after
/// a dot of its state — working green, waiting yellow, down red, its words
/// red too. Nothing counted reads "All idle" or "No agents yet". Too long for
/// its row (the drawer's), it wraps between its parts, never inside one, so
/// no part — down least of all — is cut off.
class SwarmTeamLine extends StatelessWidget {
  const SwarmTeamLine(this.glance, {super.key});

  final SwarmTeamGlance glance;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final style = TextStyle(
      color: AppPalette.textSecondary,
      fontSize: 12.5,
      height: 1.4,
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
    Color dot(SwarmAgentState state) => switch (state) {
      SwarmAgentState.working => tty.green,
      SwarmAgentState.waiting || SwarmAgentState.stuck => tty.yellow,
      SwarmAgentState.down => tty.red,
      SwarmAgentState.limited || SwarmAgentState.idle => tty.dim,
    };
    return Text.rich(
      TextSpan(
        style: style,
        children: [
          for (final (i, part) in parts.indexed) ...[
            if (i > 0) const TextSpan(text: '   '),
            // The dot is a glyph, not a widget: a line may break around a
            // widget, while no-break spaces hold the dot and its words as one.
            TextSpan(
              text: '●\u00A0',
              style: TextStyle(color: dot(part.state)),
            ),
            TextSpan(
              text: part.text.replaceAll(' ', '\u00A0'),
              style: part.state == SwarmAgentState.down
                  ? TextStyle(color: tty.red)
                  : null,
            ),
          ],
        ],
      ),
      semanticsLabel: glance.line,
    );
  }
}
