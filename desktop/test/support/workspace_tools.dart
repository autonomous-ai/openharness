import 'package:flutter/material.dart';
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

/// Detailed management is reached by name from the shared search surface.
Future<void> openWorkspaceManagement(WidgetTester tester, String tool) async {
  final command = switch (tool) {
    'machines' => 'Machine connection settings',
    'models' => 'Manage models',
    _ => 'Manage harnesses',
  };
  await key(tester, LogicalKeyboardKey.keyP, cmd: true);
  final field = find.byKey(const ValueKey('swarm-search-input'));
  await tester.enterText(field, '> $command');
  await tester.pump();
  await key(tester, LogicalKeyboardKey.enter);
  await tester.pump(const Duration(milliseconds: 350));
}
