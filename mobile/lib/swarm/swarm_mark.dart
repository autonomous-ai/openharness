import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';

import 'swarm_choices.dart';
import 'swarm_page.dart';
import 'swarm_session.dart';

/// Swarm on Home's title ([swarmHomeMark]): its mark, and how many things the
/// Swarms ask of the person, in the terminal's yellow while any do. A tap
/// goes back to Swarm Home ([openSwarmHome]). Nothing while Swarm is off or
/// outside the shell.
class SwarmMark extends StatelessWidget {
  const SwarmMark({super.key, this.margin = EdgeInsets.zero});

  final EdgeInsets margin;

  @override
  Widget build(BuildContext context) {
    final session = SwarmScope.of(context);
    if (!swarmHomeMark || session == null) return const SizedBox.shrink();
    return ListenableBuilder(
      listenable: session.inbox,
      builder: (context, _) {
        final tty = Tty.of(context);
        final count = session.inbox.needs.length;
        final color = count > 0 ? tty.yellow : tty.dim;
        return Padding(
          padding: margin,
          child: TtyTap(
            key: const ValueKey('swarm-mark'),
            semanticsLabel: count == 0
                ? 'Swarm'
                : 'Swarm, $count ${count == 1 ? 'needs' : 'need'} you',
            onTap: () => openSwarmHome(context),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(LucideIcons.network300, size: 18, color: color),
                  if (count > 0) ...[
                    const SizedBox(width: 4),
                    TtyText(
                      '$count',
                      key: const ValueKey('swarm-mark-count'),
                      color: color,
                      weight: FontWeight.w600,
                      size: TtySize.meta,
                    ),
                  ],
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}
