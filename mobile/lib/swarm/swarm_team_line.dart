import 'package:flutter/widgets.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'team_glance.dart';

/// A team in one line, as the approved prototype draws it: each count after
/// a dot of its state — working green, waiting yellow, down red, its words
/// red too. Nothing counted reads "All idle" or "No agents yet".
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
            WidgetSpan(
              alignment: PlaceholderAlignment.middle,
              child: Padding(
                padding: const EdgeInsets.only(right: 5),
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: dot(part.state),
                    shape: BoxShape.circle,
                  ),
                  child: const SizedBox.square(dimension: 7),
                ),
              ),
            ),
            TextSpan(
              text: part.text,
              style: part.state == SwarmAgentState.down
                  ? TextStyle(color: tty.red)
                  : null,
            ),
          ],
        ],
      ),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      semanticsLabel: glance.line,
    );
  }
}
