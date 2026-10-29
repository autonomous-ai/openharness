import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;

/// Shown at the foot of a message list while it is scrolled away from its
/// newest message (Scholes, 2026-10-29): "Jump to latest", or the count of
/// what arrived meanwhile ([count] of them, a floor when [more]). Takes
/// the reader back to the end.
class SuperTabJumpToLatest extends StatelessWidget {
  const SuperTabJumpToLatest({
    super.key,
    required this.onPressed,
    this.count = 0,
    this.more = false,
    this.noun = 'message',
    this.plural = 'messages',
  });

  final VoidCallback onPressed;
  final int count;

  /// More came than were read, so [count] is a floor.
  final bool more;
  final String noun, plural;

  /// The words on the control: the count wins over the plain jump.
  static String label(int count, bool more, String noun, String plural) =>
      count <= 0
      ? 'Jump to latest'
      : more
      ? '$count+ new $plural'
      : '$count new ${count == 1 ? noun : plural}';

  @override
  Widget build(BuildContext context) => FilledButton.icon(
    key: ValueKey(count > 0 ? 'super-new-messages' : 'super-jump-latest'),
    onPressed: onPressed,
    icon: const Icon(AppIcons.chevronDown, size: grid.AppDesktop.iconSize),
    label: Text(label(count, more, noun, plural)),
  );
}
