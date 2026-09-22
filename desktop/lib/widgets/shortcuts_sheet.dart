import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../shared/widgets/app_dialog.dart';
import '../shortcuts/app_keymap.dart';
import '../shortcuts/shortcuts_browser.dart';

Future<void> showShortcutsSheet(BuildContext context) {
  final keymap = KeymapTheme.of(context, listen: false);
  return showAppDialog<void>(
    context: context,
    builder: (context) {
      final sheet = Dialog(
        insetPadding: const EdgeInsets.all(24),
        clipBehavior: Clip.antiAlias,
        child: SizedBox(
          width: 1040,
          height: math.min(800, MediaQuery.sizeOf(context).height - 48),
          child: ShortcutsBrowser(
            autofocus: true,
            onClose: () => Navigator.of(context).pop(),
          ),
        ),
      );
      return keymap == null
          ? sheet
          : KeymapProvider(keymap: keymap, child: sheet);
    },
  );
}
