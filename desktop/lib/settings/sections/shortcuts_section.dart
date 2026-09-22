import 'package:flutter/material.dart';

import '../../shortcuts/shortcuts_browser.dart';

/// The same searchable shortcut reference as the workspace's shortcut dialog.
class ShortcutsSection extends StatelessWidget {
  const ShortcutsSection({super.key});

  @override
  Widget build(BuildContext context) => FocusTraversalGroup(
    policy: WidgetOrderTraversalPolicy(),
    child: const ShortcutsBrowser(),
  );
}
