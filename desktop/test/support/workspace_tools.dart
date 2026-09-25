import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../keymap_host_test.dart' show key;

/// Workspace tools remain available after the status bar replaces their icons.
Future<void> openWorkspaceTool(WidgetTester tester, String tool) async {
  final shortcut = switch (tool) {
    'machines' => LogicalKeyboardKey.keyM,
    'models' => LogicalKeyboardKey.keyI,
    'store' => LogicalKeyboardKey.keyS,
    _ => LogicalKeyboardKey.keyP,
  };
  await key(tester, shortcut, cmd: true);
  await tester.pump(const Duration(milliseconds: 350));
}
