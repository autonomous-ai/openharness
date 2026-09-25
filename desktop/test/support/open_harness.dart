import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../keymap_host_test.dart' show key;
import 'resource_picker.dart';

/// Enter unscoped harness search through the real project-first shortcut.
/// Tests for the landing mode itself send Cmd-O directly instead.
Future<void> openHarnessPicker(WidgetTester tester) async {
  final linux = defaultTargetPlatform == TargetPlatform.linux;
  await key(tester, LogicalKeyboardKey.keyO, cmd: !linux, ctrl: linux);
  await tester.pump(const Duration(milliseconds: 100));
  if (resourceScope('#').evaluate().isNotEmpty &&
      resourceSearch(tester).matchQuery.isEmpty) {
    await key(tester, LogicalKeyboardKey.backspace);
  }
}
