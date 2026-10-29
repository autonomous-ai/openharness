import 'package:flutter/material.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

/// Swarm on the phone: where its screens go as they are built.
///
/// Reached only from the Swarm command in Find, which is offered only while Settings ▸
/// Experimental ▸ Swarm is on ([PhoneExperiment.swarm]). Until the first screen lands, this page
/// says so, and where the switch is.
class SwarmPage extends StatelessWidget {
  const SwarmPage({super.key});

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: TtyBackButton(
                onPressed: () => Navigator.of(context).maybePop(),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(Tty.origin, 8, Tty.origin, 0),
              child: TtyText(
                PhoneExperiment.swarm.label,
                size: TtySize.display,
                weight: FontWeight.w600,
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(Tty.origin, 16, Tty.origin, 0),
              child: Text(
                'Swarm on the phone is still being built. '
                'Turn it off in Settings ▸ Experimental.',
                key: const ValueKey('swarm-building'),
                style: tty.style(color: tty.faint, size: TtySize.row),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
