import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import '../keymap_host_test.dart' show key;

/// Workspace tools remain available after the status bar replaces their icons.
Future<void> openWorkspaceTool(WidgetTester tester, String tool) async {
  final shortcut = switch (tool) {
    'machines' => LogicalKeyboardKey.keyM,
    'models' => LogicalKeyboardKey.keyI,
    'store' => LogicalKeyboardKey.keyS,
    _ => null,
  };
  if (shortcut != null) {
    await key(tester, shortcut, cmd: true);
  } else {
    await key(tester, LogicalKeyboardKey.keyP, cmd: true);
    await tester.enterText(
      find.byKey(const ValueKey('swarm-search-input')),
      '> Harnesses',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('command:harnesses.list')));
  }
  await tester.pump(const Duration(milliseconds: 350));
}
