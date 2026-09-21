import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

/// The phone's one floating action button: a screen's primary act, put where a
/// thumb already rests rather than in the header a thumb has to reach for.
///
/// Its own widget because two screens draw it — the Agents tab and a machine's
/// own page — and a button that looks like the app on one screen and like bare
/// Material on the other is the bug. What it DOES differs (one asks which
/// machine first, the other already knows); only the shape is shared.
///
/// ⚠️ Callers pass null rather than disabling it. Both uses gate on a machine
/// being able to host an agent at all, and a button whose only outcome is an
/// explanation of why it does nothing is worse than no button.
class PhoneFab extends StatelessWidget {
  const PhoneFab({
    super.key,
    required this.icon,
    required this.tooltip,
    required this.onPressed,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return FloatingActionButton(
      onPressed: onPressed,
      // ⚠️ No hero flight, and it is not a preference. `FloatingActionButton` defaults to ONE
      // shared tag for every instance, and this app keeps three tabs mounted at once inside an
      // IndexedStack — so the Agents tab's button and a machine page's are in the tree together,
      // and the first route transition after that throws "multiple heroes share the same tag" and
      // takes the screen down. Nothing here is flying between routes anyway.
      heroTag: null,
      // The accent is specified as a solid fill with white on it, so the
      // foreground is white in both themes rather than a token that flips.
      backgroundColor: AppPalette.accent,
      foregroundColor: Colors.white,
      // The radius every card in these lists uses, so it reads as one family
      // rather than a circle dropped on top of them.
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppCard.radius),
      ),
      tooltip: tooltip,
      child: Icon(icon, size: 26),
    );
  }
}
