import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../widgets/desktop_chrome.dart';

/// The chat composer's rounded pill (anh Dee's mockup, 11-07, #4529): a
/// hairline and the faint fill around the text, the paperclip and the
/// options; the mic or send sits beside it. Keyed
/// `super-message-composer-surface`.
class SwarmComposerPill extends StatelessWidget {
  const SwarmComposerPill({super.key, required this.child});

  final Widget child;

  static BoxDecoration get decoration => BoxDecoration(
    color: DesktopChrome.field,
    borderRadius: BorderRadius.circular(grid.AppDesktop.composerRadius),
    border: Border.all(color: DesktopChrome.rim),
  );

  @override
  Widget build(BuildContext context) => DecoratedBox(
    key: const ValueKey('super-message-composer-surface'),
    decoration: decoration,
    child: child,
  );
}
