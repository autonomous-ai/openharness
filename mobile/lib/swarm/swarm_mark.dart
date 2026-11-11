import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';

import 'swarm_choices.dart';
import 'swarm_page.dart';
import 'swarm_session.dart';

/// Swarm on Home's title ([swarmHomeMark]): its mark. A tap goes back to
/// Swarm Home ([openSwarmHome]). Nothing while Swarm is off or outside the
/// shell.
class SwarmMark extends StatelessWidget {
  const SwarmMark({super.key, this.margin = EdgeInsets.zero});

  final EdgeInsets margin;

  @override
  Widget build(BuildContext context) {
    final session = SwarmScope.of(context);
    if (!swarmHomeMark || session == null) return const SizedBox.shrink();
    final tty = Tty.of(context);
    return Padding(
      padding: margin,
      child: TtyTap(
        key: const ValueKey('swarm-mark'),
        semanticsLabel: 'Swarm',
        onTap: () => openSwarmHome(context),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
          child: Icon(LucideIcons.network300, size: 18, color: tty.dim),
        ),
      ),
    );
  }
}
